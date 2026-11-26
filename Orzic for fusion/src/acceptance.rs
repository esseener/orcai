use crate::agents::omp;
use crate::config::{omp_agent_dir, write_text_atomic};
use serde_json::{json, Value};
use std::fs;
use std::fs::OpenOptions;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const MAX_DIFF_CHARS: usize = 120_000;
const MAX_UNTRACKED_FILE: u64 = 64 * 1024;
const REVIEW_TIMEOUT: Duration = Duration::from_secs(180);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn acceptance_file() -> PathBuf {
    omp_agent_dir().join("orzic-fusion-acceptance.json")
}

fn truncate_chars(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    text.chars().take(limit).collect()
}

pub fn last() -> Value {
    fs::read_to_string(acceptance_file())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| json!({}))
}

fn save_last(result: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(result).map_err(|e| e.to_string())?;
    write_text_atomic(&acceptance_file(), &text, None)
}

fn auto_file() -> PathBuf {
    omp_agent_dir().join("orzic-fusion-auto.json")
}

/// Stable, case-insensitive key for a workspace. Windows paths are compared
/// without a trailing separator; a missing path still gets a usable key so
/// the UI can save a choice before the directory exists.
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

pub fn auto_settings_all() -> Value {
    fs::read_to_string(auto_file())
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(|value| value["workspaces"].is_object())
        .unwrap_or_else(|| json!({ "workspaces": {} }))
}

pub fn auto_settings(cwd: &str) -> Value {
    let key = normalize_cwd(cwd);
    auto_settings_all()["workspaces"]
        .get(&key)
        .cloned()
        .unwrap_or_else(|| json!({ "enabled": false, "rework": false }))
}

pub fn set_auto(cwd: &str, enabled: bool, rework: bool) -> Result<Value, String> {
    if cwd.trim().is_empty() {
        return Err("请填写工作区路径".into());
    }
    let rework = enabled && rework;
    let key = normalize_cwd(cwd);
    let mut all = auto_settings_all();
    if !all["workspaces"].is_object() {
        all["workspaces"] = json!({});
    }
    let workspaces = all["workspaces"].as_object_mut().unwrap();
    if enabled || rework {
        let mut entry = workspaces.get(&key).cloned().unwrap_or_else(|| json!({}));
        if !entry.is_object() {
            entry = json!({});
        }
        let object = entry.as_object_mut().unwrap();
        object.insert("enabled".into(), json!(enabled));
        object.insert("rework".into(), json!(rework));
        workspaces.insert(key, entry);
    } else {
        workspaces.remove(&key);
    }
    let text = serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?;
    write_text_atomic(&auto_file(), &text, None)?;
    Ok(all)
}

/// Remember the last completed review for this workspace. Only pass/rework/skip
/// count as already reviewed; stale or failed runs must be retried.
fn record_review(cwd: &str, fingerprint: &str, verdict: &str) {
    let mut all = auto_settings_all();
    if !all["workspaces"].is_object() {
        all["workspaces"] = json!({});
    }
    let key = normalize_cwd(cwd);
    let workspaces = all["workspaces"].as_object_mut().unwrap();
    let mut entry = workspaces
        .get(&key)
        .cloned()
        .unwrap_or_else(|| json!({ "enabled": false, "rework": false }));
    if !entry.is_object() {
        entry = json!({ "enabled": false, "rework": false });
    }
    let object = entry.as_object_mut().unwrap();
    object.insert("lastFingerprint".into(), json!(fingerprint));
    object.insert("lastVerdict".into(), json!(verdict));
    workspaces.insert(key, entry);
    if let Ok(text) = serde_json::to_string_pretty(&all) {
        let _ = write_text_atomic(&auto_file(), &text, None);
    }
}

fn already_reviewed(cwd: &str, fingerprint: &str) -> bool {
    let settings = auto_settings(cwd);
    settings["lastFingerprint"].as_str() == Some(fingerprint)
        && matches!(
            settings["lastVerdict"].as_str(),
            Some("pass") | Some("rework") | Some("skip")
        )
}

fn fingerprint(cwd: &Path, plan: &str, diff: &str, model: &str, thinking: Option<&str>) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    let mut feed = |bytes: &[u8]| {
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100_0000_01b3);
        }
        hash ^= 0xff;
        hash = hash.wrapping_mul(0x100_0000_01b3);
    };
    feed(normalize_cwd(&cwd.to_string_lossy()).as_bytes());
    feed(plan.as_bytes());
    feed(diff.as_bytes());
    feed(model.as_bytes());
    feed(thinking.unwrap_or("").as_bytes());
    format!("{hash:016x}")
}

