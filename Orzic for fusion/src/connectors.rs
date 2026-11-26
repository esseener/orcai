use crate::agents::codex;
use crate::config::{
    appdata_dir, backup_dir_for, codex_config_path, custom_targets_file, home_dir, omp_mcp_file,
    opencode_config_path, read_json, write_text_atomic,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::path::{Path, PathBuf};

pub const SERVER_NAME: &str = "fusion";

pub fn current_exe_string() -> String {
    if let Ok(exe) = env::var("ORZIC_FUSION_EXE") {
        if !exe.trim().is_empty() {
            return exe;
        }
    }
    env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "orzic-fusion.exe".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomTarget {
    pub id: String,
    pub label: String,
    pub config_path: String,
    #[serde(default = "default_server_name")]
    pub server_name: String,
}

fn default_server_name() -> String {
    SERVER_NAME.to_string()
}

pub struct BuiltinTarget {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: &'static str,
    pub path: PathBuf,
    pub format: &'static str,
}

pub const FORMAT_MCP_SERVERS: &str = "mcpServers";
pub const FORMAT_OPENCODE: &str = "opencode";
pub const FORMAT_CODEX: &str = "codex";

/// OMP and the desktop/CLI targets use `mcpServers`; OpenCode v2 normalizes
/// its legacy flat `mcp` map to `mcp.servers`, so it needs its own writer.
pub fn builtin_targets() -> Vec<BuiltinTarget> {
    let home = home_dir();
    let appdata = appdata_dir();
    vec![
        BuiltinTarget {
            id: "omp",
            label: "OMP (oh-my-pi)",
            kind: "Agent CLI · 首选",
            path: omp_mcp_file(),
            format: FORMAT_MCP_SERVERS,
        },
        BuiltinTarget {
            id: "opencode",
            label: "OpenCode",
            kind: "Agent CLI · v2",
            path: opencode_config_path(),
            format: FORMAT_OPENCODE,
        },
        BuiltinTarget {
            id: "codex",
            label: "Codex",
            kind: "Agent CLI · App Server",
            path: codex_config_path(),
            format: FORMAT_CODEX,
        },
        BuiltinTarget {
            id: "claude-desktop",
            label: "Claude Desktop",
            kind: "Desktop App",
            path: appdata.join("Claude").join("claude_desktop_config.json"),
            format: FORMAT_MCP_SERVERS,
        },
        BuiltinTarget {
            id: "cursor",
            label: "Cursor",
            kind: "Desktop IDE",
            path: home.join(".cursor").join("mcp.json"),
            format: FORMAT_MCP_SERVERS,
        },
        BuiltinTarget {
            id: "windsurf",
            label: "Windsurf",
            kind: "Desktop IDE",
            path: home
                .join(".codeium")
                .join("windsurf")
                .join("mcp_config.json"),
            format: FORMAT_MCP_SERVERS,
        },
        BuiltinTarget {
            id: "antigravity",
            label: "Antigravity",
            kind: "Desktop IDE",
            path: home
                .join(".gemini")
                .join("antigravity")
                .join("mcp_config.json"),
            format: FORMAT_MCP_SERVERS,
        },
        BuiltinTarget {
            id: "gemini-cli",
            label: "Gemini CLI",
            kind: "Agent CLI",
            path: home.join(".gemini").join("settings.json"),
            format: FORMAT_MCP_SERVERS,
        },
    ]
}

pub fn load_custom_targets() -> Vec<CustomTarget> {
    let path = custom_targets_file();
    if !path.exists() {
        return Vec::new();
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<CustomTarget>>(&raw).ok())
        .unwrap_or_default()
}

pub fn save_custom_target(target: CustomTarget) -> Result<Vec<CustomTarget>, String> {
    let mut list = load_custom_targets();
    list.retain(|t| t.id != target.id && t.config_path != target.config_path);
    list.push(target);
    write_text_atomic(
        &custom_targets_file(),
        &serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?,
        None,
    )?;
    Ok(list)
}

pub fn remove_custom_target(id: &str) -> Result<Vec<CustomTarget>, String> {
    let mut list = load_custom_targets();
    list.retain(|t| t.id != id);
    write_text_atomic(
        &custom_targets_file(),
        &serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?,
        None,
    )?;
    Ok(list)
}

fn opencode_entry<'a>(value: &'a Value, server_name: &str) -> Option<&'a Value> {
    value
        .get("mcp")
        .and_then(|mcp| mcp.get("servers"))
        .and_then(|servers| servers.get(server_name))
        .or_else(|| {
            value
                .get("mcp")
                .and_then(|mcp| mcp.get(server_name))
        })
}

