use crate::acceptance;
use crate::config::{
    appdata_dir, codex_config_path, codex_models_cache_file, codex_state_file, read_json,
    write_text_atomic,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const RPC_TIMEOUT: Duration = Duration::from_secs(30);
const TURN_TIMEOUT: Duration = Duration::from_secs(300);
const MODELS_TTL_MS: u64 = 5 * 60 * 1000;

static STATE_LOCK: Mutex<()> = Mutex::new(());

pub const ROLE_DEFS: &[(&str, &str, &str)] = &[
    ("plan", "规划 Plan", "只读规划；使用 Codex 只读沙箱"),
    ("execute", "执行 Execute", "按已确认计划执行；只写目标工作区"),
    ("review", "验收 Review", "独立只读评审；禁用 MCP、插件与联网搜索"),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CxModel {
    pub selector: String,
    pub name: String,
    pub provider: String,
    #[serde(default)]
    pub efforts: Vec<String>,
    #[serde(default)]
    pub default_effort: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CxRole {
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CxSession {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub task: String,
    #[serde(default)]
    pub phase: String,
    #[serde(default)]
    pub plan: String,
    #[serde(default)]
    pub plan_model: String,
    #[serde(default)]
    pub plan_effort: String,
    #[serde(default)]
    pub plan_actual_model: String,
    #[serde(default)]
    pub plan_actual_effort: String,
    #[serde(default)]
    pub plan_rerouted: String,
    #[serde(default)]
    pub plan_fingerprint: String,
    #[serde(default)]
    pub execution: String,
    #[serde(default)]
    pub execution_model: String,
    #[serde(default)]
    pub execution_effort: String,
    #[serde(default)]
    pub execution_actual_model: String,
    #[serde(default)]
    pub execution_actual_effort: String,
    #[serde(default)]
    pub execution_rerouted: String,
    #[serde(default)]
    pub execution_tokens: Value,
    #[serde(default)]
    pub execution_duration_ms: u64,
    #[serde(default)]
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CxState {
    #[serde(default)]
    roles: BTreeMap<String, CxRole>,
    #[serde(default)]
    sessions: BTreeMap<String, CxSession>,
    #[serde(default)]
    reviews: BTreeMap<String, Value>,
}

#[derive(Debug, Clone)]
struct TurnOutcome {
    text: String,
    actual_model: String,
    actual_effort: String,
    rerouted: String,
    duration_ms: u64,
    tokens: Value,
}

#[derive(Debug, Clone)]
struct ExecOutcome {
    thread_id: String,
    text: String,
    actual_model: String,
    actual_effort: String,
    duration_ms: u64,
    tokens: Value,
}

pub fn find_executable() -> String {
    if let Ok(path) = env::var("ORZIC_CODEX_BIN") {
        if !path.trim().is_empty() {
            return path;
        }
    }
    let names: &[&str] = if cfg!(windows) {
        &["codex.exe", "codex.cmd", "codex.bat", "codex"]
    } else {
        &["codex"]
    };
    if let Some(paths) = env::var_os("PATH") {
        for dir in env::split_paths(&paths) {
            for name in names {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return candidate.to_string_lossy().to_string();
                }
            }
        }
    }
    let fallback = appdata_dir().join("npm").join(if cfg!(windows) {
        "codex.cmd"
    } else {
        "codex"
    });
    if fallback.is_file() {
        return fallback.to_string_lossy().to_string();
    }
    if cfg!(windows) {
        "codex.cmd".to_string()
    } else {
        "codex".to_string()
    }
}

fn is_batch(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat")
}

fn quote_cmd(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\\\""))
}

fn cli_command(args: &[&str], envs: &[(&str, String)]) -> Command {
    let exe = find_executable();
    let mut command = if cfg!(windows) && is_batch(&exe) {
        let mut line = quote_cmd(&exe);
        for arg in args {
            line.push(' ');
            line.push_str(&quote_cmd(arg));
        }
        let mut command = Command::new("cmd.exe");
        command.args(["/d", "/s", "/c"]);
        command.raw_arg(&format!("\"{line}\""));
        command
    } else {
        let mut command = Command::new(&exe);
        command.args(args);
        command
    };
    for (key, value) in envs {
        command.env(key, value);
    }
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Runs a Codex CLI command. `CODEX_HOME` is supplied explicitly by the
/// connector so it can inspect an isolated configuration without touching the
/// user's default profile.
pub fn run_cli(args: &[&str], cwd: Option<&Path>, envs: &[(&str, String)]) -> Result<String, String> {
    let exe = find_executable();
    let mut command = cli_command(args, envs);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let out = command
        .output()
        .map_err(|e| format!("无法运行 Codex ({exe}): {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "Codex {} 执行失败 (code {:#?}): {}",
            args.join(" "),
            out.status.code(),
            truncate(stderr.trim(), 800)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn app_server_command(isolated: bool) -> Command {
    let exe = find_executable();
    let mut args = vec!["app-server".to_string(), "--stdio".to_string()];
    if isolated {
        args.extend([
            "-c".to_string(),
            "mcp_servers={}".to_string(),
            "-c".to_string(),
            "plugins={}".to_string(),
            "-c".to_string(),
            "web_search=disabled".to_string(),
        ]);
    }
    let mut command = if cfg!(windows) && is_batch(&exe) {
        let mut line = quote_cmd(&exe);
        for arg in &args {
            line.push(' ');
            line.push_str(&quote_cmd(arg));
        }
        let mut command = Command::new("cmd.exe");
        command.args(["/d", "/s", "/c"]);
        command.raw_arg(&format!("\"{line}\""));
        command
    } else {
        let mut command = Command::new(&exe);
        command.args(&args);
        command
    };
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    text.chars().take(limit).collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn normalize_cwd(cwd: &str) -> String {
    let path = PathBuf::from(cwd.trim());
    let path = fs::canonicalize(&path).unwrap_or(path);
    let mut text = path.to_string_lossy().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        text = format!(r"\\{rest}");
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        text = rest.to_string();
    }
    let mut text = text.replace('/', "\\");
    while text.len() > 3 && text.ends_with('\\') {
        text.pop();
    }
    text.to_lowercase()
}

fn fingerprint(cwd: &str, task: &str, plan: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in cwd
        .as_bytes()
        .iter()
        .chain(task.as_bytes())
        .chain(plan.as_bytes())
    {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn parse_models(value: &Value) -> Vec<CxModel> {
    let rows = value
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
        .cloned()
        .unwrap_or_default();
    let mut seen = BTreeSet::new();
    let mut models = Vec::new();
    for row in rows {
        if row.get("hidden").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let selector = row
            .get("id")
            .and_then(Value::as_str)
            .or_else(|| row.get("model").and_then(Value::as_str))
            .unwrap_or("")
            .trim();
        if selector.is_empty() || !seen.insert(selector.to_string()) {
            continue;
        }
        let efforts = row
            .get("supportedReasoningEfforts")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        item.get("reasoningEffort")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        models.push(CxModel {
            selector: selector.to_string(),
            name: row
                .get("displayName")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or(selector)
                .to_string(),
            provider: "codex".to_string(),
            default_effort: row
                .get("defaultReasoningEffort")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            efforts,
            description: row
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            is_default: row.get("isDefault").and_then(Value::as_bool).unwrap_or(false),
        });
    }
    models.sort_by(|a, b| a.selector.cmp(&b.selector));
    models
}

fn load_state() -> CxState {
    fs::read_to_string(codex_state_file())
        .ok()
        .and_then(|raw| serde_json::from_str::<CxState>(&raw).ok())
        .unwrap_or_default()
}

fn save_state(state: &CxState) -> Result<(), String> {
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(state).map_err(|e| e.to_string())?
    );
    write_text_atomic(&codex_state_file(), &text, None)
}

fn role_view(role: &str, state: &CxState) -> Value {
    let (label, description) = ROLE_DEFS
        .iter()
        .find(|(key, _, _)| *key == role)
        .map(|(_, label, description)| (*label, *description))
        .unwrap_or(("Codex", "Codex 角色"));
    let entry = state.roles.get(role).cloned().unwrap_or_default();
    let raw = if entry.model.trim().is_empty() {
        String::new()
    } else if entry.effort.trim().is_empty() {
        entry.model.clone()
    } else {
        format!("{}#{}", entry.model, entry.effort)
    };
    json!({
        "role": role,
        "label": label,
        "description": description,
        "model": entry.model,
        "effort": entry.effort,
        "raw": raw,
    })
}

fn resolve_effort(entry: &CxModel, requested: &str) -> Result<String, String> {
    let requested = requested.trim();
    if requested.is_empty() {
        return Ok(entry.default_effort.clone());
    }
    if entry.efforts.iter().any(|effort| effort == requested) {
        return Ok(requested.to_string());
    }
    Err(format!(
        "模型 {} 不支持思考档 {requested}；可用：{}",
        entry.selector,
        if entry.efforts.is_empty() {
            "默认".to_string()
        } else {
            entry.efforts.join(", ")
        }
    ))
}

fn parse_strict_verdict(text: &str) -> Result<Value, String> {
    let trimmed = text.trim();
    let trimmed = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .and_then(|rest| rest.strip_suffix("```"))
        .map(str::trim)
        .unwrap_or(trimmed);
    let candidate = if trimmed.starts_with('{') && trimmed.ends_with('}') {
        trimmed.to_string()
    } else if let (Some(start), Some(end)) = (trimmed.find('{'), trimmed.rfind('}')) {
        if start < end {
            trimmed[start..=end].to_string()
        } else {
            return Err("验收模型没有返回 JSON 对象".into());
        }
    } else {
        return Err("验收模型没有返回 JSON 对象".into());
    };
    let value = serde_json::from_str::<Value>(&candidate)
        .map_err(|e| format!("验收 JSON 解析失败: {e}"))?;
    let verdict = value
        .get("verdict")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    if verdict != "pass" && verdict != "rework" {
        return Err("验收 JSON 的 verdict 必须是 pass 或 rework".into());
    }
    let summary = value
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let findings = value
        .get("findings")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(json!({
        "verdict": verdict,
        "findings": findings,
        "summary": summary,
    }))
}

fn review_output_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "verdict": { "type": "string", "enum": ["pass", "rework"] },
            "findings": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "severity": { "type": "string" },
                        "file": { "type": "string" },
                        "line": { "type": "integer" },
                        "message": { "type": "string" }
                    },
                    "required": ["severity", "file", "line", "message"],
                    "additionalProperties": false
                }
            },
            "summary": { "type": "string" }
        },
        "required": ["verdict", "findings", "summary"],
        "additionalProperties": false
    })
}

fn plan_prompt(task: &str) -> String {
    format!(
        "你是 Orzic Fusion 的规划阶段。只读调研，不修改项目文件，不执行计划。\n\
用户任务：\n{task}\n\n\
请输出：目标、可验证的验收标准、实施步骤、涉及文件、风险与假设。\
不要声称已经修改文件。"
    )
}

fn execute_prompt() -> &'static str {
    "用户已确认上面的计划。现在按计划执行；只修改目标工作区内的文件。\
完成后简要说明实际改动和验证结果，不要自动发起验收。"
}

fn review_prompt(plan: &str, diff: &str) -> String {
    format!(
        "{}\n\n严格只输出 JSON，不要输出 Markdown 代码块或其他文字。\
如果无法确认改动完整或验收标准，输出 rework 并说明原因。",
        acceptance::build_review_prompt(plan, diff)
    )
}

struct CodexRpc {
    child: Child,
    stdin: ChildStdin,
    lines: mpsc::Receiver<String>,
    stderr: mpsc::Receiver<String>,
    next_id: u64,
    isolated: bool,
}

impl CodexRpc {
    fn start(isolated: bool) -> Result<Self, String> {
        let exe = find_executable();
        let mut command = app_server_command(isolated);
        let mut child = command
            .spawn()
            .map_err(|e| format!("无法启动 Codex App Server ({exe}): {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or("无法写入 Codex App Server")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("无法读取 Codex App Server 输出")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("无法读取 Codex App Server 错误")?;
        let (line_tx, line_rx) = mpsc::channel();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line_tx.send(line).is_err() {
                    break;
                }
            }
        });
        let (err_tx, err_rx) = mpsc::channel();
        thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut buffer = String::new();
            let _ = reader.read_to_string(&mut buffer);
            let _ = err_tx.send(buffer);
        });
        Ok(Self {
            child,
            stdin,
            lines: line_rx,
            stderr: err_rx,
            next_id: 1,
            isolated,
        })
    }

    fn send_value(&mut self, value: &Value) -> Result<(), String> {
        let line = serde_json::to_string(value).map_err(|e| e.to_string())?;
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush())
            .map_err(|e| format!("写入 Codex App Server 失败: {e}"))
    }

    fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.send_value(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))?;
        let mut events = Vec::new();
        let response = self.wait_response(id, method, timeout, &mut events)?;
        Ok(response)
    }

    fn read_message(&mut self, timeout: Duration) -> Result<Value, String> {
        match self.lines.recv_timeout(timeout) {
            Ok(line) => serde_json::from_str::<Value>(&line)
                .map_err(|e| format!("Codex App Server 返回非法 JSON: {e}")),
            Err(mpsc::RecvTimeoutError::Timeout) => Err("Codex App Server 响应超时".into()),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let stderr = self.stderr.try_recv().unwrap_or_default();
                Err(format!(
                    "Codex App Server 已退出：{}",
                    truncate(stderr.trim(), 800)
                ))
            }
        }
    }

    fn handle_server_request(&mut self, value: &Value) -> bool {
        if value.get("method").and_then(Value::as_str).is_none() {
            return false;
        }
        let Some(id) = value.get("id") else {
            return false;
        };
        let _ = self.send_value(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": "Orzic Fusion 不授予审批或交互请求" }
        }));
        true
    }

    fn wait_response(
        &mut self,
        id: u64,
        method: &str,
        timeout: Duration,
        events: &mut Vec<Value>,
    ) -> Result<Value, String> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(format!("Codex {method} 响应超时"));
            }
            let value = self.read_message(remaining)?;
            if value.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(error) = value.get("error") {
                    return Err(format!(
                        "Codex {method} 失败：{}",
                        truncate(&error.to_string(), 800)
                    ));
                }
                return Ok(value);
            }
            if self.handle_server_request(&value) {
                continue;
            }
            events.push(value);
        }
    }

    fn initialize(&mut self) -> Result<(), String> {
        self.request(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "orzic-fusion",
                    "title": "Orzic Fusion",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "capabilities": {
                    "experimentalApi": false,
                    "requestAttestation": false,
                },
            }),
            RPC_TIMEOUT,
        )?;
        self.send_value(&json!({ "jsonrpc": "2.0", "method": "initialized" }))
    }

    fn model_list(&mut self) -> Result<Vec<CxModel>, String> {
        let mut all = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..20 {
            let mut params = json!({ "limit": 100, "includeHidden": false });
            if let Some(cursor) = &cursor {
                params["cursor"] = json!(cursor);
            }
            let response = self.request("model/list", params, RPC_TIMEOUT)?;
            let result = response.get("result").cloned().unwrap_or(Value::Null);
            all.extend(parse_models(&result));
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        let mut seen = BTreeSet::new();
        all.retain(|model| seen.insert(model.selector.clone()));
        all.sort_by(|a, b| a.selector.cmp(&b.selector));
        Ok(all)
    }

    fn thread_resume(&mut self, cwd: &Path, thread_id: &str, model: &str) -> Result<(), String> {
        self.request(
            "thread/resume",
            json!({
                "threadId": thread_id,
                "cwd": cwd.display().to_string(),
                "model": model,
                "approvalPolicy": "never",
                "sandbox": "workspace-write",
                "excludeTurns": true,
            }),
            RPC_TIMEOUT,
        )?;
        Ok(())
    }

    fn thread_read(&mut self, thread_id: &str) -> Result<(String, String), String> {
        let response = self.request(
            "thread/read",
            json!({ "threadId": thread_id, "includeTurns": false }),
            RPC_TIMEOUT,
        )?;
        let thread = response
            .get("result")
            .and_then(|result| result.get("thread"))
            .cloned()
            .unwrap_or(Value::Null);
        Ok((
            thread
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            thread
                .get("reasoningEffort")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        ))
    }

    fn interrupt(&mut self, thread_id: &str, turn_id: &str) {
        let id = self.next_id;
        self.next_id += 1;
        let _ = self.send_value(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "turn/interrupt",
            "params": { "threadId": thread_id, "turnId": turn_id }
        }));
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            match self.read_message(Duration::from_millis(300)) {
                Ok(value) if value.get("id").and_then(Value::as_u64) == Some(id) => break,
                Ok(_) => continue,
                Err(_) => break,
            }
        }
    }

    fn turn(
        &mut self,
        cwd: &Path,
        thread_id: &str,
        model: &str,
        effort: &str,
        prompt: &str,
        write: bool,
        output_schema: Option<Value>,
    ) -> Result<TurnOutcome, String> {
        let sandbox = if write {
            json!({
                "type": "workspaceWrite",
                "writableRoots": [cwd.display().to_string()],
                "networkAccess": false,
                "excludeTmpdirEnvVar": false,
                "excludeSlashTmp": false,
            })
        } else {
            json!({ "type": "readOnly", "networkAccess": false })
        };
        let mut params = json!({
            "threadId": thread_id,
            "input": [{ "type": "text", "text": prompt, "text_elements": [] }],
            "cwd": cwd.display().to_string(),
            "model": model,
            "effort": effort,
            "approvalPolicy": "never",
            "sandboxPolicy": sandbox,
        });
        if let Some(schema) = output_schema {
            params["outputSchema"] = schema;
        }
        let id = self.next_id;
        self.next_id += 1;
        self.send_value(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "turn/start",
            "params": params,
        }))?;
        let mut events = Vec::new();
        let response = self.wait_response(id, "turn/start", RPC_TIMEOUT, &mut events)?;
        let turn_id = response["result"]["turn"]["id"]
            .as_str()
            .ok_or("Codex turn/start 没有返回 turn.id")?
            .to_string();
        let started = Instant::now();
        let deadline = started + TURN_TIMEOUT;
        let mut text = String::new();
        let mut actual_model = String::new();
        let mut actual_effort = String::new();
        let mut rerouted = String::new();
        let mut tokens = Value::Null;
        let mut last_error = String::new();
        let mut completed: Option<Value> = None;

        for event in events {
            if let Some(done) = self.consume_turn_event(
                &event,
                thread_id,
                &turn_id,
                &mut text,
                &mut actual_model,
                &mut actual_effort,
                &mut rerouted,
                &mut tokens,
                &mut last_error,
            )? {
                completed = Some(done);
                break;
            }
        }

        while completed.is_none() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                self.interrupt(thread_id, &turn_id);
                return Err(format!("Codex 回合超时（{}s）", TURN_TIMEOUT.as_secs()));
            }
            let event = match self.read_message(remaining) {
                Ok(event) => event,
                Err(error) => {
                    self.interrupt(thread_id, &turn_id);
                    return Err(error);
                }
            };
            if self.handle_server_request(&event) {
                continue;
            }
            if let Some(done) = self.consume_turn_event(
                &event,
                thread_id,
                &turn_id,
                &mut text,
                &mut actual_model,
                &mut actual_effort,
                &mut rerouted,
                &mut tokens,
                &mut last_error,
            )? {
                completed = Some(done);
            }
        }

        let turn = completed.unwrap_or(Value::Null);
        let status = turn
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        if status != "completed" {
            let message = turn
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .or_else(|| {
                    if last_error.is_empty() {
                        None
                    } else {
                        Some(last_error.as_str())
                    }
                })
                .unwrap_or("Codex 回合未完成");
            return Err(format!(
                "Codex 回合 {}：{}",
                if status == "interrupted" {
                    "已中断"
                } else {
                    "失败"
                },
                truncate(message, 800)
            ));
        }
        if text.trim().is_empty() {
            text = turn
                .get("items")
                .and_then(Value::as_array)
                .and_then(|items| {
                    items.iter().rev().find_map(|item| {
                        (item.get("type").and_then(Value::as_str) == Some("agentMessage"))
                            .then(|| item.get("text").and_then(Value::as_str))
                            .flatten()
                    })
                })
                .unwrap_or("")
                .to_string();
        }
        if text.trim().is_empty() {
            return Err("Codex 没有返回文本".into());
        }
        let duration_ms = turn
            .get("durationMs")
            .and_then(Value::as_u64)
            .unwrap_or_else(|| started.elapsed().as_millis() as u64);
        Ok(TurnOutcome {
            text,
            actual_model,
            actual_effort,
            rerouted,
            duration_ms,
            tokens,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn consume_turn_event(
        &mut self,
        event: &Value,
        thread_id: &str,
        turn_id: &str,
        text: &mut String,
        actual_model: &mut String,
        actual_effort: &mut String,
        rerouted: &mut String,
        tokens: &mut Value,
        last_error: &mut String,
    ) -> Result<Option<Value>, String> {
        let method = event.get("method").and_then(Value::as_str).unwrap_or("");
        let params = event.get("params").cloned().unwrap_or(Value::Null);
        if method.starts_with("mcpServer/") && self.isolated {
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            self.interrupt(thread_id, turn_id);
            return Err(format!(
                "验收隔离失败：Codex 仍启动了 MCP 服务器 {name}"
            ));
        }
        match method {
            "item/completed" => {
                let item = params.get("item").cloned().unwrap_or(Value::Null);
                if item.get("type").and_then(Value::as_str) == Some("agentMessage") {
                    if let Some(value) = item.get("text").and_then(Value::as_str) {
                        if !value.trim().is_empty() {
                            *text = value.to_string();
                        }
                    }
                }
            }
            "item/agentMessage/delta" => {
                if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                    text.push_str(delta);
                }
            }
            "thread/settings/updated" => {
                let settings = params.get("threadSettings").cloned().unwrap_or(Value::Null);
                if let Some(model) = settings.get("model").and_then(Value::as_str) {
                    *actual_model = model.to_string();
                }
                if let Some(effort) = settings.get("effort").and_then(Value::as_str) {
                    *actual_effort = effort.to_string();
                }
            }
            "model/rerouted" => {
                let from = params.get("fromModel").and_then(Value::as_str).unwrap_or("");
                let to = params.get("toModel").and_then(Value::as_str).unwrap_or("");
                *rerouted = format!("{from} -> {to}");
                if !to.is_empty() {
                    *actual_model = to.to_string();
                }
            }
            "thread/tokenUsage/updated" => {
                if let Some(usage) = params.get("tokenUsage") {
                    *tokens = usage.clone();
                }
            }
            "error" => {
                if let Some(message) = params.get("message").and_then(Value::as_str) {
                    *last_error = message.to_string();
                } else {
                    *last_error = params.to_string();
                }
            }
            "turn/completed" => {
                if params.get("threadId").and_then(Value::as_str) != Some(thread_id) {
                    return Ok(None);
                }
                let turn = params.get("turn").cloned().unwrap_or(Value::Null);
                if turn.get("id").and_then(Value::as_str) != Some(turn_id) {
                    return Ok(None);
                }
                return Ok(Some(turn));
            }
            _ => {}
        }
        Ok(None)
    }

    fn close(&mut self) {
        kill_process_tree(&mut self.child);
    }
}