fn lock_file() -> PathBuf {
    omp_agent_dir().join("orzic-fusion-acceptance.lock")
}

struct ReviewLock {
    path: PathBuf,
}

impl Drop for ReviewLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn acquire_lock() -> Result<ReviewLock, String> {
    let path = lock_file();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建目录 {}: {e}", parent.display()))?;
    }
    for _ in 0..2 {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let _ = write!(file, "{} {}", std::process::id(), now_ms());
                return Ok(ReviewLock { path });
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                let stale = fs::metadata(&path)
                    .ok()
                    .and_then(|meta| meta.modified().ok())
                    .and_then(|time| time.elapsed().ok())
                    .map(|age| age > Duration::from_secs(300))
                    .unwrap_or(false);
                if stale {
                    let _ = fs::remove_file(&path);
                    continue;
                }
                return Err("已有验收正在进行，请稍后重试".into());
            }
            Err(error) => return Err(format!("创建验收锁失败: {error}")),
        }
    }
    Err("已有验收正在进行，请稍后重试".into())
}

struct Diff {
    text: String,
    stat: String,
    files: usize,
}

fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("无法运行 git: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "git {} 失败: {}",
            args.join(" "),
            truncate_chars(err.trim(), 300)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn skipped_untracked(path: &str) -> bool {
    let lower = path.to_lowercase().replace('\\', "/");
    lower == "plan.md"
        || lower.starts_with(".omp/")
        || lower.starts_with("_archive/")
        || lower.starts_with("node_modules/")
        || lower.contains("/node_modules/")
        || lower.starts_with("target/")
        || lower.contains("/target/")
        || lower.starts_with(".git/")
}

fn collect_diff(cwd: &Path) -> Result<Diff, String> {
    let stat = git(
        cwd,
        &["diff", "--stat", "HEAD", "--", ".", ":(exclude)PLAN.md"],
    )
    .unwrap_or_default();
    let tracked = match git(cwd, &["diff", "HEAD", "--", ".", ":(exclude)PLAN.md"]) {
        Ok(value) => value,
        Err(_) => git(cwd, &["diff", "--", ".", ":(exclude)PLAN.md"]).unwrap_or_default(),
    };
    let mut text = tracked;
    let mut files = stat.lines().filter(|line| line.contains('|')).count();

    let untracked = git(cwd, &["ls-files", "--others", "--exclude-standard"]).unwrap_or_default();
    for path in untracked.lines().map(str::trim).filter(|p| !p.is_empty()) {
        if skipped_untracked(path) {
            continue;
        }
        let full = cwd.join(path);
        let Ok(meta) = fs::metadata(&full) else {
            continue;
        };
        if meta.len() > MAX_UNTRACKED_FILE {
            continue;
        }
        let Ok(bytes) = fs::read(&full) else {
            continue;
        };
        if bytes.contains(&0) {
            continue;
        }
        let content = String::from_utf8_lossy(&bytes);
        text.push_str(&format!("\n--- untracked: {path} ---\n{content}\n"));
        files += 1;
    }

    if text.chars().count() > MAX_DIFF_CHARS {
        text = text.chars().take(MAX_DIFF_CHARS).collect();
        text.push_str("\n...（diff 已截断）");
    }
    Ok(Diff { text, stat, files })
}

fn resolve_review() -> Result<(String, String, Option<String>), String> {
    let status = omp::read_status();
    let roles = status["roles"].as_array().cloned().unwrap_or_default();
    for role in ["review", "advisor", "default"] {
        if let Some(view) = roles.iter().find(|entry| entry["role"] == role) {
            if let Some(model) = view["model"]
                .as_str()
                .map(str::trim)
                .filter(|model| !model.is_empty())
            {
                let thinking = view["thinking"].as_str().map(str::to_string);
                return Ok((role.to_string(), model.to_string(), thinking));
            }
        }
    }
    Err("未配置 review / advisor / default 模型".into())
}

fn build_prompt(plan: &str, diff: &str) -> String {
    format!(
        "你是代码验收评审。只输出 JSON（无其他文字）：\
{{\"verdict\":\"pass|rework\",\"findings\":[{{\"severity\":\"low|medium|high|blocker\",\"file\":\"\",\"line\":0,\"message\":\"\"}}],\"summary\":\"\"}}。\
JSON 字符串内不要使用未转义的 ASCII 双引号，引用用「」。\n\
验收标准：\n\
- 实现符合 PLAN.md 的目标与步骤\n\
- 没有明显回归或破坏性改动\n\
- 边界与错误处理合理\n\
- 不包含与任务无关的大范围改动\n\n\
计划（PLAN.md）：\n{}\n\ndiff：\n{}",
        if plan.trim().is_empty() {
            "（没有 PLAN.md）"
        } else {
            plan
        },
        diff
    )
}

fn judge_config() -> Option<PathBuf> {
    let path = omp_agent_dir().join("orzic-judge.yml");
    let content = "advisor:\n  enabled: false\n";
    if fs::read_to_string(&path).ok().as_deref() != Some(content)
        && write_text_atomic(&path, content, None).is_err()
    {
        return None;
    }
    Some(path)
}

fn call_omp(
    cwd: &Path,
    model: &str,
    thinking: Option<&str>,
    prompt: &str,
) -> Result<String, String> {
    let exe = omp::find_executable();
    let mut cmd = Command::new(&exe);
    if let Some(config) = judge_config() {
        cmd.arg("--config").arg(config);
    }
    cmd.arg("--model").arg(model);
    if let Some(level) = thinking {
        cmd.arg("--thinking").arg(level);
    }
    cmd.args([
        "--mode",
        "json",
        "--no-session",
        "--no-extensions",
        "--no-prewalk",
        "--no-tools",
        "--no-skills",
        "--no-rules",
        "--no-context-files",
    ]);
    cmd.current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法运行 OMP ({exe}): {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .map_err(|e| format!("写入验收提示失败: {e}"))?;
    }
    let stdout = child.stdout.take().ok_or("无法读取验收输出")?;
    let stderr = child.stderr.take().ok_or("无法读取验收错误")?;

    let (out_tx, out_rx) = mpsc::channel();
    let (err_tx, err_rx) = mpsc::channel();
    thread::spawn(move || {
        let mut reader = stdout;
        let mut buffer = Vec::new();
        let _ = reader.read_to_end(&mut buffer);
        let _ = out_tx.send(buffer);
    });
    thread::spawn(move || {
        let mut reader = stderr;
        let mut buffer = Vec::new();
        let _ = reader.read_to_end(&mut buffer);
        let _ = err_tx.send(buffer);
    });

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started.elapsed() > REVIEW_TIMEOUT {
                    let _ = child.kill();
                    return Err(format!(
                        "验收模型超时（{}s）",
                        REVIEW_TIMEOUT.as_secs()
                    ));
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("等待验收进程失败: {e}")),
        }
    };

    let out = out_rx.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
    let err = err_rx.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
    if !status.success() {
        let message = String::from_utf8_lossy(&err);
        return Err(format!(
            "验收模型调用失败（{model}）：{}",
            truncate_chars(message.trim(), 500)
        ));
    }
    Ok(String::from_utf8_lossy(&out).to_string())
}

