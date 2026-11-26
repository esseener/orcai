use crate::acceptance;
use crate::agents::omp;
use crate::connectors::{self, CustomTarget, SERVER_NAME};
use crate::route;
use crate::state;
use serde_json::{json, Map, Value};
use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const PROTOCOL_VERSION: &str = "2024-11-05";

fn write_message(out: &mut impl Write, msg: &Value) -> io::Result<()> {
    let line = serde_json::to_string(msg).unwrap_or_else(|_| "{}".into());
    out.write_all(line.as_bytes())?;
    out.write_all(b"\n")?;
    out.flush()
}

fn read_message<R: BufRead>(reader: &mut R) -> io::Result<Option<Value>> {
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(None);
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.to_ascii_lowercase().starts_with("content-length:") {
            let len: usize = trimmed["content-length:".len()..]
                .trim()
                .parse()
                .unwrap_or(0);
            loop {
                let mut header = String::new();
                if reader.read_line(&mut header)? == 0 {
                    return Ok(None);
                }
                if header.trim().is_empty() {
                    break;
                }
            }
            if len == 0 {
                continue;
            }
            let mut buf = vec![0u8; len];
            reader.read_exact(&mut buf)?;
            let value = serde_json::from_slice::<Value>(&buf)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            return Ok(Some(value));
        }
        let value = serde_json::from_str::<Value>(trimmed)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        return Ok(Some(value));
    }
}

fn tools_schema() -> Value {
    json!([
        {
            "name": "fusion_status",
            "description": "Unified fusion state: OMP executable/version/config path, every model role with its model and thinking level, routing flags, the cached model catalog, and MCP connector status.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "fusion_models",
            "description": "List OMP models with their selectors and supported thinking levels. Use force=true to refresh the catalog from the OMP CLI.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "force": { "type": "boolean", "description": "Re-run `omp models ls` instead of using the cache." }
                }
            }
        },
        {
            "name": "fusion_roles_set",
            "description": "Set one model role in OMP (plan, default, advisor, smol, slow, review, or a custom role). An empty model clears the role. Thinking is stored as the `:<level>` selector suffix.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "role": { "type": "string", "description": "Role key, e.g. plan / default / advisor." },
                    "model": { "type": "string", "description": "Exact model selector, e.g. magpie/work/global:deepseek-v4.1-flash-sg. Empty clears." },
                    "thinking": { "type": ["string", "null"], "description": "off|minimal|low|medium|high|xhigh|max|auto, or null to inherit defaultThinkingLevel." }
                },
                "required": ["role", "model"]
            }
        },
        {
            "name": "fusion_save",
            "description": "Batch save roles, routing flags, and the default thinking level in one call. Shape matches the console payload.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "roles": { "type": "object", "description": "Map role -> {model, thinking}." },
                    "flags": {
                        "type": "object",
                        "properties": {
                            "planEnabled": { "type": "boolean" },
                            "advisorEnabled": { "type": "boolean" },
                            "taskPrewalk": { "type": "boolean" }
                        }
                    },
                    "defaultThinkingLevel": { "type": "string" }
                }
            }
        },
        {
            "name": "fusion_resolve",
            "description": "Resolve which selector a fusion mode should use (plan/execute/review/smol/slow), projected from OMP modelRoles. Other agents will consume this once their adapters land.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "mode": { "type": "string", "enum": ["plan", "execute", "review", "smol", "slow"] }
                },
                "required": ["mode"]
            }
        },
        {
            "name": "fusion_route",
            "description": "Per-message hybrid router. Feed the user message; returns plan or execute with the role selector and thinking level. Events: refresh the role cache, plan-written handoff, rework keeps the executor, reset a session.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "message": { "type": "string", "description": "The user's message for this turn." },
                    "sessionId": { "type": "string", "description": "Stable session key; defaults to 'default'." },
                    "cwd": { "type": "string", "description": "Workspace root used to detect a non-empty PLAN.md." },
                    "event": { "type": "string", "enum": ["refresh", "plan-written", "rework", "reset"] }
                }
            }
        },
        {
            "name": "fusion_install_omp",
            "description": "Install and register the OMP extension that routes every message, enforces the plan gate, and hands off to the executor when PLAN.md is written.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "fusion_accept",
            "description": "Run one manual acceptance pass: collect the git diff and PLAN.md, call the review role model, and return PASS/REWORK with findings.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "cwd": { "type": "string", "description": "Workspace directory to review." }
                },
                "required": ["cwd"]
            }
        },
        {
            "name": "fusion_connect",
            "description": "Inspect or change where this fusion MCP server is registered. Targets: omp, opencode, claude-desktop, cursor, windsurf, antigravity, gemini-cli, or a custom JSON mcpServers config path.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["status", "connect", "disconnect"], "default": "status" },
                    "target": { "type": "string", "description": "Built-in target id." },
                    "customPath": { "type": "string", "description": "Absolute path to a JSON file containing mcpServers." },
                    "label": { "type": "string", "description": "Display label for a custom target." }
                }
            }
        },
        {
            "name": "fusion_open_console",
            "description": "Launch the Orzic for fusion desktop console window.",
            "inputSchema": { "type": "object", "properties": {} }
        }
    ])
}