fn codex_env_for(path: &Path) -> Vec<(&'static str, String)> {
    let home = path
        .parent()
        .map(|parent| parent.to_string_lossy().to_string())
        .unwrap_or_default();
    vec![("CODEX_HOME", home)]
}

fn codex_mcp_get(path: &Path, server_name: &str) -> Result<Option<Value>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let envs = codex_env_for(path);
    match codex::run_cli(&["mcp", "get", server_name, "--json"], None, &envs) {
        Ok(raw) => {
            let value = serde_json::from_str::<Value>(raw.trim())
                .map_err(|e| format!("Codex MCP 状态不是合法 JSON: {e}"))?;
            Ok(Some(value))
        }
        Err(error) => {
            let lower = error.to_ascii_lowercase();
            if lower.contains("no mcp server")
                || lower.contains("not found")
                || lower.contains("does not exist")
            {
                Ok(None)
            } else {
                Err(error)
            }
        }
    }
}

fn codex_mcp_write(path: &Path, args: &[&str]) -> Result<(), String> {
    let envs = codex_env_for(path);
    codex::run_cli(args, None, &envs).map(|_| ())
}

fn backup_codex_config(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let dir = backup_dir_for(path);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("无法创建 Codex 备份目录 {}: {e}", dir.display()))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let target = dir.join(format!("config-{stamp}.toml"));
    std::fs::copy(path, &target)
        .map_err(|e| format!("备份 Codex 配置失败 {}: {e}", target.display()))?;
    Ok(())
}

fn codex_transport<'a>(value: &'a Value) -> Option<&'a Value> {
    value.get("transport")
}

fn is_fusion_codex_entry(value: &Value, server_name: &str) -> bool {
    if server_name != SERVER_NAME {
        return false;
    }
    let Some(transport) = codex_transport(value) else {
        return false;
    };
    if transport.get("type").and_then(Value::as_str) != Some("stdio") {
        return false;
    }
    let Some(command) = transport.get("command").and_then(Value::as_str) else {
        return false;
    };
    let Some(args) = transport.get("args").and_then(Value::as_array) else {
        return false;
    };
    if !args.iter().any(|arg| arg.as_str() == Some("mcp")) {
        return false;
    }
    Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_ascii_lowercase().starts_with("orzic-fusion"))
        .unwrap_or(false)
}

fn codex_entry_matches(value: &Value, exe: &str) -> bool {
    let Some(transport) = codex_transport(value) else {
        return false;
    };
    let command = transport
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or("");
    let args = transport
        .get("args")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    command.eq_ignore_ascii_case(exe)
        && args.len() == 1
        && args[0].as_str() == Some("mcp")
}

/// Codex owns its config and has a native `mcp add/remove` command. Using it
/// avoids a second TOML writer and preserves unrelated tables, comments, and
/// formatting. We only update an entry that is demonstrably Fusion's own.
pub fn connect_codex(
    config_path: &Path,
    server_name: &str,
    exe: &str,
    enable: bool,
) -> Result<(), String> {
    let existing = codex_mcp_get(config_path, server_name)?;
    if enable {
        if let Some(entry) = &existing {
            if !is_fusion_codex_entry(entry, server_name) {
                return Err(format!(
                    "{} 中已存在名为 {} 的非 Fusion 条目，拒绝覆盖",
                    config_path.display(),
                    server_name
                ));
            }
            if codex_entry_matches(entry, exe) {
                return Ok(());
            }
            backup_codex_config(config_path)?;
            codex_mcp_write(config_path, &["mcp", "remove", server_name])?;
        } else {
            backup_codex_config(config_path)?;
        }
        codex_mcp_write(config_path, &["mcp", "add", server_name, "--", exe, "mcp"])
    } else {
        let Some(entry) = &existing else {
            return Ok(());
        };
        if !is_fusion_codex_entry(entry, server_name) {
            return Err(format!(
                "{} 中的 {} 不是 Fusion 条目，拒绝删除",
                config_path.display(),
                server_name
            ));
        }
        backup_codex_config(config_path)?;
        codex_mcp_write(config_path, &["mcp", "remove", server_name])
    }
}

