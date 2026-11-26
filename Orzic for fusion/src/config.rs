use serde_json::Value;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn home_dir() -> PathBuf {
    if let Ok(h) = env::var("USERPROFILE") {
        if !h.trim().is_empty() {
            return PathBuf::from(h);
        }
    }
    if let Ok(h) = env::var("HOME") {
        if !h.trim().is_empty() {
            return PathBuf::from(h);
        }
    }
    PathBuf::from(".")
}

pub fn appdata_dir() -> PathBuf {
    if let Ok(p) = env::var("APPDATA") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    home_dir().join("AppData").join("Roaming")
}

/// OMP's agent directory. `ORZIC_AGENT_DIR` is an explicit override used by
/// tests and by users with a non-default profile.
pub fn omp_agent_dir() -> PathBuf {
    if let Ok(p) = env::var("ORZIC_AGENT_DIR") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    home_dir().join(".omp").join("agent")
}

pub fn omp_mcp_file() -> PathBuf {
    omp_agent_dir().join("mcp.json")
}

pub fn models_cache_file() -> PathBuf {
    omp_agent_dir().join("orzic-fusion-models.json")
}

pub fn custom_targets_file() -> PathBuf {
    omp_agent_dir().join("orzic-fusion-targets.json")
}

/// OpenCode's global config. v2 resolves this file first; `opencode.jsonc`
/// beside it is deliberately not edited because serde round-trips would drop
/// comments and trailing commas.
pub fn opencode_config_path() -> PathBuf {
    home_dir()
        .join(".config")
        .join("opencode")
        .join("opencode.json")
}

pub fn opencode_agents_dir() -> PathBuf {
    home_dir()
        .join(".config")
        .join("opencode")
        .join("agents")
}

pub fn opencode_state_file() -> PathBuf {
    omp_agent_dir().join("orzic-fusion-opencode.json")
}

pub fn opencode_models_cache_file() -> PathBuf {
    omp_agent_dir().join("orzic-fusion-opencode-models.json")
}

/// Codex stores its global config under `$CODEX_HOME` (default `~/.codex`).
pub fn codex_home_dir() -> PathBuf {
    if let Ok(p) = env::var("CODEX_HOME") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    home_dir().join(".codex")
}

pub fn codex_config_path() -> PathBuf {
    codex_home_dir().join("config.toml")
}

pub fn codex_state_file() -> PathBuf {
    omp_agent_dir().join("orzic-fusion-codex.json")
}

pub fn codex_models_cache_file() -> PathBuf {
    omp_agent_dir().join("orzic-fusion-codex-models.json")
}

pub fn backup_dir_for(config_path: &Path) -> PathBuf {
    config_path
        .parent()
        .map(|p| p.join("orzic-backup"))
        .unwrap_or_else(|| omp_agent_dir().join("orzic-backup"))
}

pub fn read_json(path: &Path) -> Result<Value, String> {
    let raw =
        fs::read_to_string(path).map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("{} 不是合法 JSON: {e}", path.display()))
}

pub fn write_text_atomic(
    path: &Path,
    text: &str,
    backup_dir: Option<&Path>,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建目录 {}: {e}", parent.display()))?;
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    if let Some(bdir) = backup_dir {
        if path.exists() {
            fs::create_dir_all(bdir)
                .map_err(|e| format!("无法创建备份目录 {}: {e}", bdir.display()))?;
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("config");
            let bpath = bdir.join(format!("{name}.{stamp}.bak"));
            fs::copy(path, &bpath)
                .map_err(|e| format!("备份 {} 失败: {e}", path.display()))?;
        }
    }
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("config");
    let tmp = path.with_file_name(format!("{file_name}.{}.{stamp}.tmp", std::process::id()));
    fs::write(&tmp, text.as_bytes())
        .map_err(|e| format!("写入临时文件 {} 失败: {e}", tmp.display()))?;
    if let Err(e) = fs::rename(&tmp, path) {
        // Windows cannot rename over an existing file; retry once after removal.
        if path.exists() {
            let _ = fs::remove_file(path);
            if fs::rename(&tmp, path).is_ok() {
                return Ok(());
            }
        }
        let _ = fs::remove_file(&tmp);
        return Err(format!("原子替换 {} 失败: {e}", path.display()));
    }
    Ok(())
}