fn connect_custom(
    custom_path: &str,
    label: Option<&str>,
    action: &str,
) -> Result<Value, String> {
    let path = PathBuf::from(custom_path);
    let enable = action == "connect";
    connectors::connect_to_path(&path, SERVER_NAME, &connectors::current_exe_string(), enable)?;
    if enable {
        let label = label
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .unwrap_or(custom_path);
        let slug: String = label
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_lowercase();
        connectors::save_custom_target(CustomTarget {
            id: if slug.is_empty() {
                format!("custom-{}", custom_path.len())
            } else {
                format!("custom-{slug}")
            },
            label: label.to_string(),
            config_path: custom_path.to_string(),
            server_name: SERVER_NAME.to_string(),
        })?;
    }
    Ok(connectors::list_all())
}

fn call_tool(name: &str, args: &Map<String, Value>) -> Result<Value, String> {
    match name {
        "fusion_status" => Ok(state::build(false)),
        "fusion_models" => {
            let force = args.get("force").and_then(Value::as_bool).unwrap_or(false);
            let models = omp::list_models(force)?;
            Ok(json!({ "count": models.len(), "models": models }))
        }
        "fusion_roles_set" => {
            let role = args
                .get("role")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|r| !r.is_empty())
                .ok_or("缺少 role")?;
            let model = args.get("model").and_then(Value::as_str).unwrap_or("");
            let thinking = args.get("thinking").and_then(Value::as_str);
            let patch = json!({
                "roles": { role: { "model": model, "thinking": thinking } }
            });
            let patch = patch.as_object().cloned().unwrap_or_default();
            omp::save(&patch)?;
            Ok(state::build(false))
        }
        "fusion_save" => {
            omp::save(args)?;
            Ok(state::build(false))
        }
        "fusion_resolve" => {
            let mode = args.get("mode").and_then(Value::as_str).unwrap_or("");
            Ok(omp::resolve_mode(mode))
        }
        "fusion_route" => {
            let message = args.get("message").and_then(Value::as_str).unwrap_or("");
            let session = args
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or("default");
            let cwd = args.get("cwd").and_then(Value::as_str).unwrap_or("");
            let event = args.get("event").and_then(Value::as_str);
            route::route(message, session, cwd, event)
        }
        "fusion_install_omp" => route::install_extension(),
        "fusion_accept" => {
            let cwd = args.get("cwd").and_then(Value::as_str).unwrap_or("");
            acceptance::run(cwd)
        }
        "fusion_connect" => {
            let action = args
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("status");
            match action {
                "status" => Ok(connectors::list_all()),
                "connect" | "disconnect" => {
                    if let Some(custom_path) = args
                        .get("customPath")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|p| !p.is_empty())
                    {
                        let label = args.get("label").and_then(Value::as_str);
                        connect_custom(custom_path, label, action)
                    } else if let Some(target) = args.get("target").and_then(Value::as_str) {
                        connectors::connect_target_by_id(target, action == "connect")
                    } else {
                        Err("请提供 target 或 customPath".into())
                    }
                }
                other => Err(format!("不支持的 action：{other}")),
            }
        }
        "fusion_open_console" => {
            let exe = connectors::current_exe_string();
            let mut cmd = Command::new(&exe);
            cmd.arg("--ui")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(windows)]
            {
                const DETACHED_PROCESS: u32 = 0x0000_0008;
                const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
                cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
            }
            cmd.spawn()
                .map_err(|e| format!("无法启动控制台 ({exe}): {e}"))?;
            Ok(json!({ "ok": true, "launched": exe }))
        }
        _ => Err(format!("未知工具：{name}")),
    }
}