fn inspect(path: &Path, server_name: &str, format: &str) -> (bool, bool, Option<String>) {
    if !path.exists() {
        return (false, false, None);
    }
    if format == FORMAT_CODEX {
        return match codex_mcp_get(path, server_name) {
            Ok(Some(entry)) => {
                let owned = is_fusion_codex_entry(&entry, server_name);
                (
                    true,
                    true,
                    if owned {
                        None
                    } else {
                        Some(format!(
                            "{} 中的 {} 不是 Fusion 条目；连接时拒绝覆盖",
                            path.display(),
                            server_name
                        ))
                    },
                )
            }
            Ok(None) => (true, false, None),
            Err(error) => (true, false, Some(error)),
        };
    }
    match read_json(path) {
        Ok(value) => {
            let connected = if format == FORMAT_OPENCODE {
                let jsonc = path.with_extension("jsonc");
                if jsonc.exists() {
                    return (
                        true,
                        opencode_entry(&value, server_name)
                            .map(Value::is_object)
                            .unwrap_or(false),
                        Some(format!(
                            "检测到 {}；为避免丢失注释，Fusion 只读不写 JSONC",
                            jsonc.display()
                        )),
                    );
                }
                opencode_entry(&value, server_name)
                    .map(Value::is_object)
                    .unwrap_or(false)
            } else {
                value
                    .get("mcpServers")
                    .and_then(|servers| servers.get(server_name))
                    .map(Value::is_object)
                    .unwrap_or(false)
            };
            (true, connected, None)
        }
        Err(e) => (true, false, Some(e)),
    }
}

fn opencode_desired(exe: &str) -> Value {
    json!({
        "type": "local",
        "command": [exe, "mcp"],
        "disabled": false,
    })
}

fn is_fusion_opencode_entry(value: &Value, server_name: &str) -> bool {
    if server_name != SERVER_NAME {
        return false;
    }
    let Some(entry) = value.as_object() else {
        return false;
    };
    if entry.get("type").and_then(Value::as_str) != Some("local") {
        return false;
    }
    let Some(command) = entry.get("command").and_then(Value::as_array) else {
        return false;
    };
    if command.len() < 2 || command[1].as_str() != Some("mcp") {
        return false;
    }
    let Some(exe) = command[0].as_str() else {
        return false;
    };
    Path::new(exe)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_ascii_lowercase().starts_with("orzic-fusion"))
        .unwrap_or(false)
}

/// Registers `fusion` in OpenCode's config. OpenCode v2 accepts the legacy
/// flat `mcp` map and normalizes it to `mcp.servers`; when the file already
/// has a `servers` object, keep that shape. Other MCP servers, provider keys,
/// and non-schema keys such as `enabled` are left untouched.
pub fn connect_opencode(
    config_path: &Path,
    server_name: &str,
    exe: &str,
    enable: bool,
) -> Result<(), String> {
    let jsonc = config_path.with_extension("jsonc");
    if jsonc.exists() {
        return Err(format!(
            "检测到 {}；为避免丢失注释和尾逗号，Fusion 不写 JSONC 配置。请把片段手动加入该文件。",
            jsonc.display()
        ));
    }
    if !config_path.exists() {
        return Err(format!(
            "未找到 OpenCode 配置：{}。请先启动一次 OpenCode 或创建该文件。",
            config_path.display()
        ));
    }
    let mut value = read_json(config_path)?;
    let root = value
        .as_object_mut()
        .ok_or_else(|| format!("{} 的根节点不是 JSON 对象", config_path.display()))?;

    if !enable {
        let Some(mcp) = root.get_mut("mcp").and_then(Value::as_object_mut) else {
            return Ok(());
        };
        let mut changed = false;
        if let Some(servers) = mcp.get_mut("servers").and_then(Value::as_object_mut) {
            changed |= servers.remove(server_name).is_some();
        }
        changed |= mcp.remove(server_name).is_some();
        if changed {
            let text = format!(
                "{}\n",
                serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?
            );
            write_text_atomic(config_path, &text, Some(&backup_dir_for(config_path)))?;
        }
        return Ok(());
    }

    let desired = opencode_desired(exe);
    let mcp = root
        .entry("mcp".to_string())
        .or_insert_with(|| json!({}));
    let mcp = mcp
        .as_object_mut()
        .ok_or_else(|| format!("{} 中的 mcp 不是对象，拒绝覆盖", config_path.display()))?;
    let nested = mcp.get("servers").map(Value::is_object).unwrap_or(false);
    if mcp.get("servers").is_some() && !nested {
        return Err(format!(
            "{} 中的 mcp.servers 不是对象，拒绝覆盖",
            config_path.display()
        ));
    }
    let target = if nested {
        mcp.get_mut("servers")
            .and_then(Value::as_object_mut)
            .unwrap()
    } else {
        mcp
    };
    if let Some(existing) = target.get(server_name) {
        if existing == &desired {
            return Ok(());
        }
        if !is_fusion_opencode_entry(existing, server_name) {
            return Err(format!(
                "{} 中已存在名为 {} 的非 Fusion 条目，拒绝覆盖",
                config_path.display(),
                server_name
            ));
        }
    }
    target.insert(server_name.to_string(), desired);
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?
    );
    write_text_atomic(config_path, &text, Some(&backup_dir_for(config_path)))
}