fn kill_process_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

impl Drop for CodexRpc {
    fn drop(&mut self) {
        self.close();
    }
}

fn fetch_models(force: bool) -> Result<Vec<CxModel>, String> {
    let cache_path = codex_models_cache_file();
    if !force {
        if let Ok(cached) = read_json(&cache_path) {
            let fresh = cached
                .get("at")
                .and_then(Value::as_u64)
                .map(|at| now_ms().saturating_sub(at) < MODELS_TTL_MS)
                .unwrap_or(false);
            if fresh {
                if let Some(rows) = cached.get("models").and_then(Value::as_array) {
                    let list: Vec<CxModel> = rows
                        .iter()
                        .filter_map(|row| serde_json::from_value(row.clone()).ok())
                        .collect();
                    if !list.is_empty() {
                        return Ok(list);
                    }
                }
            }
        }
    }
    let mut rpc = CodexRpc::start(true)?;
    rpc.initialize()?;
    let models = rpc.model_list()?;
    rpc.close();
    if models.is_empty() {
        return Err("Codex 未返回任何模型".into());
    }
    let _ = write_text_atomic(
        &cache_path,
        &serde_json::to_string(&json!({ "at": now_ms(), "models": &models }))
            .unwrap_or_default(),
        None,
    );
    Ok(models)
}