pub fn handle_rpc_request(req: &Value) -> Option<Value> {
    let id = req.get("id").cloned()?;
    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
    let params = req.get("params").and_then(Value::as_object);

    let result: Result<Value, (i64, String)> = match method {
        "initialize" => {
            let client_proto = params
                .and_then(|p| p.get("protocolVersion"))
                .and_then(Value::as_str)
                .unwrap_or(PROTOCOL_VERSION);
            Ok(json!({
                "protocolVersion": client_proto,
                "capabilities": {
                    "tools": { "listChanged": false },
                    "resources": { "subscribe": false, "listChanged": false }
                },
                "serverInfo": {
                    "name": "orzic-fusion",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools_schema() })),
        "tools/call" => {
            let name = params
                .and_then(|p| p.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let args = params
                .and_then(|p| p.get("arguments"))
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            match call_tool(name, &args) {
                Ok(data) => Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": serde_json::to_string_pretty(&data).unwrap_or_else(|_| "{}".into())
                    }],
                    "isError": false
                })),
                Err(err) => Ok(json!({
                    "content": [{ "type": "text", "text": err }],
                    "isError": true
                })),
            }
        }
        "resources/list" => Ok(json!({
            "resources": [
                {
                    "uri": "fusion://status",
                    "name": "Orzic Fusion Status",
                    "description": "Roles, models, flags and MCP connector status.",
                    "mimeType": "application/json"
                },
                {
                    "uri": "fusion://models",
                    "name": "OMP Model Catalog",
                    "description": "Cached OMP models with thinking levels.",
                    "mimeType": "application/json"
                }
            ]
        })),
        "resources/read" => {
            let uri = params
                .and_then(|p| p.get("uri"))
                .and_then(Value::as_str)
                .unwrap_or("");
            match uri {
                "fusion://status" => {
                    let data = state::build(false);
                    Ok(json!({
                        "contents": [{
                            "uri": uri,
                            "mimeType": "application/json",
                            "text": serde_json::to_string_pretty(&data).unwrap_or_default()
                        }]
                    }))
                }
                "fusion://models" => {
                    let models = omp::list_models(false).unwrap_or_default();
                    Ok(json!({
                        "contents": [{
                            "uri": uri,
                            "mimeType": "application/json",
                            "text": serde_json::to_string_pretty(&models).unwrap_or_default()
                        }]
                    }))
                }
                _ => Err((-32602, format!("未知资源 URI：{uri}"))),
            }
        }
        "prompts/list" => Ok(json!({ "prompts": [] })),
        _ => Err((-32601, format!("Method not found: {method}"))),
    };

    Some(match result {
        Ok(value) => json!({ "jsonrpc": "2.0", "id": id, "result": value }),
        Err((code, message)) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message }
        }),
    })
}

pub fn run_stdio_server() -> io::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = stdout.lock();
    while let Some(req) = read_message(&mut reader)? {
        if let Some(resp) = handle_rpc_request(&req) {
            write_message(&mut writer, &resp)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_and_tools_list() {
        let init = handle_rpc_request(&json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2024-11-05" }
        }))
        .unwrap();
        assert_eq!(init["result"]["serverInfo"]["name"], "orzic-fusion");

        let list = handle_rpc_request(&json!({
            "jsonrpc": "2.0", "id": 2, "method": "tools/list"
        }))
        .unwrap();
        let tools = list["result"]["tools"].as_array().unwrap();
        for expected in [
            "fusion_status",
            "fusion_models",
            "fusion_roles_set",
            "fusion_save",
            "fusion_resolve",
            "fusion_route",
            "fusion_install_omp",
            "fusion_accept",
            "fusion_connect",
            "fusion_open_console",
        ] {
            assert!(tools.iter().any(|t| t["name"] == expected), "missing {expected}");
        }
    }

    #[test]
    fn unknown_method_is_an_error() {
        let resp = handle_rpc_request(&json!({
            "jsonrpc": "2.0", "id": 3, "method": "nope"
        }))
        .unwrap();
        assert_eq!(resp["error"]["code"], -32601);
    }
}
