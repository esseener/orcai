//! Portable project handoff: one Markdown snapshot in the repository so a
//! fresh session, or another machine, can pick the work up.
//!
//! The snapshot lives at `.omp/handoff.md` and is wired into `AGENTS.md` with
//! an `@.omp/handoff.md` import, which OMP (and other agents that read
//! `AGENTS.md`) expand automatically on every session start. Nothing here
//! touches the user-level agent directory, so the snapshot travels with git.

use crate::config;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Repository-relative location of the snapshot.
pub const HANDOFF_REL: &str = ".omp/handoff.md";
/// Upper bound on one snapshot; large enough for a real handoff, small enough
/// that a runaway model cannot dump a transcript into the repository.
const MAX_BYTES: usize = 64 * 1024;
const IMPORT_LINE: &str = "@.omp/handoff.md";
const MARKER_START: &str = "<!-- orzic-fusion:handoff -->";
const MARKER_END: &str = "<!-- /orzic-fusion:handoff -->";

fn workspace(cwd: &str) -> Result<PathBuf, String> {
    let raw = cwd.trim();
    let path = if raw.is_empty() {
        std::env::current_dir().map_err(|e| format!("无法确定当前目录: {e}"))?
    } else {
        PathBuf::from(raw)
    };
    let root = fs::canonicalize(&path)
        .map_err(|e| format!("工作区不存在或不可访问 ({}): {e}", path.display()))?;
    if !root.is_dir() {
        return Err(format!("工作区不是目录：{}", root.display()));
    }
    Ok(root)
}

fn handoff_path(root: &Path) -> PathBuf {
    root.join(".omp").join("handoff.md")
}

fn agents_path(root: &Path) -> PathBuf {
    root.join("AGENTS.md")
}

/// Windows canonicalization returns a `\\?\` verbatim prefix; hide it from
/// tool output while keeping the path absolute.
fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