fn extract_json(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end <= start {
        return None;
    }
    Some(&text[start..=end])
}

fn normalize_findings(parsed: &Value) -> Vec<Value> {
    parsed["findings"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|finding| {
            json!({
                "severity": finding["severity"].as_str().unwrap_or("info"),
                "file": finding["file"].as_str().or_else(|| finding["path"].as_str()).unwrap_or(""),
                "line": finding["line"].as_i64(),
                "message": finding["message"].as_str().unwrap_or(""),
            })
        })
        .collect()
}

pub fn parse_verdict(text: &str) -> Result<Value, String> {
    if let Some(raw) = extract_json(text) {
        if let Ok(parsed) = serde_json::from_str::<Value>(raw) {
            let findings = normalize_findings(&parsed);
            let blocker = findings.iter().any(|finding| {
                matches!(
                    finding["severity"].as_str().unwrap_or("").to_lowercase().as_str(),
                    "blocker" | "critical" | "high" | "error"
                )
            });
            let raw_verdict = parsed["verdict"].as_str().unwrap_or("").to_lowercase();
            let verdict = if blocker || raw_verdict == "rework" {
                "rework"
            } else if raw_verdict == "pass" {
                "pass"
            } else {
                "failed"
            };
            let summary = parsed["summary"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| format!("{} 条问题", findings.len()));
            return Ok(json!({
                "verdict": verdict,
                "findings": findings,
                "summary": summary,
            }));
        }
    }

    let upper = text.to_uppercase();
    if upper.contains("REWORK") {
        return Ok(json!({
            "verdict": "rework",
            "findings": [],
            "summary": truncate_chars(text.trim(), 400),
        }));
    }
    if upper.contains("PASS") {
        return Ok(json!({
            "verdict": "pass",
            "findings": [],
            "summary": truncate_chars(text.trim(), 400),
        }));
    }
    Err("验收模型输出无法解析为 PASS/REWORK JSON".into())
}

