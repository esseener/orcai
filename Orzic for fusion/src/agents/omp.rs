use crate::config::{self, models_cache_file, omp_agent_dir};
use crate::roles;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::env;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Serializes OMP config writes from the UI and the MCP server. OMP's CLI has
/// no transaction across several `config set` calls, so at least keep our own
/// read-modify-write cycles from interleaving.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub selector: String,
    pub name: String,
    pub provider: String,
    #[serde(default)]
    pub thinking: Vec<String>,
    #[serde(default)]
    pub reasoning: bool,
    #[serde(default)]
    pub context_window: u64,
    #[serde(default)]
    pub max_tokens: u64,
    #[serde(default)]
    pub cost_input: f64,
    #[serde(default)]
    pub cost_output: f64,
}

pub fn find_executable() -> String {
    if let Ok(path) = env::var("ORZIC_OMP_BIN") {
        if !path.trim().is_empty() {
            return path;
        }
    }
    let names: &[&str] = if cfg!(windows) {
        &["omp.exe", "omp.cmd", "omp.bat", "omp"]
    } else {
        &["omp"]
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
    // Explorer launches inherit a narrower PATH than a terminal.
    let mut fallbacks = vec![
        config::home_dir().join(".bun").join("bin").join(if cfg!(windows) {
            "omp.exe"
        } else {
            "omp"
        }),
        config::appdata_dir().join("npm").join(if cfg!(windows) {
            "omp.cmd"
        } else {
            "omp"
        }),
    ];
    fallbacks.retain(|p| p.is_file());
    if let Some(p) = fallbacks.into_iter().next() {
        return p.to_string_lossy().to_string();
    }
    if cfg!(windows) {
        "omp.exe".to_string()
    } else {
        "omp".to_string()
    }
}

fn command() -> Command {
    let mut cmd = Command::new(find_executable());
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn run_plain(args: &[&str]) -> Result<String, String> {
    let exe = find_executable();
    let out = command()
        .args(args)
        .output()
        .map_err(|e| format!("无法运行 OMP ({exe}): {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "OMP {} 执行失败 (code {:?}): {}",
            args.join(" "),
            out.status.code(),
            stderr.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn run_json(args: &[&str]) -> Result<Value, String> {
    let text = run_plain(&args.iter().copied().chain(["--json"]).collect::<Vec<_>>())?;
    serde_json::from_str::<Value>(text.trim())
        .map_err(|e| format!("OMP {} 输出无法解析 JSON: {e}", args.join(" ")))
}

fn version() -> Option<String> {
    run_plain(&["--version"])
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

pub(crate) fn config_snapshot() -> Result<Map<String, Value>, String> {
    let raw = run_json(&["config", "list"])?;
    Ok(raw.as_object().cloned().unwrap_or_default())
}

pub(crate) fn entry_value<'a>(cfg: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    cfg.get(key).and_then(|entry| entry.get("value"))
}

fn thinking_list(value: Option<&Value>) -> Vec<String> {
    let raw = match value {
        Some(Value::Array(items)) => Some(items),
        Some(Value::Object(obj)) => obj.get("efforts").and_then(Value::as_array),
        _ => None,
    };
    raw.map(|items| {
        items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect()
    })
    .unwrap_or_default()
}

fn parse_model_rows(raw: Option<&Value>) -> Vec<ModelInfo> {
    let Some(Value::Array(rows)) = raw else {
        return Vec::new();
    };
    let mut models = Vec::new();
    for row in rows {
        let Some(obj) = row.as_object() else {
            continue;
        };
        let selector = obj
            .get("selector")
            .and_then(Value::as_str)
            .or_else(|| obj.get("id").and_then(Value::as_str))
            .map(str::trim)
            .unwrap_or("");
        if selector.is_empty() {
            continue;
        }
        let provider = obj
            .get("provider")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| selector.split('/').next().unwrap_or("omp").to_string());
        let name = obj
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| selector.to_string());
        let cost = obj.get("cost");
        models.push(ModelInfo {
            selector: selector.to_string(),
            name,
            provider,
            thinking: thinking_list(obj.get("thinking")),
            reasoning: obj
                .get("reasoning")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            context_window: obj
                .get("contextWindow")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            max_tokens: obj.get("maxTokens").and_then(Value::as_u64).unwrap_or(0),
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
    models
}

fn parse_cached_models(raw: Option<&Value>) -> Vec<ModelInfo> {
    let Some(Value::Array(rows)) = raw else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| serde_json::from_value::<ModelInfo>(row.clone()).ok())
        .collect()
}

/// Reads the local cache first; `force` re-runs `omp models ls` (~2s).
/// Bump `MODELS_CACHE_VERSION` when the cached shape changes so old caches
/// (without cost/context fields) are refreshed once.
const MODELS_CACHE_VERSION: u64 = 2;
const MODELS_CACHE_TTL_MS: u64 = 5 * 60 * 1000;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn list_models(force: bool) -> Result<Vec<ModelInfo>, String> {
    let cache_path = models_cache_file();
    if !force {
        if let Ok(cached) = config::read_json(&cache_path) {
            let version = cached.get("v").and_then(Value::as_u64);
            let fresh = cached
                .get("at")
                .and_then(Value::as_u64)
                .map(|at| now_ms().saturating_sub(at) < MODELS_CACHE_TTL_MS)
                .unwrap_or(false);
            let models = parse_cached_models(cached.get("models"));
            if version == Some(MODELS_CACHE_VERSION) && fresh && !models.is_empty() {
                return Ok(models);
            }
        }
    }
    let receipt = run_json(&["models", "ls"])?;
    let models = parse_model_rows(receipt.get("models"));
    if models.is_empty() {
        return Err("OMP 未返回任何模型".into());
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let _ = config::write_text_atomic(
        &cache_path,
        &serde_json::to_string(&json!({
            "v": MODELS_CACHE_VERSION,
            "at": now,
            "models": &models
        }))
        .unwrap_or_default(),
        None,
    );
    Ok(models)
}

/// Thin wrappers used by the routing layer and the OMP extension installer.
pub fn cli_json(args: &[&str]) -> Result<Value, String> {
    run_json(args)
}

pub fn cli_plain(args: &[&str]) -> Result<String, String> {
    run_plain(args)
}

pub fn known_selectors(models: &[ModelInfo]) -> BTreeSet<String> {
    models.iter().map(|m| m.selector.clone()).collect()
}

pub fn config_path() -> PathBuf {
    omp_agent_dir().join("config.yml")
}

pub fn read_status() -> Value {
    let mut error: Option<String> = None;
    let cfg = match config_snapshot() {
        Ok(cfg) => cfg,
        Err(e) => {
            error = Some(e);
            Map::new()
        }
    };
    let models = list_models(false).unwrap_or_default();
    let known = known_selectors(&models);
    let roles = roles::parse_roles(entry_value(&cfg, "modelRoles"), &known);

    json!({
        "executable": find_executable(),
        "version": version(),
        "agentDir": omp_agent_dir().to_string_lossy(),
        "configPath": config_path().to_string_lossy(),
        "modelsCount": models.len(),
        "error": error,
        "roles": roles,
        "thinkingLevels": roles::THINKING_LEVELS,
        "defaultThinkingLevel": entry_value(&cfg, "defaultThinkingLevel")
            .cloned()
            .unwrap_or(Value::String("high".into())),
        "flags": {
            "planEnabled": entry_value(&cfg, "plan.enabled").and_then(Value::as_bool).unwrap_or(false),
            "advisorEnabled": entry_value(&cfg, "advisor.enabled").and_then(Value::as_bool).unwrap_or(false),
            "taskPrewalk": entry_value(&cfg, "task.prewalk").and_then(Value::as_bool).unwrap_or(false),
        },
    })
}

/// Applies a console/MCP patch. Shape:
/// `{ "roles": {"plan": {"model": "...", "thinking": "high"}},
///    "flags": {"planEnabled": true, ...},
///    "defaultThinkingLevel": "xhigh" }`
pub fn save(patch: &Map<String, Value>) -> Result<Value, String> {
    let _guard = WRITE_LOCK
        .lock()
        .map_err(|_| "OMP 写入锁不可用".to_string())?;
    let cfg = config_snapshot()?;

    if let Some(Value::Object(edits)) = patch.get("roles") {
        let current = entry_value(&cfg, "modelRoles")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let mut list = Vec::new();
        for (role, edit) in edits {
            let model = edit
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let thinking = edit
                .get("thinking")
                .and_then(Value::as_str)
                .filter(|t| !t.trim().is_empty())
                .map(str::to_string);
            list.push((role.clone(), model, thinking));
        }
        let merged = roles::merge_roles(&current, &list)?;
        if merged != current {
            let encoded =
                serde_json::to_string(&Value::Object(merged)).map_err(|e| e.to_string())?;
            run_plain(&["config", "set", "modelRoles", &encoded])?;
        }
    }

    if let Some(flags) = patch.get("flags").and_then(Value::as_object) {
        for (field, key) in [
            ("planEnabled", "plan.enabled"),
            ("advisorEnabled", "advisor.enabled"),
            ("taskPrewalk", "task.prewalk"),
        ] {
            if let Some(value) = flags.get(field).and_then(Value::as_bool) {
                if entry_value(&cfg, key).and_then(Value::as_bool) != Some(value) {
                    run_plain(&[
                        "config",
                        "set",
                        key,
                        if value { "true" } else { "false" },
                    ])?;
                }
            }
        }
    }

    if let Some(level) = patch
        .get("defaultThinkingLevel")
        .and_then(Value::as_str)
        .filter(|l| !l.trim().is_empty())
    {
        if !roles::is_thinking_level(level) {
            return Err(format!("未知思考强度：{level}"));
        }
        if entry_value(&cfg, "defaultThinkingLevel").and_then(Value::as_str) != Some(level) {
            run_plain(&["config", "set", "defaultThinkingLevel", level])?;
        }
    }

    Ok(read_status())
}

/// Resolves the selector a given fusion mode should use. This is the contract
/// other agents will consume once they have adapters; for now it projects
/// OMP's `modelRoles`.
pub fn resolve_mode(mode: &str) -> Value {
    let status = read_status();
    let roles = status["roles"].as_array().cloned().unwrap_or_default();
    let find = |role: &str| roles.iter().find(|r| r["role"] == role).cloned();
    let (role, picked) = match mode {
        "plan" => ("plan", find("plan").or_else(|| find("default"))),
        "execute" => ("default", find("default")),
        "review" => (
            "advisor",
            find("advisor").or_else(|| find("review")).or_else(|| find("default")),
        ),
        "smol" => ("smol", find("smol")),
        "slow" => ("slow", find("slow")),
        other => {
            return json!({ "error": format!("未知模式：{other}"), "mode": other });
        }
    };
    match picked {
        Some(view) => json!({
            "mode": mode,
            "role": role,
            "selector": view["raw"],
            "model": view["model"],
            "thinking": view["thinking"],
        }),
        None => json!({
            "mode": mode,
            "role": role,
            "selector": null,
            "model": null,
            "thinking": null,
            "note": "该角色尚未配置",
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_thinking_arrays_and_effort_objects() {
        let raw = json!({
            "models": [
                {"provider": "devin", "selector": "devin/swe-2", "name": "SWE 2",
                 "thinking": ["low", "high"], "reasoning": true,
                 "contextWindow": 200000, "maxTokens": 64000,
                 "cost": {"input": 3, "output": 15}},
                {"provider": "magpie", "selector": "magpie/x", "name": "X",
                 "thinking": {"mode": "effort", "efforts": ["low", "max"]}},
                {"provider": "magpie", "selector": "magpie/y", "thinking": null}
            ]
        });
        let models = parse_model_rows(raw.get("models"));
        assert_eq!(models.len(), 3);
        assert_eq!(models[0].thinking, vec!["low", "high"]);
        assert_eq!(models[0].context_window, 200_000);
        assert_eq!(models[0].max_tokens, 64_000);
        assert_eq!(models[0].cost_input, 3.0);
        assert_eq!(models[0].cost_output, 15.0);
        assert_eq!(models[1].thinking, vec!["low", "max"]);
        assert!(models[2].thinking.is_empty());
        assert!(models[0].reasoning);
        assert!(!models[2].reasoning);
        assert_eq!(models[2].context_window, 0);
    }

    #[test]
    fn cached_models_keep_cost_fields() {
        let raw = json!({
            "v": 2,
            "models": [{
                "selector": "a/b", "name": "B", "provider": "a",
                "thinking": [], "reasoning": true,
                "contextWindow": 1000, "maxTokens": 10,
                "costInput": 0.5, "costOutput": 2.0
            }]
        });
        let models = parse_cached_models(raw.get("models"));
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].cost_input, 0.5);
        assert_eq!(models[0].cost_output, 2.0);
        assert_eq!(models[0].context_window, 1000);
    }

    #[test]
    fn skips_rows_without_selector() {
        let raw = json!({"models": [{"name": "no id"}, {"selector": "a/b"}]});
        let models = parse_model_rows(raw.get("models"));
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].selector, "a/b");
        assert_eq!(models[0].provider, "a");
    }
}
