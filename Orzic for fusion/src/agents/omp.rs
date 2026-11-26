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
    // The `/gogo` launcher sits first on PATH; internal calls want the real
    // omp, without paying for a wrapper process on every config read.
    let shim = crate::route::omp_shim_dir();
    if let Some(paths) = env::var_os("PATH") {
        for dir in env::split_paths(&paths) {
            if shim.as_ref().is_some_and(|shim| shim == &dir) {
                continue;
            }
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

static VERSION_CACHE: Mutex<Option<(u64, String)>> = Mutex::new(None);
const VERSION_TTL_MS: u64 = 60_000;

/// `omp --version` spawns a process; it only changes on upgrade.
fn version() -> Option<String> {
    if let Ok(guard) = VERSION_CACHE.lock() {
        if let Some((at, value)) = guard.as_ref() {
            if now_ms().saturating_sub(*at) < VERSION_TTL_MS {
                return Some(value.clone());
            }
        }
    }
    let value = run_plain(&["--version"])
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())?;
    if let Ok(mut guard) = VERSION_CACHE.lock() {
        *guard = Some((now_ms(), value.clone()));
    }
    Some(value)
}

pub(crate) fn config_snapshot() -> Result<Map<String, Value>, String> {
    let raw = run_json(&["config", "list"])?;
    Ok(raw.as_object().cloned().unwrap_or_default())
}

/// `omp config list` costs ~1.6s per call. The console reads status far more
/// often than the config changes, so keep a short-lived in-memory snapshot plus
/// a disk snapshot keyed by `config.yml`'s mtime. A process restart then paints
/// from the last known-good config as long as the file is untouched.
static CONFIG_CACHE: Mutex<Option<(u64, u64, Map<String, Value>)>> = Mutex::new(None);
const CONFIG_CACHE_TTL_MS: u64 = 15_000;
const CONFIG_DISK_TTL_MS: u64 = 10 * 60 * 1000;
const CONFIG_DISK_VERSION: u64 = 1;

/// Remember a config alongside the `config.yml` mtime it was read or written
/// at, so an external edit invalidates it immediately instead of waiting out
/// the TTL.
fn remember_config(cfg: &Map<String, Value>) {
    let mtime = config_mtime_ms().unwrap_or(0);
    if let Ok(mut guard) = CONFIG_CACHE.lock() {
        *guard = Some((now_ms(), mtime, cfg.clone()));
    }
}

fn config_snapshot_file() -> PathBuf {
    omp_agent_dir().join("orzic-fusion-config-snapshot.json")
}

fn config_mtime_ms() -> Option<u64> {
    std::fs::metadata(config_path())
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

fn write_config_snapshot(cfg: &Map<String, Value>) {
    let Some(mtime) = config_mtime_ms() else {
        return;
    };
    let text = json!({
        "v": CONFIG_DISK_VERSION,
        "mtime": mtime,
        "at": now_ms(),
        "config": cfg,
    })
    .to_string();
    let _ = config::write_text_atomic(&config_snapshot_file(), &text, None);
}

fn read_config_snapshot() -> Option<Map<String, Value>> {
    let cached = config::read_json(&config_snapshot_file()).ok()?;
    if cached.get("v").and_then(Value::as_u64) != Some(CONFIG_DISK_VERSION) {
        return None;
    }
    let fresh = cached
        .get("at")
        .and_then(Value::as_u64)
        .map(|at| now_ms().saturating_sub(at) < CONFIG_DISK_TTL_MS)
        .unwrap_or(false);
    if !fresh || cached.get("mtime").and_then(Value::as_u64) != config_mtime_ms() {
        return None;
    }
    cached.get("config")?.as_object().cloned()
}

pub(crate) fn config_snapshot_cached(force: bool) -> Result<Map<String, Value>, String> {
    if !force {
        let mtime = config_mtime_ms();
        if let Ok(guard) = CONFIG_CACHE.lock() {
            if let Some((at, cached_mtime, cfg)) = guard.as_ref() {
                if now_ms().saturating_sub(*at) < CONFIG_CACHE_TTL_MS
                    && Some(*cached_mtime) == mtime
                {
                    return Ok(cfg.clone());
                }
            }
        }
        if let Some(cfg) = read_config_snapshot() {
            remember_config(&cfg);
            return Ok(cfg);
        }
    }
    let cfg = config_snapshot()?;
    remember_config(&cfg);
    write_config_snapshot(&cfg);
    Ok(cfg)
}

/// Same disk snapshot as `config_snapshot_cached`, but without the in-memory
/// TTL: a write path must not merge into a copy that an external edit has
/// already outdated. The snapshot is still keyed by `config.yml`'s mtime, so a
/// stale file falls through to a real `omp config list`.
pub(crate) fn config_snapshot_verified() -> Result<Map<String, Value>, String> {
    if let Some(cfg) = read_config_snapshot() {
        remember_config(&cfg);
        return Ok(cfg);
    }
    let cfg = config_snapshot()?;
    remember_config(&cfg);
    write_config_snapshot(&cfg);
    Ok(cfg)
}

fn set_entry(cfg: &mut Map<String, Value>, key: &str, value: Value) {
    match cfg.get_mut(key).and_then(Value::as_object_mut) {
        Some(entry) => {
            entry.insert("value".to_string(), value);
        }
        None => {
            cfg.insert(key.to_string(), json!({ "value": value }));
        }
    }
}

/// Any cached model directory, regardless of TTL. Fast status uses it so the
/// form can render real role labels while a stale cache refreshes in the
/// background.
fn cached_models_any() -> Option<Vec<ModelInfo>> {
    let cached = config::read_json(&models_cache_file()).ok()?;
    if cached.get("v").and_then(Value::as_u64) != Some(MODELS_CACHE_VERSION) {
        return None;
    }
    let models = parse_cached_models(cached.get("models"));
    if models.is_empty() {
        None
    } else {
        Some(models)
    }
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

fn status_payload(
    cfg: &Map<String, Value>,
    models: Vec<ModelInfo>,
    version: Option<String>,
    models_pending: bool,
    error: Option<String>,
) -> Value {
    let known = known_selectors(&models);
    let roles = roles::parse_roles(entry_value(cfg, "modelRoles"), &known);

    json!({
        "executable": find_executable(),
        "version": version,
        "versionPending": version.is_none(),
        "modelsPending": models_pending,
        "agentDir": omp_agent_dir().to_string_lossy(),
        "configPath": config_path().to_string_lossy(),
        "modelsCount": models.len(),
        "error": error,
        "roles": roles,
        "thinkingLevels": roles::THINKING_LEVELS,
        "defaultThinkingLevel": entry_value(cfg, "defaultThinkingLevel")
            .cloned()
            .unwrap_or(Value::String("high".into())),
        "flags": {
            "planEnabled": entry_value(cfg, "plan.enabled").and_then(Value::as_bool).unwrap_or(false),
            "advisorEnabled": entry_value(cfg, "advisor.enabled").and_then(Value::as_bool).unwrap_or(false),
            "taskPrewalk": entry_value(cfg, "task.prewalk").and_then(Value::as_bool).unwrap_or(false),
        },
    })
}

fn status_from_cfg(cfg: Result<Map<String, Value>, String>) -> (Map<String, Value>, Option<String>) {
    match cfg {
        Ok(cfg) => (cfg, None),
        Err(e) => (Map::new(), Some(e)),
    }
}

/// Status for the console. `fast` uses only the short-lived config snapshot
/// and whatever model cache exists, starting no subprocess, so the form can
/// paint at once. The full call refreshes the model directory and version.
pub fn console_status(fast: bool, force: bool) -> Value {
    let (cfg, error) = status_from_cfg(config_snapshot_cached(force));
    let (models, pending) = if fast {
        match cached_models_any() {
            Some(models) => (models, false),
            None => (Vec::new(), true),
        }
    } else {
        (list_models(false).unwrap_or_default(), false)
    };
    let version = if fast { None } else { version() };
    let omp = status_payload(&cfg, models.clone(), version, pending, error);
    json!({ "omp": omp, "models": models })
}

pub fn read_status() -> Value {
    let (cfg, error) = status_from_cfg(config_snapshot_cached(false));
    let models = list_models(false).unwrap_or_default();
    status_payload(&cfg, models, version(), false, error)
}

/// Applies a console/MCP patch. Shape:
/// `{ "roles": {"plan": {"model": "...", "thinking": "high"}},
///    "flags": {"planEnabled": true, ...},
///    "defaultThinkingLevel": "xhigh" }`
pub fn save(patch: &Map<String, Value>) -> Result<Value, String> {
    let _guard = WRITE_LOCK
        .lock()
        .map_err(|_| "OMP 写入锁不可用".to_string())?;
    let mut cfg = config_snapshot_verified()?;
    let mut changed = false;

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
                serde_json::to_string(&Value::Object(merged.clone())).map_err(|e| e.to_string())?;
            run_plain(&["config", "set", "modelRoles", &encoded])?;
            set_entry(&mut cfg, "modelRoles", Value::Object(merged));
            changed = true;
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
                    set_entry(&mut cfg, key, json!(value));
                    changed = true;
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
            set_entry(&mut cfg, "defaultThinkingLevel", json!(level));
            changed = true;
        }
    }

    if changed {
        write_config_snapshot(&cfg);
        remember_config(&cfg);
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