pub fn connect_to_path(
    config_path: &Path,
    server_name: &str,
    exe: &str,
    enable: bool,
) -> Result<(), String> {
    if !enable {
        if !config_path.exists() {
            return Ok(());
        }
        let mut value = read_json(config_path)?;
        let Some(root) = value.as_object_mut() else {
            return Err(format!("{} 的根节点不是 JSON 对象", config_path.display()));
        };
        let present = root
            .get("mcpServers")
            .and_then(Value::as_object)
            .map(|servers| servers.contains_key(server_name))
            .unwrap_or(false);
        if !present {
            return Ok(());
        }
        if let Some(servers) = root.get_mut("mcpServers").and_then(Value::as_object_mut) {
            servers.remove(server_name);
        }
        let text = format!(
            "{}\n",
            serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?
        );
        write_text_atomic(config_path, &text, Some(&backup_dir_for(config_path)))?;
        return Ok(());
    }

    let mut value = if config_path.exists() {
        read_json(config_path)?
    } else {
        json!({})
    };
    if !value.is_object() {
        return Err(format!("{} 的根节点不是 JSON 对象", config_path.display()));
    }
    let desired = json!({ "command": exe, "args": ["mcp"], "env": {} });
    let root = value.as_object_mut().unwrap();
    let servers = root
        .entry("mcpServers".to_string())
        .or_insert_with(|| json!({}));
    if !servers.is_object() {
        return Err(format!(
            "{} 中的 mcpServers 不是对象，拒绝覆盖",
            config_path.display()
        ));
    }
    if servers
        .as_object()
        .and_then(|entries| entries.get(server_name))
        == Some(&desired)
    {
        return Ok(());
    }
    servers
        .as_object_mut()
        .unwrap()
        .insert(server_name.to_string(), desired);
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?
    );
    write_text_atomic(config_path, &text, Some(&backup_dir_for(config_path)))
}

pub fn connect_target_by_id(id: &str, enable: bool) -> Result<Value, String> {
    let exe = current_exe_string();
    if let Some(def) = builtin_targets().into_iter().find(|t| t.id == id) {
        if def.format == FORMAT_OPENCODE {
            connect_opencode(&def.path, SERVER_NAME, &exe, enable)?;
        } else if def.format == FORMAT_CODEX {
            connect_codex(&def.path, SERVER_NAME, &exe, enable)?;
        } else {
            connect_to_path(&def.path, SERVER_NAME, &exe, enable)?;
        }
        return Ok(list_all());
    }
    if let Some(custom) = load_custom_targets().into_iter().find(|t| t.id == id) {
        connect_to_path(
            &PathBuf::from(&custom.config_path),
            &custom.server_name,
            &exe,
            enable,
        )?;
        return Ok(list_all());
    }
    Err(format!("未知的目标平台 ID：{id}"))
}