fn parse_omp_output(stdout: &str, model: &str) -> Result<Value, String> {
    let mut text = String::new();
    for line in stdout.lines() {
        if !line.contains("message_end") {
            continue;
        }
        if let Ok(event) = serde_json::from_str::<Value>(line) {
            if event["type"] == "message_end" && event["message"]["role"] == "assistant" {
                if let Some(parts) = event["message"]["content"].as_array() {
                    text = parts
                        .iter()
                        .map(|part| part["text"].as_str().unwrap_or(""))
                        .collect::<Vec<_>>()
                        .join("");
                }
            }
        }
    }
    if text.trim().is_empty() && stdout.trim_start().starts_with('{') {
        text = stdout.to_string();
    }
    if text.trim().is_empty() {
        return Err(format!("验收模型没有返回文本（{model}）"));
    }
    parse_verdict(&text)
}

/// Collects the same reviewed input as the OMP acceptance path, without
/// resolving or calling any OMP model. Used by the OpenCode adapter.
pub(crate) fn collect_review_input(cwd: &str) -> Result<(String, String, usize), String> {
    let cwd_path = PathBuf::from(cwd.trim());
    if !cwd_path.is_dir() {
        return Err(format!("工作区不存在：{}", cwd_path.display()));
    }
    if git(&cwd_path, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Err(format!("{} 不是 Git 仓库", cwd_path.display()));
    }
    let diff = collect_diff(&cwd_path)?;
    let plan = fs::read_to_string(cwd_path.join("PLAN.md")).unwrap_or_default();
    let plan = truncate_chars(&plan, 20_000);
    Ok((plan, diff.text, diff.files))
}

pub(crate) fn build_review_prompt(plan: &str, diff: &str) -> String {
    build_prompt(plan, diff)
}

pub(crate) fn parse_review_text(text: &str) -> Result<Value, String> {
    parse_verdict(text)
}

/// Runs one manual acceptance pass over `cwd`.
pub fn run(cwd: &str) -> Result<Value, String> {
    run_mode(cwd, false)
}

/// Runs one automatic acceptance pass. It returns `disabled`, `duplicate`, or
/// `skip` without calling a model when this workspace has no opt-in or the
/// reviewed input is unchanged.
pub fn run_auto(cwd: &str) -> Result<Value, String> {
    run_mode(cwd, true)
}