pub fn models(force: bool) -> Result<Vec<CxModel>, String> {
    fetch_models(force)
}

fn parse_exec_output(stdout: &str, elapsed: Duration) -> Result<ExecOutcome, String> {
    let mut thread_id = String::new();
    let mut text = String::new();
    let mut tokens = Value::Null;
    let mut error = String::new();
    for line in stdout.lines() {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match event.get("type").and_then(Value::as_str) {
            Some("thread.started") => {
                if let Some(id) = event.get("thread_id").and_then(Value::as_str) {
                    thread_id = id.to_string();
                }
            }
            Some("item.completed") => {
                let item = event.get("item").cloned().unwrap_or(Value::Null);
                if item.get("type").and_then(Value::as_str) == Some("agent_message") {
                    if let Some(value) = item.get("text").and_then(Value::as_str) {
                        if !value.trim().is_empty() {
                            text = value.to_string();
                        }
                    }
                }
            }
            Some("turn.completed") => {
                if let Some(usage) = event.get("usage") {
                    tokens = usage.clone();
                }
            }
            Some("turn.failed") => {
                error = event
                    .get("error")
                    .and_then(|value| value.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("Codex exec 回合失败")
                    .to_string();
            }
            Some("error") => {
                error = event
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex exec 返回错误")
                    .to_string();
            }
            _ => {}
        }
    }
    if !error.is_empty() {
        return Err(format!("Codex exec 失败：{}", truncate(&error, 800)));
    }
    if thread_id.is_empty() {
        return Err("Codex exec 没有返回 thread_id".into());
    }
    if text.trim().is_empty() {
        return Err("Codex exec 没有返回文本".into());
    }
    Ok(ExecOutcome {
        thread_id,
        text,
        actual_model: String::new(),
        actual_effort: String::new(),
        duration_ms: elapsed.as_millis() as u64,
        tokens,
    })
}

fn run_exec(
    cwd: &Path,
    model: &str,
    effort: &str,
    sandbox: &str,
    prompt: &str,
    output_schema: Option<&Path>,
) -> Result<ExecOutcome, String> {
    let exe = find_executable();
    let cwd_text = cwd.display().to_string();
    let mut args: Vec<String> = vec![
        "exec".into(),
        "--ignore-user-config".into(),
        "--ignore-rules".into(),
        "--json".into(),
        "--skip-git-repo-check".into(),
        "-m".into(),
        model.to_string(),
        "-s".into(),
        sandbox.to_string(),
        "-C".into(),
        cwd_text,
        "-c".into(),
        format!("model_reasoning_effort={effort}"),
        "-c".into(),
        "web_search=disabled".into(),
    ];
    if let Some(schema) = output_schema {
        args.push("--output-schema".into());
        args.push(schema.display().to_string());
    }
    args.push("-".into());
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut command = cli_command(&refs, &[]);
    command
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法运行 Codex exec ({exe}): {e}"))?;
    let mut stdin = child.stdin.take().ok_or("无法写入 Codex exec")?;
    let prompt = prompt.to_string();
    thread::spawn(move || {
        let _ = stdin.write_all(prompt.as_bytes());
    });
    let stdout = child.stdout.take().ok_or("无法读取 Codex exec 输出")?;
    let stderr = child.stderr.take().ok_or("无法读取 Codex exec 错误")?;
    let (out_tx, out_rx) = mpsc::channel();
    let (err_tx, err_rx) = mpsc::channel();
    thread::spawn(move || {
        let mut reader = stdout;
        let mut buffer = String::new();
        let _ = reader.read_to_string(&mut buffer);
        let _ = out_tx.send(buffer);
    });
    thread::spawn(move || {
        let mut reader = stderr;
        let mut buffer = String::new();
        let _ = reader.read_to_string(&mut buffer);
        let _ = err_tx.send(buffer);
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started.elapsed() > TURN_TIMEOUT {
                    kill_process_tree(&mut child);
                    return Err(format!(
                        "Codex exec 超时（{}s）",
                        TURN_TIMEOUT.as_secs()
                    ));
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return Err(format!("等待 Codex exec 进程失败: {error}")),
        }
    };
    let out = out_rx.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
    let err = err_rx.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
    if !status.success() {
        let parsed = parse_exec_output(&out, started.elapsed());
        let stderr = err.trim();
        return match parsed {
            Err(error) => Err(if stderr.is_empty() {
                error
            } else {
                format!("{error}；stderr：{}", truncate(stderr, 800))
            }),
            Ok(_) => Err(format!(
                "Codex exec 退出码 {:#?}：{}",
                status.code(),
                if stderr.is_empty() {
                    "没有返回错误文本".to_string()
                } else {
                    truncate(stderr, 800)
                }
            )),
        };
    }
    parse_exec_output(&out, started.elapsed())
}

fn read_thread_settings(thread_id: &str) -> Result<(String, String), String> {
    let mut rpc = CodexRpc::start(false)?;
    rpc.initialize()?;
    let settings = rpc.thread_read(thread_id);
    rpc.close();
    settings
}

fn run_plan(
    cwd: &Path,
    task: &str,
    model: &str,
    effort: &str,
) -> Result<ExecOutcome, String> {
    let mut outcome = run_exec(
        cwd,
        model,
        effort,
        "read-only",
        &plan_prompt(task),
        None,
    )?;
    if let Ok((actual_model, actual_effort)) = read_thread_settings(&outcome.thread_id) {
        outcome.actual_model = actual_model;
        outcome.actual_effort = actual_effort;
    }
    Ok(outcome)
}

fn run_execute(
    cwd: &Path,
    thread_id: &str,
    model: &str,
    effort: &str,
) -> Result<TurnOutcome, String> {
    let mut rpc = CodexRpc::start(false)?;
    rpc.initialize()?;
    rpc.thread_resume(cwd, thread_id, model)?;
    let mut outcome = rpc.turn(
        cwd,
        thread_id,
        model,
        effort,
        execute_prompt(),
        true,
        None,
    )?;
    if let Ok((actual_model, actual_effort)) = rpc.thread_read(thread_id) {
        if !actual_model.is_empty() {
            outcome.actual_model = actual_model;
        }
        if !actual_effort.is_empty() {
            outcome.actual_effort = actual_effort;
        }
    }
    rpc.close();
    Ok(outcome)
}

fn run_review(
    cwd: &Path,
    plan: &str,
    diff: &str,
    model: &str,
    effort: &str,
) -> Result<ExecOutcome, String> {
    let schema_path = env::temp_dir().join(format!(
        "orzic-codex-review-{}-{}.json",
        std::process::id(),
        now_ms()
    ));
    fs::write(
        &schema_path,
        serde_json::to_string(&review_output_schema()).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("写入 Codex 验收 schema 失败: {e}"))?;
    let result = run_exec(
        cwd,
        model,
        effort,
        "read-only",
        &review_prompt(plan, diff),
        Some(&schema_path),
    );
    let _ = fs::remove_file(&schema_path);
    let mut outcome = result?;
    if let Ok((actual_model, actual_effort)) = read_thread_settings(&outcome.thread_id) {
        outcome.actual_model = actual_model;
        outcome.actual_effort = actual_effort;
    }
    Ok(outcome)
}

pub fn version() -> Result<String, String> {
    run_cli(&["--version"], None, &[]).map(|text| text.trim().to_string())
}

pub fn login_status() -> String {
    let exe = find_executable();
    let mut command = cli_command(&["login", "status"], &[]);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match command.output() {
        Ok(out) => {
            let mut text = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if text.is_empty() {
                text = String::from_utf8_lossy(&out.stderr).trim().to_string();
            }
            if !out.status.success() {
                format!(
                    "未登录或无法读取：{}",
                    if text.is_empty() {
                        format!("Codex login status 退出码 {:#?}", out.status.code())
                    } else {
                        text
                    }
                )
            } else if text.is_empty() {
                "已登录（Codex CLI 未返回状态文本）".to_string()
            } else {
                text
            }
        }
        Err(error) => format!("未登录或无法读取：无法运行 Codex ({exe}): {error}"),
    }
}

pub fn status(cwd: &str, force_models: bool) -> Value {
    let key = normalize_cwd(cwd);
    let (models, model_error) = match models(force_models) {
        Ok(list) => (list, None),
        Err(error) => (Vec::new(), Some(error)),
    };
    let state = load_state();
    let session = state.sessions.get(&key).cloned().unwrap_or_default();
    let review = state.reviews.get(&key).cloned().unwrap_or(Value::Null);
    let connector = crate::connectors::list_all()["targets"]
        .as_array()
        .and_then(|targets| targets.iter().find(|target| target["id"] == "codex"))
        .cloned()
        .unwrap_or(Value::Null);
    json!({
        "executable": find_executable(),
        "version": version().unwrap_or_default(),
        "login": login_status(),
        "configPath": codex_config_path().to_string_lossy(),
        "configExists": codex_config_path().exists(),
        "models": models,
        "modelError": model_error,
        "roles": ROLE_DEFS
            .iter()
            .map(|(role, _, _)| role_view(role, &state))
            .collect::<Vec<_>>(),
        "session": if session.id.is_empty() {
            Value::Null
        } else {
            serde_json::to_value(&session).unwrap_or(Value::Null)
        },
        "review": review,
        "connector": connector,
        "cwd": key,
        "isolation": "规划/验收：codex exec --ignore-user-config（不加载 MCP/插件/联网）",
    })
}

pub fn save_roles(body: &Map<String, Value>) -> Result<Value, String> {
    let cwd = body.get("cwd").and_then(Value::as_str).unwrap_or("");
    let edits = body
        .get("roles")
        .and_then(Value::as_object)
        .ok_or("缺少 roles")?;
    let catalog = models(false)?;
    let _guard = STATE_LOCK
        .lock()
        .map_err(|_| "Codex 状态写入锁不可用".to_string())?;
    let mut state = load_state();
    for (role, edit) in edits {
        if !ROLE_DEFS.iter().any(|(key, _, _)| key == role) {
            continue;
        }
        let model = edit
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let requested_effort = edit
            .get("effort")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if model.is_empty() {
            state.roles.remove(role);
            continue;
        }
        let Some(entry) = catalog.iter().find(|entry| entry.selector == model) else {
            return Err(format!("模型不在当前 Codex 目录：{model}"));
        };
        let effort = resolve_effort(entry, &requested_effort)?;
        state.roles.insert(
            role.clone(),
            CxRole {
                model,
                effort,
            },
        );
    }
    save_state(&state)?;
    Ok(status(cwd, false))
}

pub fn session_action(body: &Map<String, Value>) -> Result<Value, String> {
    let action = body
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("status");
    let cwd = body
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let task = body
        .get("task")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let provided_session = body
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if action == "status" {
        return Ok(status(&cwd, false));
    }
    let cwd_path = PathBuf::from(&cwd);
    if !cwd_path.is_dir() {
        return Err(format!("工作区不存在：{}", cwd_path.display()));
    }
    let key = normalize_cwd(&cwd);

    match action {
        "plan" => {
            if task.is_empty() {
                return Err("请先填写本轮任务".into());
            }
            let state = load_state();
            let role = state.roles.get("plan").cloned().unwrap_or_default();
            if role.model.trim().is_empty() {
                return Err("规划角色尚未选择 Codex 模型".into());
            }
            let catalog = models(false)?;
            let Some(model) = catalog.iter().find(|entry| entry.selector == role.model) else {
                return Err(format!("规划模型不在当前 Codex 目录：{}", role.model));
            };
            let effort = resolve_effort(model, &role.effort)?;
            let outcome = run_plan(&cwd_path, &task, &role.model, &effort)?;
            let mut state = load_state();
            state.sessions.insert(
                key.clone(),
                CxSession {
                    id: outcome.thread_id,
                    cwd: cwd.clone(),
                    task: task.clone(),
                    phase: "planned".to_string(),
                    plan: outcome.text,
                    plan_model: role.model,
                    plan_effort: effort,
                    plan_actual_model: outcome.actual_model,
                    plan_actual_effort: outcome.actual_effort,
                    plan_rerouted: String::new(),
                    plan_fingerprint: String::new(),
                    execution: String::new(),
                    execution_model: String::new(),
                    execution_effort: String::new(),
                    execution_actual_model: String::new(),
                    execution_actual_effort: String::new(),
                    execution_rerouted: String::new(),
                    execution_tokens: Value::Null,
                    execution_duration_ms: 0,
                    updated_at: now_ms(),
                },
            );
            let mut session = state.sessions.get(&key).cloned().unwrap();
            session.plan_fingerprint = fingerprint(&key, &session.task, &session.plan);
            state.sessions.insert(key.clone(), session);
            save_state(&state)?;
        }
        "execute" => {
            let mut state = load_state();
            let mut session = state
                .sessions
                .get(&key)
                .cloned()
                .ok_or("当前工作区没有 Fusion 创建的 Codex 规划会话")?;
            if provided_session.is_empty() || provided_session != session.id {
                return Err("会话 ID 与当前工作区不匹配；请重新规划".into());
            }
            if session.phase != "planned" {
                return Err("当前会话没有待确认的规划，不能进入执行".into());
            }
            let expected = fingerprint(&key, &session.task, &session.plan);
            if session.plan_fingerprint != expected {
                return Err("规划内容与确认记录不一致；请重新规划".into());
            }
            let role = state.roles.get("execute").cloned().unwrap_or_default();
            if role.model.trim().is_empty() {
                return Err("执行角色尚未选择 Codex 模型".into());
            }
            let catalog = models(false)?;
            let Some(model) = catalog.iter().find(|entry| entry.selector == role.model) else {
                return Err(format!("执行模型不在当前 Codex 目录：{}", role.model));
            };
            let effort = resolve_effort(model, &role.effort)?;
            let outcome = run_execute(&cwd_path, &session.id, &role.model, &effort)?;
            session.phase = "executed".to_string();
            session.execution = outcome.text;
            session.execution_model = role.model;
            session.execution_effort = effort;
            session.execution_actual_model = outcome.actual_model;
            session.execution_actual_effort = outcome.actual_effort;
            session.execution_rerouted = outcome.rerouted;
            session.execution_tokens = outcome.tokens;
            session.execution_duration_ms = outcome.duration_ms;
            session.updated_at = now_ms();
            state.sessions.insert(key.clone(), session);
            save_state(&state)?;
        }
        "review" => {
            let state = load_state();
            let session = state
                .sessions
                .get(&key)
                .cloned()
                .ok_or("当前工作区没有 Fusion 创建的 Codex 会话")?;
            if session.phase != "executed" {
                return Err("当前会话尚未完成执行，不能验收".into());
            }
            let role = state.roles.get("review").cloned().unwrap_or_default();
            if role.model.trim().is_empty() {
                return Err("验收角色尚未选择 Codex 模型".into());
            }
            let catalog = models(false)?;
            let Some(model) = catalog.iter().find(|entry| entry.selector == role.model) else {
                return Err(format!("验收模型不在当前 Codex 目录：{}", role.model));
            };
            let effort = resolve_effort(model, &role.effort)?;
            let (plan, diff, files) = acceptance::collect_review_input(&cwd)?;
            if diff.trim().is_empty() {
                let result = json!({
                    "verdict": "skip",
                    "findings": [],
                    "summary": "工作区没有可验收的改动",
                    "cwd": key,
                    "host": "codex",
                    "model": role.model,
                    "effort": effort,
                    "files": 0,
                    "diffChars": 0,
                    "at": now_ms(),
                });
                let mut state = load_state();
                state.reviews.insert(key.clone(), result);
                save_state(&state)?;
                return Ok(status(&cwd, false));
            }
            let outcome = run_review(&cwd_path, &plan, &diff, &role.model, &effort)?;
            let parsed = parse_strict_verdict(&outcome.text)?;
            let result = json!({
                "verdict": parsed["verdict"],
                "findings": parsed["findings"],
                "summary": parsed["summary"],
                "cwd": key,
                "host": "codex",
                "model": role.model,
                "effort": effort,
                "actualModel": outcome.actual_model,
                "actualEffort": outcome.actual_effort,
                "rerouted": "",
                "threadId": outcome.thread_id,
                "files": files,
                "diffChars": diff.chars().count(),
                "durationMs": outcome.duration_ms,
                "tokens": outcome.tokens,
                "at": now_ms(),
            });
            let mut state = load_state();
            state.reviews.insert(key.clone(), result);
            save_state(&state)?;
        }
        "reset" => {
            let mut state = load_state();
            state.sessions.remove(&key);
            save_state(&state)?;
        }
        other => return Err(format!("不支持的 Codex 会话动作：{other}")),
    }
    Ok(status(&cwd, false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_models_and_efforts() {
        let value = json!({
            "data": [
                {
                    "id": "gpt-6.2-sol",
                    "displayName": "GPT-6.2-Sol",
                    "supportedReasoningEfforts": [
                        {"reasoningEffort": "low", "description": "fast"},
                        {"reasoningEffort": "high", "description": "deep"}
                    ],
                    "defaultReasoningEffort": "high",
                    "hidden": false,
                    "isDefault": true
                },
                {
                    "id": "hidden-model",
                    "displayName": "Hidden",
                    "hidden": true
                }
            ]
        });
        let models = parse_models(&value);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].selector, "gpt-6.2-sol");
        assert_eq!(models[0].efforts, vec!["low", "high"]);
        assert_eq!(models[0].default_effort, "high");
        assert!(models[0].is_default);
    }

    #[test]
    fn validates_effort_against_model() {
        let model = CxModel {
            selector: "gpt".into(),
            name: "GPT".into(),
            provider: "codex".into(),
            efforts: vec!["low".into(), "high".into()],
            default_effort: "high".into(),
            description: String::new(),
            is_default: false,
        };
        assert_eq!(resolve_effort(&model, "low").unwrap(), "low");
        assert_eq!(resolve_effort(&model, "").unwrap(), "high");
        assert!(resolve_effort(&model, "ultra").unwrap_err().contains("不支持"));
    }

    #[test]
    fn fingerprint_binds_plan_and_task() {
        let first = fingerprint("c:\\repo", "task", "plan");
        assert_eq!(first, fingerprint("c:\\repo", "task", "plan"));
        assert_ne!(first, fingerprint("c:\\repo", "other", "plan"));
        assert_ne!(first, fingerprint("c:\\repo", "task", "other"));
    }

    #[test]
    fn strict_verdict_requires_json() {
        assert!(parse_strict_verdict("PASS").is_err());
        let parsed = parse_strict_verdict(
            "```json\n{\"verdict\":\"pass\",\"findings\":[],\"summary\":\"ok\"}\n```",
        )
        .unwrap();
        assert_eq!(parsed["verdict"], "pass");
        assert_eq!(parsed["summary"], "ok");
    }

    #[test]
    fn strict_verdict_rejects_unknown_verdict() {
        assert!(parse_strict_verdict("{\"verdict\":\"maybe\",\"summary\":\"x\"}").is_err());
    }

    #[test]
    fn parses_exec_thread_and_final_message() {
        let stdout = concat!(
            "{\"type\":\"thread.started\",\"thread_id\":\"thr_1\"}\n",
            "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"OK\"}}\n",
            "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":10,\"output_tokens\":2}}\n"
        );
        let result = parse_exec_output(stdout, Duration::from_millis(5)).unwrap();
        assert_eq!(result.thread_id, "thr_1");
        assert_eq!(result.text, "OK");
        assert_eq!(result.tokens["output_tokens"], 2);
    }

    #[test]
    fn exec_failure_is_not_reported_as_success() {
        let stdout = "{\"type\":\"turn.failed\",\"error\":{\"message\":\"bad schema\"}}\n";
        let err = parse_exec_output(stdout, Duration::from_millis(5)).unwrap_err();
        assert!(err.contains("bad schema"));
    }
}