/// FNV-1a over the exact bytes. Only used to detect concurrent edits, so a
/// stable, dependency-free hash is enough.
fn hash_bytes(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn current_bytes(root: &Path) -> Vec<u8> {
    fs::read(handoff_path(root)).unwrap_or_default()
}

fn updated_at_ms(root: &Path) -> Option<u64> {
    fs::metadata(handoff_path(root))
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

fn agents_wired(root: &Path) -> bool {
    fs::read_to_string(agents_path(root))
        .map(|text| text.contains(IMPORT_LINE))
        .unwrap_or(false)
}

/// Add the import to `AGENTS.md` without disturbing existing instructions.
/// Existing files get a marked block appended; a missing file gets a minimal
/// one so the snapshot is loaded on the next session.
fn wire_agents(root: &Path) -> Result<bool, String> {
    if agents_wired(root) {
        return Ok(false);
    }
    let path = agents_path(root);
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let block = format!(
        "{MARKER_START}\n<!-- 阶段工作完成后，用 fusion_handoff_save 更新此快照；会话开始时会自动加载。 -->\n{IMPORT_LINE}\n{MARKER_END}\n"
    );
    let next = if existing.trim().is_empty() {
        format!("# AGENTS.md\n\n{block}")
    } else {
        let mut text = existing;
        if !text.ends_with('\n') {
            text.push('\n');
        }
        text.push('\n');
        text.push_str(&block);
        text
    };
    config::write_text_atomic(&path, &next, None)?;
    Ok(true)
}

pub fn read(cwd: &str) -> Result<Value, String> {
    let root = workspace(cwd)?;
    let path = handoff_path(&root);
    let exists = path.is_file();
    let content = if exists {
        fs::read(&path)
            .map_err(|e| format!("读取 {} 失败: {e}", path.display()))?
    } else {
        Vec::new()
    };
    let text = String::from_utf8(content).unwrap_or_default();
    Ok(json!({
        "exists": exists,
        "path": HANDOFF_REL,
        "absolutePath": display_path(&path),
        "content": text,
        "hash": hash_bytes(text.as_bytes()),
        "updatedAt": updated_at_ms(&root),
        "agentsWired": agents_wired(&root),
        "bytes": text.len(),
    }))
}

pub fn save(cwd: &str, content: &str, expected_hash: Option<&str>) -> Result<Value, String> {
    let root = workspace(cwd)?;
    let content = content.trim_end();
    if content.trim().is_empty() {
        return Err("接续快照内容为空，未写入".into());
    }
    if content.len() > MAX_BYTES {
        return Err(format!(
            "接续快照超过 {} KiB，未写入",
            MAX_BYTES / 1024
        ));
    }
    let path = handoff_path(&root);
    let before = current_bytes(&root);
    let before_hash = hash_bytes(&before);
    if let Some(expected) = expected_hash.map(str::trim).filter(|h| !h.is_empty()) {
        if expected != before_hash {
            return Err(format!(
                "接续快照已被其他会话修改（当前 {before_hash}，期望 {expected}），未覆盖；请先 fusion_handoff_read 再合并"
            ));
        }
    }
    let text = format!("{content}\n");
    config::write_text_atomic(&path, &text, None)?;
    let wired = wire_agents(&root)?;
    Ok(json!({
        "ok": true,
        "path": HANDOFF_REL,
        "absolutePath": display_path(&path),
        "hash": hash_bytes(text.as_bytes()),
        "bytes": text.len(),
        "agentsWired": true,
        "agentsChanged": wired,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    fn temp_workspace() -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "orzic-handoff-test-{}-{n}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn cwd(dir: &Path) -> String {
        dir.to_string_lossy().to_string()
    }

    #[test]
    fn save_creates_snapshot_and_wires_agents() {
        let dir = temp_workspace();
        let saved = save(&cwd(&dir), "# 目标\n- 未完成：B", None).unwrap();
        assert!(saved["ok"].as_bool().unwrap());
        let text = fs::read_to_string(dir.join(".omp/handoff.md")).unwrap();
        assert!(text.contains("未完成：B"));
        let agents = fs::read_to_string(dir.join("AGENTS.md")).unwrap();
        assert!(agents.contains(IMPORT_LINE));
        let read_back = read(&cwd(&dir)).unwrap();
        assert!(read_back["exists"].as_bool().unwrap());
        assert!(read_back["agentsWired"].as_bool().unwrap());
        assert_eq!(read_back["hash"], saved["hash"]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn existing_agents_is_appended_not_replaced() {
        let dir = temp_workspace();
        let agents = dir.join("AGENTS.md");
        fs::write(&agents, "# 团队规则\n- 用中文\n").unwrap();
        save(&cwd(&dir), "快照", None).unwrap();
        let text = fs::read_to_string(&agents).unwrap();
        assert!(text.starts_with("# 团队规则"));
        assert_eq!(text.matches(IMPORT_LINE).count(), 1);
        // A second save must not duplicate the import.
        save(&cwd(&dir), "快照 2", None).unwrap();
        let text = fs::read_to_string(&agents).unwrap();
        assert_eq!(text.matches(IMPORT_LINE).count(), 1);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stale_hash_is_rejected() {
        let dir = temp_workspace();
        let first = save(&cwd(&dir), "第一版", None).unwrap();
        let stale = first["hash"].as_str().unwrap().to_string();
        save(&cwd(&dir), "第二版", None).unwrap();
        let err = save(&cwd(&dir), "第三版", Some(&stale)).unwrap_err();
        assert!(err.contains("已被其他会话修改"));
        assert!(fs::read_to_string(dir.join(".omp/handoff.md"))
            .unwrap()
            .contains("第二版"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_and_oversized_content_are_rejected() {
        let dir = temp_workspace();
        assert!(save(&cwd(&dir), "   ", None).is_err());
        let huge = "x".repeat(MAX_BYTES + 1);
        assert!(save(&cwd(&dir), &huge, None).is_err());
        assert!(!dir.join(".omp/handoff.md").exists());
        fs::remove_dir_all(&dir).ok();
    }
}