fn run_mode(cwd: &str, auto: bool) -> Result<Value, String> {
    let cwd_path = PathBuf::from(cwd.trim());
    if !cwd_path.is_dir() {
        return Err(format!("工作区不存在：{}", cwd_path.display()));
    }
    let mode = if auto { "auto" } else { "manual" };
    let auto_view = auto_settings(cwd);
    if auto && !auto_view["enabled"].as_bool().unwrap_or(false) {
        return Ok(json!({
            "verdict": "disabled",
            "mode": "auto",
            "reason": "此工作区未开启自动验收",
        }));
    }
    if git(&cwd_path, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Err(format!("{} 不是 Git 仓库", cwd_path.display()));
    }

    let diff = collect_diff(&cwd_path)?;
    let plan = fs::read_to_string(cwd_path.join("PLAN.md")).unwrap_or_default();
    let plan = truncate_chars(&plan, 20_000);

    if diff.text.trim().is_empty() {
        if auto {
            return Ok(json!({
                "verdict": "skip",
                "mode": "auto",
                "reason": "工作区没有可验收的改动",
            }));
        }
        let result = json!({
            "verdict": "skip",
            "reason": "工作区没有可验收的改动",
            "findings": [],
            "summary": "没有 diff",
            "cwd": cwd_path.to_string_lossy(),
            "mode": "manual",
            "at": now_ms(),
        });
        save_last(&result)?;
        return Ok(result);
    }

    let (role, model, thinking) = resolve_review()?;
    let fp = fingerprint(
        &cwd_path,
        &plan,
        &diff.text,
        &model,
        thinking.as_deref(),
    );
    if auto && already_reviewed(cwd, &fp) {
        return Ok(json!({
            "verdict": "duplicate",
            "mode": "auto",
            "fingerprint": fp,
            "reason": "相同改动已验收",
        }));
    }

    let _lock = acquire_lock()?;
    if auto && already_reviewed(cwd, &fp) {
        // Another automatic run may have finished while this one waited for
        // the lock; do not pay for the same diff twice.
        return Ok(json!({
            "verdict": "duplicate",
            "mode": "auto",
            "fingerprint": fp,
            "reason": "相同改动已验收",
        }));
    }

    if model.to_lowercase().contains("devin") {
        let models = omp::list_models(false).unwrap_or_default();
        if !models
            .iter()
            .any(|entry| entry.provider.eq_ignore_ascii_case("devin"))
        {
            return Err(format!(
                "验收模型 {model} 依赖已退出的 Devin 登录；请在验收部把 review 换成可用模型"
            ));
        }
    }
    let prompt = build_prompt(&plan, &diff.text);
    let started = Instant::now();
    let stdout = call_omp(&cwd_path, &model, thinking.as_deref(), &prompt)?;
    let parsed = parse_omp_output(&stdout, &model)?;

    // A new edit during the model call makes the verdict unusable for
    // automatic rework. Keep it visible, but never feed it back.
    let after = collect_diff(&cwd_path)?;
    let after_plan = fs::read_to_string(cwd_path.join("PLAN.md")).unwrap_or_default();
    let after_plan = truncate_chars(&after_plan, 20_000);
    let stale = fingerprint(
        &cwd_path,
        &after_plan,
        &after.text,
        &model,
        thinking.as_deref(),
    ) != fp;

    let (verdict, findings, summary) = if stale {
        (
            "stale".to_string(),
            Vec::<Value>::new(),
            "验收期间工作区发生变化，本次结果不作为自动返工依据".to_string(),
        )
    } else {
        (
            parsed["verdict"]
                .as_str()
                .unwrap_or("failed")
                .to_string(),
            parsed["findings"]
                .as_array()
                .cloned()
                .unwrap_or_default(),
            parsed["summary"]
                .as_str()
                .unwrap_or("")
                .to_string(),
        )
    };
    let auto_rework = if auto {
        auto_settings(cwd)["rework"].as_bool().unwrap_or(false)
    } else {
        false
    };

    let result = json!({
        "verdict": verdict,
        "findings": findings,
        "summary": summary,
        "role": role,
        "model": model,
        "thinking": thinking,
        "cwd": cwd_path.to_string_lossy(),
        "diffStat": diff.stat.trim(),
        "diffChars": diff.text.chars().count(),
        "files": diff.files,
        "durationMs": started.elapsed().as_millis() as u64,
        "mode": mode,
        "fingerprint": fp,
        "autoRework": auto_rework,
        "stale": stale,
        "at": now_ms(),
    });
    save_last(&result)?;
    if let Some(verdict) = result["verdict"].as_str() {
        record_review(cwd, &fp, verdict);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pass_verdict() {
        let result = parse_verdict(
            "评审结果：{\"verdict\":\"pass\",\"findings\":[],\"summary\":\"ok\"}",
        )
        .unwrap();
        assert_eq!(result["verdict"], "pass");
        assert_eq!(result["summary"], "ok");
    }

    #[test]
    fn blocker_forces_rework() {
        let result = parse_verdict(
            "{\"verdict\":\"pass\",\"findings\":[{\"severity\":\"blocker\",\"file\":\"a.js\",\"line\":3,\"message\":\"wrong result\"}]}",
        )
        .unwrap();
        assert_eq!(result["verdict"], "rework");
        assert_eq!(result["findings"][0]["file"], "a.js");
    }

    #[test]
    fn falls_back_to_keyword() {
        let result = parse_verdict("REWORK: the button does nothing").unwrap();
        assert_eq!(result["verdict"], "rework");
        let pass = parse_verdict("PASS").unwrap();
        assert_eq!(pass["verdict"], "pass");
    }

    #[test]
    fn normalize_cwd_strips_verbatim_prefix_and_lowercases() {
        let key = normalize_cwd(&std::env::temp_dir().to_string_lossy());
        assert!(!key.contains("\\\\?\\"), "verbatim prefix leaked: {key}");
        assert!(!key.contains('/'), "path separators not normalized: {key}");
        assert_eq!(key, key.to_lowercase());
    }

    #[test]
    fn fingerprint_changes_with_the_reviewed_diff() {
        let path = Path::new("C:\\repo");
        let first = fingerprint(path, "plan", "diff a", "provider/model", Some("low"));
        let second = fingerprint(path, "plan", "diff b", "provider/model", Some("low"));
        assert_ne!(first, second);
        assert_eq!(
            first,
            fingerprint(path, "plan", "diff a", "provider/model", Some("low"))
        );
    }
}
