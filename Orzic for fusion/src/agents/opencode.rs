use crate::acceptance;
use crate::config::{
    appdata_dir, home_dir, opencode_agents_dir, opencode_config_path,
    opencode_models_cache_file, opencode_state_file, read_json, write_text_atomic,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const RUN_TIMEOUT: Duration = Duration::from_secs(300);
const MODELS_TTL_MS: u64 = 5 * 60 * 1000;
const REVIEW_MARKER: &str = "managed by Orzic for fusion";

static STATE_LOCK: Mutex<()> = Mutex::new(());

pub const ROLE_DEFS: &[(&str, &str, &str)] = &[
    ("plan", "规划 Plan", "只读规划；在 OpenCode 的 plan agent 上运行"),
    ("execute", "执行 Execute", "按已确认计划执行；在 OpenCode 的 build agent 上运行"),
    ("review", "验收 Review", "独立只读评审；使用 Fusion-owned fusion-review agent"),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcModel {
    pub selector: String,
    pub name: String,
    pub provider: String,
    #[serde(default)]
    pub variants: Vec<String>,
    #[serde(default)]
    pub context_window: u64,
    #[serde(default)]
    pub max_tokens: u64,
    #[serde(default)]
    pub cost_input: f64,
    #[serde(default)]
    pub cost_output: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OcRole {
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub variant: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OcSession {
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
    pub plan_variant: String,
    #[serde(default)]
    pub execution: String,
    #[serde(default)]
    pub execution_model: String,
    #[serde(default)]
    pub execution_variant: String,
    #[serde(default)]
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct OcState {
    #[serde(default)]
    roles: BTreeMap<String, OcRole>,
    #[serde(default)]
    sessions: BTreeMap<String, OcSession>,
    #[serde(default)]
    reviews: BTreeMap<String, Value>,
}

pub fn find_executable() -> String {
    if let Ok(path) = env::var("ORZIC_OPENCODE_BIN") {
        if !path.trim().is_empty() {
            return path;
        }
    }
    let names: &[&str] = if cfg!(windows) {
        &["opencode.exe", "opencode.cmd", "opencode.bat", "opencode"]
    } else {
        &["opencode"]
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
    let mut fallbacks = vec![
        appdata_dir().join("npm").join(if cfg!(windows) {
            "opencode.cmd"
        } else {
            "opencode"
        }),
        home_dir().join(".bun").join("bin").join(if cfg!(windows) {
            "opencode.exe"
        } else {
            "opencode"
        }),
        home_dir().join(".local").join("bin").join(if cfg!(windows) {
            "opencode.exe"
        } else {
            "opencode"
        }),
    ];
    fallbacks.retain(|p| p.is_file());
    if let Some(p) = fallbacks.into_iter().next() {
        return p.to_string_lossy().to_string();
    }
    if cfg!(windows) {
        "opencode.cmd".to_string()
    } else {
        "opencode".to_string()
    }
}

fn command() -> Command {
    let mut cmd = Command::new(find_executable());
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    text.chars().take(limit).collect()
}

fn run_plain(args: &[&str], cwd: Option<&Path>) -> Result<String, String> {
    let exe = find_executable();
    let mut cmd = command();
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
        cmd.env("PWD", cwd);
        cmd.env("INIT_CWD", cwd);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("无法运行 OpenCode ({exe}): {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "OpenCode {} 执行失败 (code {:?}): {}",
            args.join(" "),
            out.status.code(),
            truncate(stderr.trim(), 600)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

const PROBE_TTL: Duration = Duration::from_secs(60);

static VERSION_CACHE: Mutex<Option<(Instant, String)>> = Mutex::new(None);

pub fn invalidate_probe_cache() {
    if let Ok(mut slot) = VERSION_CACHE.lock() {
        *slot = None;
    }
}

/// `opencode --version` costs a process spawn (~150 ms) on every Agent detail
/// load. It only changes on upgrade, so keep it for a minute; the refresh
/// button (`force`) clears it first.
pub fn version() -> Result<String, String> {
    if let Ok(slot) = VERSION_CACHE.lock() {
        if let Some((at, text)) = slot.as_ref() {
            if at.elapsed() < PROBE_TTL {
                return Ok(text.clone());
            }
        }
    }
    let text = run_plain(&["--version"], None)?
        .trim()
        .to_string();
    if let Ok(mut slot) = VERSION_CACHE.lock() {
        *slot = Some((Instant::now(), text.clone()));
    }
    Ok(text)
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

fn variant_ids(value: &Value) -> Vec<String> {
    if let Some(items) = value.as_array() {
        return items
            .iter()
            .filter_map(|item| {
                item.get("id")
                    .and_then(Value::as_str)
                    .or_else(|| item.as_str())
                    .map(str::to_string)
            })
            .collect();
    }
    if let Some(items) = value.as_object() {
        return items.keys().cloned().collect();
    }
    Vec::new()
}

fn parse_models(value: &Value) -> Vec<OcModel> {
    let rows = value
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
        .cloned()
        .unwrap_or_default();
    let mut seen = BTreeSet::new();
    let mut models = Vec::new();
    for row in rows {
        if row.get("enabled").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        if row.get("status").and_then(Value::as_str) == Some("disabled") {
            continue;
        }
        let provider = row
            .get("providerID")
            .and_then(Value::as_str)
            .or_else(|| row.get("provider").and_then(Value::as_str))
            .unwrap_or("")
            .trim();
        let model_id = row
            .get("modelID")
            .and_then(Value::as_str)
            .or_else(|| row.get("id").and_then(Value::as_str))
            .unwrap_or("")
            .trim();
        if model_id.is_empty() {
            continue;
        }
        let selector = if provider.is_empty() {
            model_id.to_string()
        } else if model_id.starts_with(&format!("{provider}/")) {
            model_id.to_string()
        } else {
            format!("{provider}/{model_id}")
        };
        if !seen.insert(selector.clone()) {
            continue;
        }
        let name = row
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .unwrap_or(&selector)
            .to_string();
        let limit = row.get("limit");
        let cost = row
            .get("cost")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .or_else(|| row.get("cost"));
        models.push(OcModel {
            selector,
            name,
            provider: provider.to_string(),
            variants: variant_ids(row.get("variants").unwrap_or(&Value::Null)),
            context_window: limit
                .and_then(|l| l.get("context"))
                .and_then(Value::as_u64)
                .unwrap_or(0),
            max_tokens: limit
                .and_then(|l| l.get("output"))
                .and_then(Value::as_u64)
                .unwrap_or(0),
            cost_input: cost
                .and_then(|c| c.get("input"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            cost_output: cost
                .and_then(|c| c.get("output"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
        });
    }
    models.sort_by(|a, b| a.selector.cmp(&b.selector));
    models
}

fn parse_model_lines(text: &str) -> Vec<OcModel> {
    let mut models = Vec::new();
    for line in text.lines() {
        let selector = line.trim();
        if selector.is_empty() || selector.contains(char::is_whitespace) {
            continue;
        }
        let provider = selector.split('/').next().unwrap_or("").to_string();
        models.push(OcModel {
            selector: selector.to_string(),
            name: selector.to_string(),
            provider,
            variants: Vec::new(),
            context_window: 0,
            max_tokens: 0,
            cost_input: 0.0,
            cost_output: 0.0,
        });
    }
    models.sort_by(|a, b| a.selector.cmp(&b.selector));
    models
}

pub fn models(force: bool) -> Result<Vec<OcModel>, String> {
    let cache_path = opencode_models_cache_file();
    if !force {
        if let Ok(cached) = read_json(&cache_path) {
            let fresh = cached
                .get("at")
                .and_then(Value::as_u64)
                .map(|at| now_ms().saturating_sub(at) < MODELS_TTL_MS)
                .unwrap_or(false);
            if fresh {
                if let Some(rows) = cached.get("models").and_then(Value::as_array) {
                    let list: Vec<OcModel> = rows
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

    let mut list = Vec::new();
    let mut last_error = String::new();
    match run_plain(&["api", "get", "/api/model"], None) {
        Ok(raw) => match serde_json::from_str::<Value>(raw.trim()) {
            Ok(value) => list = parse_models(&value),
            Err(e) => last_error = format!("OpenCode 模型目录不是合法 JSON: {e}"),
        },
        Err(e) => last_error = e,
    }
    if list.is_empty() {
        if let Ok(raw) = run_plain(&["models"], None) {
            list = parse_model_lines(&raw);
        }
    }
    if list.is_empty() {
        return Err(if last_error.is_empty() {
            "OpenCode 未返回任何模型".to_string()
        } else {
            last_error
        });
    }
    let _ = write_text_atomic(
        &cache_path,
        &serde_json::to_string(&json!({
            "at": now_ms(),
            "models": &list,
        }))
        .unwrap_or_default(),
        None,
    );
    Ok(list)
}

fn load_state() -> OcState {
    fs::read_to_string(opencode_state_file())
        .ok()
        .and_then(|raw| serde_json::from_str::<OcState>(&raw).ok())
        .unwrap_or_default()
}

fn save_state(state: &OcState) -> Result<(), String> {
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(state).map_err(|e| e.to_string())?
    );
    write_text_atomic(&opencode_state_file(), &text, None)
}

fn selector(role: &OcRole) -> Result<String, String> {
    let model = role.model.trim();
    if model.is_empty() {
        return Err("该角色尚未选择 OpenCode 模型".into());
    }
    let variant = role.variant.trim();
    if variant.is_empty() {
        Ok(model.to_string())
    } else {
        Ok(format!("{model}#{variant}"))
    }
}

fn role_view(role: &str, state: &OcState) -> Value {
    let (label, description) = ROLE_DEFS
        .iter()
        .find(|(key, _, _)| *key == role)
        .map(|(_, label, description)| (*label, *description))
        .unwrap_or(("OpenCode", "OpenCode 角色"));
    let entry = state.roles.get(role).cloned().unwrap_or_default();
    let raw = if entry.model.trim().is_empty() {
        String::new()
    } else if entry.variant.trim().is_empty() {
        entry.model.clone()
    } else {
        format!("{}#{}", entry.model, entry.variant)
    };
    json!({
        "role": role,
        "label": label,
        "description": description,
        "model": entry.model,
        "variant": entry.variant,
        "raw": raw,
    })
}

fn review_agent_path() -> PathBuf {
    opencode_agents_dir().join("fusion-review.md")
}

fn review_agent_content() -> String {
    format!(
        r#"---
description: Orzic for fusion review ({REVIEW_MARKER}; read-only)
mode: primary
permissions:
  - action: "*"
    resource: "*"
    effect: deny
  - action: read
    resource: "*"
    effect: allow
  - action: glob
    resource: "*"
    effect: allow
  - action: grep
    resource: "*"
    effect: allow
---
You are the independent read-only review agent for Orzic for fusion. Review the supplied plan and diff. Do not edit files, run shell commands, launch subagents, or fetch the web. Return only the requested JSON verdict.
"#
    )
}

fn review_agent_ready() -> bool {
    fs::read_to_string(review_agent_path())
        .map(|raw| raw.contains(REVIEW_MARKER))
        .unwrap_or(false)
}

fn ensure_review_agent() -> Result<PathBuf, String> {
    let path = review_agent_path();
    if path.exists() {
        let raw = fs::read_to_string(&path)
            .map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
        if !raw.contains(REVIEW_MARKER) {
            return Err(format!(
                "{} 已存在但不是 Fusion 管理的 agent；拒绝覆盖",
                path.display()
            ));
        }
        let desired = review_agent_content();
        if raw != desired {
            write_text_atomic(&path, &desired, None)?;
        }
        return Ok(path);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建 OpenCode agents 目录 {}: {e}", parent.display()))?;
    }
    write_text_atomic(&path, &review_agent_content(), None)?;
    Ok(path)
}

fn parse_run_output(stdout: &str, session_id: &str, elapsed: Duration) -> Result<Value, String> {
    let mut text = String::new();
    let mut reason = "unknown".to_string();
    let mut cost = 0.0;
    let mut tokens = Value::Null;
    let mut error: Option<String> = None;
    for line in stdout.lines() {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match event.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(part) = event.get("part").and_then(Value::as_object) {
                    if let Some(value) = part.get("text").and_then(Value::as_str) {
                        text.push_str(value);
                    }
                }
            }
            Some("step_finish") => {
                if let Some(part) = event.get("part").and_then(Value::as_object) {
                    if let Some(value) = part.get("reason").and_then(Value::as_str) {
                        reason = value.to_string();
                    }
                    cost = part.get("cost").and_then(Value::as_f64).unwrap_or(0.0);
                    if let Some(value) = part.get("tokens") {
                        tokens = value.clone();
                    }
                }
            }
            Some("error") => {
                error = Some(
                    event
                        .get("error")
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| "OpenCode 返回错误事件".to_string()),
                );
            }
            _ => {}
        }
    }
    if let Some(message) = error {
        return Err(format!("OpenCode 返回错误：{}", truncate(&message, 600)));
    }
    if text.trim().is_empty() {
        return Err(format!("OpenCode 没有返回文本（{reason}）"));
    }
    Ok(json!({
        "sessionId": session_id,
        "text": text,
        "status": reason,
        "cost": cost,
        "tokens": tokens,
        "durationMs": elapsed.as_millis() as u64,
    }))
}

fn run_agent(
    cwd: &Path,
    session_id: &str,
    agent: &str,
    model: &str,
    prompt: &str,
    standalone: bool,
    phase: &str,
) -> Result<Value, String> {
    let exe = find_executable();
    let mut cmd = command();
    if standalone {
        cmd.arg("--standalone");
    }
    cmd.args([
        "run",
        "--format",
        "json",
        "--session",
        session_id,
        "--agent",
        agent,
        "--model",
        model,
        "--title",
        "Orzic Fusion",
    ]);
    cmd.current_dir(cwd)
        .env("PWD", cwd)
        .env("INIT_CWD", cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法运行 OpenCode ({exe}): {e}"))?;
    let _memory = crate::memory::Track::start(
        "opencode",
        session_id.to_string(),
        child.id(),
        cwd.display().to_string(),
        phase,
        "",
        "run",
        "本次 OpenCode 运行进程的内存；退出后不再上报",
    );
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .map_err(|e| format!("写入 OpenCode 提示失败: {e}"))?;
    }
    let stdout = child.stdout.take().ok_or("无法读取 OpenCode 输出")?;
    let stderr = child.stderr.take().ok_or("无法读取 OpenCode 错误")?;
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
                if started.elapsed() > RUN_TIMEOUT {
                    let _ = child.kill();
                    return Err(format!(
                        "OpenCode {agent} 超时（{}s）",
                        RUN_TIMEOUT.as_secs()
                    ));
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("等待 OpenCode 进程失败: {e}")),
        }
    };
    let out = out_rx.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
    let err = err_rx.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
    if !status.success() {
        return Err(format!(
            "OpenCode {agent} 运行失败（{}）：{}",
            model,
            truncate(err.trim(), 800)
        ));
    }
    parse_run_output(&out, session_id, started.elapsed())
}

fn create_session(cwd: &Path, title: &str) -> Result<String, String> {
    let body = json!({
        "location": { "directory": cwd.display().to_string() },
        "title": title,
    });
    let raw = run_plain(
        &[
            "api",
            "session.create",
            "--data",
            &serde_json::to_string(&body).map_err(|e| e.to_string())?,
        ],
        None,
    )?;
    let value = serde_json::from_str::<Value>(raw.trim())
        .map_err(|e| format!("OpenCode session.create 返回非法 JSON: {e}"))?;
    value["data"]["id"]
        .as_str()
        .or_else(|| value["id"].as_str())
        .map(str::to_string)
        .ok_or_else(|| "OpenCode session.create 没有返回会话 ID".to_string())
}

fn plan_prompt(task: &str) -> String {
    format!(
        "你是 Orzic Fusion 的规划阶段。只读调研，不修改项目文件。\n\
用户任务：\n{task}\n\n\
请输出：目标、可验证的验收标准、实施步骤、涉及文件、风险与假设。\
不要执行计划，也不要声称已经修改文件。"
    )
}

fn execute_prompt() -> &'static str {
    "用户已确认上面的计划。现在按计划执行；完成后简要说明实际改动和验证结果。\
不要扩大到计划之外，也不要自动发起验收。"
}

pub fn status(cwd: &str, force_models: bool) -> Value {
    if force_models {
        invalidate_probe_cache();
    }
    let key = normalize_cwd(cwd);
    let models_result = models(force_models);
    let (models, model_error) = match models_result {
        Ok(list) => (list, None),
        Err(error) => (Vec::new(), Some(error)),
    };
    let state = load_state();
    let session = state.sessions.get(&key).cloned().unwrap_or_default();
    let review = state
        .reviews
        .get(&key)
        .cloned()
        .unwrap_or(Value::Null);
    let connector = crate::connectors::list_all()["targets"]
        .as_array()
        .and_then(|targets| targets.iter().find(|target| target["id"] == "opencode"))
        .cloned()
        .unwrap_or(Value::Null);
    let version = version().unwrap_or_default();
    json!({
        "executable": find_executable(),
        "version": version,
        "configPath": opencode_config_path().to_string_lossy(),
        "configExists": opencode_config_path().exists(),
        "jsoncExists": opencode_config_path().with_extension("jsonc").exists(),
        "reviewAgentPath": review_agent_path().to_string_lossy(),
        "reviewAgentReady": review_agent_ready(),
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
        .map_err(|_| "OpenCode 状态写入锁不可用".to_string())?;
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
        let variant = edit
            .get("variant")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if model.is_empty() {
            state.roles.remove(role);
            continue;
        }
        let Some(entry) = catalog.iter().find(|entry| entry.selector == model) else {
            return Err(format!("模型不在当前 OpenCode 目录：{model}"));
        };
        if !variant.is_empty() && !entry.variants.iter().any(|v| v == &variant) {
            return Err(format!(
                "模型 {model} 不支持 variant {variant}；可用：{}",
                if entry.variants.is_empty() {
                    "默认".to_string()
                } else {
                    entry.variants.join(", ")
                }
            ));
        }
        state.roles.insert(
            role.clone(),
            OcRole {
                model,
                variant,
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
            let model = selector(&role)?;
            let session_id = create_session(&cwd_path, "Orzic Fusion")?;
            let run = run_agent(
                &cwd_path,
                &session_id,
                "plan",
                &model,
                &plan_prompt(&task),
                false,
                "规划",
            )?;
            let mut state = load_state();
            state.sessions.insert(
                key.clone(),
                OcSession {
                    id: session_id,
                    cwd: cwd.clone(),
                    task,
                    phase: "planned".to_string(),
                    plan: run["text"].as_str().unwrap_or("").to_string(),
                    plan_model: role.model,
                    plan_variant: role.variant,
                    execution: String::new(),
                    execution_model: String::new(),
                    execution_variant: String::new(),
                    updated_at: now_ms(),
                },
            );
            save_state(&state)?;
        }
        "execute" => {
            let mut state = load_state();
            let mut session = state
                .sessions
                .get(&key)
                .cloned()
                .ok_or("当前工作区没有 Fusion 创建的规划会话")?;
            if provided_session.is_empty() || provided_session != session.id {
                return Err("会话 ID 与当前工作区不匹配；请重新规划".into());
            }
            if session.phase != "planned" {
                return Err("当前会话没有待确认的规划，不能进入执行".into());
            }
            let role = state.roles.get("execute").cloned().unwrap_or_default();
            let model = selector(&role)?;
            let run = run_agent(
                &cwd_path,
                &session.id,
                "build",
                &model,
                execute_prompt(),
                false,
                "执行",
            )?;
            session.phase = "executed".to_string();
            session.execution = run["text"].as_str().unwrap_or("").to_string();
            session.execution_model = role.model;
            session.execution_variant = role.variant;
            session.updated_at = now_ms();
            state.sessions.insert(key.clone(), session);
            save_state(&state)?;
        }
        "review" => {
            let state = load_state();
            let role = state.roles.get("review").cloned().unwrap_or_default();
            let model = selector(&role)?;
            ensure_review_agent()?;
            let (plan, diff, files) = acceptance::collect_review_input(&cwd)?;
            if diff.trim().is_empty() {
                let result = json!({
                    "verdict": "skip",
                    "findings": [],
                    "summary": "工作区没有可验收的改动",
                    "cwd": key,
                    "host": "opencode",
                    "model": role.model,
                    "variant": role.variant,
                    "files": 0,
                    "diffChars": 0,
                    "at": now_ms(),
                });
                let mut state = load_state();
                state.reviews.insert(key.clone(), result);
                save_state(&state)?;
                return Ok(status(&cwd, false));
            }
            let review_id = format!("ses_fusion_review_{}", now_ms());
            let run = run_agent(
                &cwd_path,
                &review_id,
                "fusion-review",
                &model,
                &acceptance::build_review_prompt(&plan, &diff),
                true,
                "验收",
            )?;
            let parsed = acceptance::parse_review_text(run["text"].as_str().unwrap_or(""))?;
            let result = json!({
                "verdict": parsed["verdict"],
                "findings": parsed["findings"],
                "summary": parsed["summary"],
                "cwd": key,
                "host": "opencode",
                "model": role.model,
                "variant": role.variant,
                "sessionId": review_id,
                "files": files,
                "diffChars": diff.chars().count(),
                "durationMs": run["durationMs"],
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
        other => return Err(format!("不支持的 OpenCode 会话动作：{other}")),
    }
    Ok(status(&cwd, false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_model_variants_and_costs() {
        let value = json!({
            "data": [
                {
                    "id": "auto/deepseek-v4.1-flash",
                    "modelID": "auto/deepseek-v4.1-flash",
                    "providerID": "magpie",
                    "name": "DeepSeek",
                    "variants": [{"id":"none"},{"id":"low"},{"id":"high"}],
                    "limit": {"context": 1000000, "output": 128000},
                    "cost": [{"input": 0.15, "output": 0.6}]
                },
                {
                    "id": "big-pickle",
                    "providerID": "opencode",
                    "name": "Big Pickle",
                    "variants": [],
                    "limit": {"context": 200000, "output": 32000},
                    "cost": [{"input": 0, "output": 0}]
                }
            ]
        });
        let models = parse_models(&value);
        assert_eq!(models.len(), 2);
        let magpie = models.iter().find(|m| m.provider == "magpie").unwrap();
        assert_eq!(magpie.selector, "magpie/auto/deepseek-v4.1-flash");
        assert_eq!(magpie.variants, vec!["none", "low", "high"]);
        assert_eq!(magpie.context_window, 1_000_000);
        assert_eq!(magpie.cost_output, 0.6);
        let opencode = models.iter().find(|m| m.provider == "opencode").unwrap();
        assert_eq!(opencode.selector, "opencode/big-pickle");
    }

    #[test]
    fn parses_run_text_and_finish() {
        let stdout = concat!(
            "{\"type\":\"text\",\"part\":{\"text\":\"OK\"}}\n",
            "{\"type\":\"step_finish\",\"part\":{\"reason\":\"stop\",\"cost\":0.01,\"tokens\":{\"input\":10,\"output\":2}}}\n"
        );
        let result = parse_run_output(stdout, "ses_test", Duration::from_millis(5)).unwrap();
        assert_eq!(result["text"], "OK");
        assert_eq!(result["status"], "stop");
        assert_eq!(result["cost"], 0.01);
        assert_eq!(result["tokens"]["output"], 2);
    }

    #[test]
    fn rejects_empty_run_text() {
        let err = parse_run_output("", "ses_test", Duration::from_millis(5)).unwrap_err();
        assert!(err.contains("没有返回文本"));
    }

    #[test]
    fn selector_uses_hash_variant() {
        let role = OcRole {
            model: "magpie/auto/deepseek-v4.1-flash".into(),
            variant: "high".into(),
        };
        assert_eq!(
            selector(&role).unwrap(),
            "magpie/auto/deepseek-v4.1-flash#high"
        );
    }

    #[test]
    fn review_agent_marker_is_present() {
        assert!(review_agent_content().contains(REVIEW_MARKER));
        assert!(review_agent_content().contains("effect: deny"));
    }
}