pub fn list_all() -> Value {
    let exe = current_exe_string();
    let mut targets = Vec::new();
    for def in builtin_targets() {
        let (exists, connected, error) = inspect(&def.path, SERVER_NAME, def.format);
        let dir_exists = def.path.parent().map(Path::exists).unwrap_or(false);
        targets.push(json!({
            "id": def.id,
            "label": def.label,
            "kind": def.kind,
            "format": def.format,
            "custom": false,
            "serverName": SERVER_NAME,
            "configPath": def.path.to_string_lossy(),
            "configExists": exists,
            "detected": exists || dir_exists,
            "connected": connected,
            "error": error,
        }));
    }
    for custom in load_custom_targets() {
        let path = PathBuf::from(&custom.config_path);
        let (exists, connected, error) = inspect(&path, &custom.server_name, FORMAT_MCP_SERVERS);
        targets.push(json!({
            "id": custom.id,
            "label": custom.label,
            "kind": "自定义桌面软件",
            "format": FORMAT_MCP_SERVERS,
            "custom": true,
            "serverName": custom.server_name,
            "configPath": custom.config_path,
            "configExists": exists,
            "detected": true,
            "connected": connected,
            "error": error,
        }));
    }
    json!({
        "executable": exe,
        "serverName": SERVER_NAME,
        "targets": targets,
        "snippets": snippets(&exe),
    })
}

pub fn snippets(exe: &str) -> Value {
    json!({
        "mcpServers": serde_json::to_string_pretty(&json!({
            "mcpServers": {
                SERVER_NAME: { "command": exe, "args": ["mcp"] }
            }
        })).unwrap_or_default(),
        "opencode": serde_json::to_string_pretty(&json!({
            "$schema": "https://opencode.ai/config.json",
            "mcp": {
                "servers": {
                    SERVER_NAME: {
                        "type": "local",
                        "command": [exe, "mcp"],
                        "disabled": false
                    }
                }
            }
        })).unwrap_or_default(),
        "zed": serde_json::to_string_pretty(&json!({
            "context_servers": {
                SERVER_NAME: {
                    "source": "custom",
                    "command": exe,
                    "args": ["mcp"],
                    "env": {}
                }
            }
        })).unwrap_or_default(),
        "codex": format!(
            "[mcp_servers.{}]\ncommand = {}\nargs = [\"mcp\"]\n",
            SERVER_NAME,
            serde_json::to_string(exe).unwrap_or_default()
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = env::temp_dir().join(format!("orzic-fusion-test-{name}-{stamp}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn connect_preserves_existing_servers_and_disconnects() {
        let dir = temp_dir("connectors");
        let path = dir.join("mcp.json");
        fs::write(
            &path,
            r#"{"mcpServers":{"other":{"command":"x"}},"keep":true}"#,
        )
        .unwrap();

        connect_to_path(&path, SERVER_NAME, "C:\\bin\\orzic-fusion.exe", true).unwrap();
        let value = read_json(&path).unwrap();
        assert_eq!(value["mcpServers"]["other"]["command"], "x");
        assert_eq!(value["mcpServers"][SERVER_NAME]["args"][0], "mcp");
        assert_eq!(value["keep"], true);

        connect_to_path(&path, SERVER_NAME, "C:\\bin\\orzic-fusion.exe", false).unwrap();
        let value = read_json(&path).unwrap();
        assert!(value["mcpServers"][SERVER_NAME].is_null());
        assert_eq!(value["mcpServers"]["other"]["command"], "x");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_to_overwrite_non_object_servers() {
        let dir = temp_dir("bad-shape");
        let path = dir.join("mcp.json");
        fs::write(&path, r#"{"mcpServers":[]}"#).unwrap();
        let err = connect_to_path(&path, SERVER_NAME, "exe", true).unwrap_err();
        assert!(err.contains("mcpServers 不是对象"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn opencode_merges_flat_map_and_preserves_provider_keys() {
        let dir = temp_dir("opencode-flat");
        let path = dir.join("opencode.json");
        fs::write(
            &path,
            r#"{"mcp":{"other":{"type":"local","command":["x"],"enabled":true}},"providers":{"p":{"options":{"apiKey":"secret"}}},"$schema":"https://opencode.ai/config.json"}"#,
        )
        .unwrap();

        connect_opencode(&path, SERVER_NAME, "C:\\bin\\orzic-fusion.exe", true).unwrap();
        let value = read_json(&path).unwrap();
        assert_eq!(value["mcp"]["other"]["enabled"], true);
        assert_eq!(value["mcp"][SERVER_NAME]["type"], "local");
        assert_eq!(value["mcp"][SERVER_NAME]["command"][1], "mcp");
        assert_eq!(value["mcp"][SERVER_NAME]["disabled"], false);
        assert_eq!(value["providers"]["p"]["options"]["apiKey"], "secret");

        connect_opencode(&path, SERVER_NAME, "C:\\bin\\orzic-fusion.exe", false).unwrap();
        let value = read_json(&path).unwrap();
        assert!(value["mcp"][SERVER_NAME].is_null());
        assert_eq!(value["mcp"]["other"]["command"][0], "x");
        assert_eq!(value["providers"]["p"]["options"]["apiKey"], "secret");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn opencode_uses_nested_servers_when_present() {
        let dir = temp_dir("opencode-nested");
        let path = dir.join("opencode.json");
        fs::write(
            &path,
            r#"{"mcp":{"servers":{"other":{"type":"local","command":["x"]}}}}"#,
        )
        .unwrap();

        connect_opencode(&path, SERVER_NAME, "exe", true).unwrap();
        let value = read_json(&path).unwrap();
        assert_eq!(value["mcp"]["servers"][SERVER_NAME]["command"][0], "exe");
        assert_eq!(value["mcp"]["servers"]["other"]["command"][0], "x");
        assert!(value["mcp"][SERVER_NAME].is_null());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn opencode_replaces_its_own_entry_with_a_new_path() {
        let dir = temp_dir("opencode-replace");
        let path = dir.join("opencode.json");
        fs::write(
            &path,
            r#"{"mcp":{"fusion":{"type":"local","command":["C:\\old\\orzic-fusion.exe","mcp"],"disabled":false}}}"#,
        )
        .unwrap();
        connect_opencode(&path, SERVER_NAME, "C:\\new\\orzic-fusion.exe", true).unwrap();
        let value = read_json(&path).unwrap();
        assert_eq!(
            value["mcp"][SERVER_NAME]["command"][0],
            "C:\\new\\orzic-fusion.exe"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn opencode_refuses_jsonc_and_conflicts() {
        let dir = temp_dir("opencode-jsonc");
        let path = dir.join("opencode.json");
        fs::write(&path, r#"{"mcp":{}}"#).unwrap();
        fs::write(dir.join("opencode.jsonc"), "{}").unwrap();
        let err = connect_opencode(&path, SERVER_NAME, "exe", true).unwrap_err();
        assert!(err.contains("JSONC"));

        fs::remove_file(dir.join("opencode.jsonc")).unwrap();
        fs::write(
            &path,
            r#"{"mcp":{"fusion":{"type":"local","command":["other"],"disabled":false}}}"#,
        )
        .unwrap();
        let err = connect_opencode(&path, SERVER_NAME, "exe", true).unwrap_err();
        assert!(err.contains("非 Fusion"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn opencode_inspect_reads_flat_and_nested() {
        let dir = temp_dir("opencode-inspect");
        let flat = dir.join("flat.json");
        fs::write(&flat, r#"{"mcp":{"fusion":{"command":["x"]}}}"#).unwrap();
        assert!(inspect(&flat, SERVER_NAME, FORMAT_OPENCODE).1);
        let nested = dir.join("nested.json");
        fs::write(&nested, r#"{"mcp":{"servers":{"fusion":{"command":["x"]}}}}"#).unwrap();
        assert!(inspect(&nested, SERVER_NAME, FORMAT_OPENCODE).1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_ownership_accepts_only_fusion_stdio_entries() {
        let owned = json!({
            "name": "fusion",
            "transport": {
                "type": "stdio",
                "command": "C:\\bin\\orzic-fusion.exe",
                "args": ["mcp"]
            }
        });
        assert!(is_fusion_codex_entry(&owned, SERVER_NAME));
        assert!(codex_entry_matches(&owned, "c:\\bin\\ORZIC-FUSION.exe"));

        let foreign = json!({
            "name": "fusion",
            "transport": { "type": "stdio", "command": "other.exe", "args": ["mcp"] }
        });
        assert!(!is_fusion_codex_entry(&foreign, SERVER_NAME));

        let http = json!({
            "name": "fusion",
            "transport": { "type": "streamable-http", "url": "http://x" }
        });
        assert!(!is_fusion_codex_entry(&http, SERVER_NAME));
    }
}
