use crate::agents::omp;
use crate::config::{omp_agent_dir, write_text_atomic};
use crate::connectors::current_exe_string;
use crate::roles;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

static ROUTE_LOCK: Mutex<()> = Mutex::new(());

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn state_path() -> PathBuf {
    omp_agent_dir().join("orzic-fusion-route.json")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteRules {
    #[serde(default = "default_true")]
    pub use_builtin: bool,
    #[serde(default)]
    pub replan_phrases: Vec<String>,
    #[serde(default)]
    pub execute_phrases: Vec<String>,
    #[serde(default = "default_mode")]
    pub default_mode: String,
}

fn default_true() -> bool {
    true
}

fn default_mode() -> String {
    "plan".to_string()
}

impl Default for RouteRules {
    fn default() -> Self {
        Self {
            use_builtin: true,
            replan_phrases: Vec::new(),
            execute_phrases: Vec::new(),
            default_mode: default_mode(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub mode: String,
    pub updated_at: u64,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteState {
    #[serde(default)]
    pub rules: RouteRules,
    #[serde(default)]
    pub roles: BTreeMap<String, String>,
    #[serde(default)]
    pub default_thinking_level: Option<String>,
    #[serde(default)]
    pub roles_at: u64,
    #[serde(default)]
    pub config_mtime: u64,
    #[serde(default)]
    pub sessions: BTreeMap<String, SessionState>,
}

fn load_state() -> RouteState {
    fs::read_to_string(state_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_state(state: &RouteState) -> Result<(), String> {
    let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    write_text_atomic(&state_path(), &text, None)
}

/// Reads OMP's model roles once and caches them in the route state. The OMP
/// extension must not pay a ~1s CLI round trip on every message.
pub fn refresh_roles(state: &mut RouteState) -> Result<(), String> {
    let cfg = omp::config_snapshot()?;
    let mut roles_map = BTreeMap::new();
    if let Some(Value::Object(map)) = omp::entry_value(&cfg, "modelRoles") {
        for (key, value) in map {
            if let Some(selector) = value.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                roles_map.insert(key.clone(), selector.to_string());
            }
        }
    }
    state.roles = roles_map;
    state.default_thinking_level = omp::entry_value(&cfg, "defaultThinkingLevel")
        .and_then(Value::as_str)
        .map(str::to_string);
    state.roles_at = now_ms();
    state.config_mtime = config_mtime();
    // Warm the model cache so selectors containing ':' decode correctly.
    let _ = omp::list_models(false);
    Ok(())
}

fn config_mtime() -> u64 {
    fs::metadata(omp_agent_dir().join("config.yml"))
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn known_models() -> BTreeSet<String> {
    omp::list_models(false)
        .map(|models| models.into_iter().map(|model| model.selector).collect())
        .unwrap_or_default()
}

fn plan_ready(cwd: &str) -> bool {
    if cwd.trim().is_empty() {
        return false;
    }
    fs::read_to_string(PathBuf::from(cwd).join("PLAN.md"))
        .map(|text| !text.trim().is_empty())
        .unwrap_or(false)
}

#[derive(Debug, Clone)]
pub struct Decision {
    pub mode: String,
    pub source: String,
    pub reason: String,
}

fn decide_plan(source: &str, reason: &str) -> Decision {
    Decision {
        mode: "plan".into(),
        source: source.into(),
        reason: reason.into(),
    }
}

fn decide_execute(source: &str, reason: &str) -> Decision {
    Decision {
        mode: "execute".into(),
        source: source.into(),
        reason: reason.into(),
    }
}

// ── Message classification ──────────────────────────────────────────────────

const REPLAN: &[&str] = &[
    "重新规划",
    "重新计划",
    "重新评估",
    "重新分析",
    "重新设计",
    "复盘",
    "拆解",
    "先做计划",
    "先写计划",
    "先给方案",
    "换个方案",
    "换一个方案",
    "换个思路",
    "不要直接执行",
    "不要开始执行",
    "不要开始实现",
    "不要继续执行",
    "先别执行",
    "规划一下",
    "计划一下",
];

const EXECUTE: &[&str] = &[
    "开始实现",
    "开始执行",
    "继续实现",
    "继续执行",
    "继续做",
    "继续推进",
    "按计划执行",
    "按计划实现",
    "执行计划",
    "接着做",
    "动手吧",
    "开干",
    "开工",
    "开始做",
    "直接实现",
    "直接执行",
    "go ahead",
    "proceed",
    "continue",
];

const IMPERATIVE: &[&str] = &[
    "帮我",
    "帮忙",
    "给我",
    "做一个",
    "做个",
    "实现",
    "添加",
    "新增",
    "加一个",
    "加个",
    "加上",
    "修复",
    "修一下",
    "改一下",
    "改成",
    "换成",
    "重构",
    "优化",
    "设计",
    "生成",
    "写一个",
    "写个",
    "创建",
    "搭建",
    "接入",
    "接上",
    "适配",
    "移植",
    "部署",
    "安装",
    "配置",
    "调整",
    "替换",
    "删除",
    "移除",
    "按这个",
    "按图",
    "按截图",
    "照这个",
    "让它能",
    "让它支持",
    "再做一个",
];

const WISH: &[&str] = &[
    "我想要",
    "我要",
    "我想",
    "希望",
    "目标是",
    "需求是",
    "支持",
    "让它",
];

const NEW_TASK: &[&str] = &[
    "另外",
    "还有",
    "顺便",
    "再加",
    "新增",
    "加一个",
    "加个",
    "再做一个",
    "下一个",
    "接着加",
    "继续加",
];

const NEGATION: &[&str] = &[
    "不要",
    "不用",
    "别",
    "无需",
    "不需要",
    "先别",
    "not",
    "don't",
    "do not",
    "no need to",
];

fn mask_code(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    let mut fence = false;
    let mut inline = false;
    while let Some(ch) = chars.next() {
        if ch == '`' {
            let mut count = 1;
            while chars.peek() == Some(&'`') {
                chars.next();
                count += 1;
            }
            if count >= 3 {
                fence = !fence;
            } else if !fence {
                inline = !inline;
            }
            out.push(' ');
            continue;
        }
        if fence {
            out.push(if ch == '\n' { '\n' } else { ' ' });
            continue;
        }
        if inline {
            if ch == '\n' {
                inline = false;
                out.push('\n');
            } else {
                out.push(' ');
            }
            continue;
        }
        out.push(ch);
    }
    out
}

fn negated(text: &str, index: usize) -> bool {
    let before: String = text[..index]
        .chars()
        .rev()
        .take(24)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let before = before.trim_end().to_lowercase();
    NEGATION.iter().any(|marker| before.ends_with(marker))
}

fn contains_any(text: &str, lower: &str, needles: &[&str]) -> bool {
    for needle in needles {
        if needle.is_empty() {
            continue;
        }
        let mut from = 0;
        while from < lower.len() {
            let Some(pos) = lower[from..].find(needle) else {
                break;
            };
            let index = from + pos;
            if !negated(text, index) {
                return true;
            }
            from = index + needle.len().max(1);
        }
    }
    false
}

fn phrase_hit(text: &str, lower: &str, phrases: &[String]) -> bool {
    for phrase in phrases {
        let needle = phrase.trim().to_lowercase();
        if needle.is_empty() {
            continue;
        }
        let mut from = 0;
        while from < lower.len() {
            let Some(pos) = lower[from..].find(&needle) else {
                break;
            };
            let index = from + pos;
            if !negated(text, index) {
                return true;
            }
            from = index + needle.len().max(1);
        }
    }
    false
}

fn explicit_command(text: &str) -> Option<&'static str> {
    let trimmed = text.trim_start();
    for (command, mode) in [("/plan", "plan"), ("/exec", "execute")] {
        if let Some(rest) = trimmed.strip_prefix(command) {
            if rest.is_empty() || rest.chars().next().map(char::is_whitespace).unwrap_or(true) {
                return Some(mode);
            }
        }
    }
    None
}

fn ack_only(text: &str) -> bool {
    let trimmed = text.trim().trim_end_matches(|ch: char| {
        matches!(
            ch,
            '。' | '！' | '!' | '.' | ',' | '，' | ' ' | '\t' | '\n' | '\r'
        )
    });
    matches!(
        trimmed.to_lowercase().as_str(),
        "继续"
            | "继续执行"
            | "继续实现"
            | "继续做"
            | "好的"
            | "好"
            | "可以"
            | "行"
            | "ok"
            | "okay"
            | "continue"
            | "proceed"
            | "执行"
            | "开始"
            | "按计划执行"
            | "按计划实现"
            | "执行计划"
            | "开干"
            | "开工"
            | "动手"
            | "动手吧"
    )
}

fn has_imperative(lower: &str) -> bool {
    IMPERATIVE.iter().any(|word| lower.contains(word))
}

fn has_wish(lower: &str) -> bool {
    has_imperative(lower) || WISH.iter().any(|word| lower.contains(word))
}

fn has_new_task_marker(lower: &str) -> bool {
    NEW_TASK.iter().any(|word| lower.contains(word))
}

fn is_question(text: &str, lower: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.ends_with('?')
        || trimmed.ends_with('？')
        || trimmed.ends_with('吗')
        || trimmed.ends_with('呢')
    {
        return true;
    }
    [
        "为什么",
        "为啥",
        "什么",
        "怎么",
        "如何",
        "哪",
        "谁",
        "多少",
        "是否",
        "能不能",
        "可不可以",
        "会不会",
        "有没有",
        "解释",
        "说明",
        "介绍一下",
        "讲讲",
        "告诉我",
    ]
    .iter()
    .any(|word| lower.starts_with(word))
}

/// Hybrid C: new wishes start on the planner, pure questions answer directly,
/// and a session keeps its mode until a new wish or an explicit command.
pub fn classify(
    message: &str,
    current: Option<&str>,
    plan_ready: bool,
    rules: &RouteRules,
) -> Decision {
    let masked = mask_code(message);
    let text = masked.trim();
    if text.is_empty() {
        return match current {
            Some("execute") => decide_execute("sticky", "空消息沿用执行模式"),
            _ => decide_plan("sticky", "空消息沿用规划模式"),
        };
    }
    let lower = text.to_lowercase();

    if let Some(mode) = explicit_command(text) {
        return if mode == "plan" {
            decide_plan("command", "显式 /plan")
        } else {
            decide_execute("command", "显式 /exec")
        };
    }

    if phrase_hit(text, &lower, &rules.replan_phrases)
        || (rules.use_builtin && contains_any(text, &lower, REPLAN))
    {
        return decide_plan("replan", "检测到回到规划的意图");
    }

    if rules.use_builtin && has_new_task_marker(&lower) && has_imperative(&lower) {
        return decide_plan("new-wish", "检测到同一轮里的新需求");
    }

    if phrase_hit(text, &lower, &rules.execute_phrases)
        || (rules.use_builtin && contains_any(text, &lower, EXECUTE))
    {
        if current == Some("plan") && !plan_ready {
            return decide_plan("plan-not-ready", "执行意图已识别，但 PLAN.md 尚未写入");
        }
        return decide_execute("execute-intent", "检测到继续执行的意图");
    }

    if rules.use_builtin && ack_only(text) {
        if current == Some("plan") && !plan_ready {
            return decide_plan("plan-not-ready", "确认执行，但 PLAN.md 尚未写入");
        }
        return decide_execute("ack", "确认执行");
    }

    let imperative = has_imperative(&lower);
    if rules.use_builtin && is_question(text, &lower) && !imperative {
        if current == Some("plan") {
            return decide_plan("sticky-question", "规划阶段的问题仍由规划模型回答");
        }
        return decide_execute("question", "纯问题直接回答");
    }

    if imperative || has_wish(&lower) {
        return decide_plan("wish-intent", "检测到新的需求，先进入规划");
    }

    match current {
        Some("plan") => decide_plan("sticky", "沿用规划模式"),
        Some("execute") => decide_execute("sticky", "沿用执行模式"),
        _ if rules.default_mode.eq_ignore_ascii_case("execute") => {
            decide_execute("default", "默认执行模式")
        }
        _ => decide_plan("default", "新任务默认先规划"),
    }
}

// ── Route execution ─────────────────────────────────────────────────────────

fn build_decision(
    state: &RouteState,
    decision: &Decision,
    plan_ready: bool,
    session: &str,
) -> Value {
    let role = if decision.mode == "plan" {
        "plan"
    } else {
        "default"
    };
    let mut selector = state
        .roles
        .get(role)
        .cloned()
        .filter(|s| !s.trim().is_empty());
    let mut fallback = false;
    if selector.is_none() && role == "plan" {
        selector = state
            .roles
            .get("default")
            .cloned()
            .filter(|s| !s.trim().is_empty());
        fallback = selector.is_some();
    }
    let known = known_models();
    let (model, thinking) = selector
        .as_deref()
        .map(|s| roles::decode_selector(s, &known))
        .unwrap_or((String::new(), None));
    let effective_thinking = thinking
        .clone()
        .or_else(|| state.default_thinking_level.clone());

    let mut out = json!({
        "mode": decision.mode.clone(),
        "source": decision.source.clone(),
        "reason": decision.reason.clone(),
        "role": role,
        "selector": selector.clone(),
        "model": if model.is_empty() { Value::Null } else { json!(model) },
        "thinking": thinking.clone(),
        "effectiveThinking": effective_thinking,
        "planReady": plan_ready,
        "fallback": fallback,
        "sessionId": session,
        "defaultThinkingLevel": state.default_thinking_level.clone(),
    });
    if out["selector"].is_null() {
        out["error"] = json!(format!("OMP 未配置 {role} 模型"));
    }
    out
}

pub fn latest_cwd() -> Option<String> {
    let state = load_state();
    state
        .sessions
        .values()
        .filter_map(|session| session.cwd.as_ref().map(|cwd| (session.updated_at, cwd.clone())))
        .max_by_key(|(updated_at, _)| *updated_at)
        .map(|(_, cwd)| cwd)
}

/// Entry point for both the CLI (`orzic-fusion route`) and MCP (`fusion_route`).
/// `event`: `refresh` | `plan-written` | `rework` | `reset`.
pub fn route(
    message: &str,
    session: &str,
    cwd: &str,
    event: Option<&str>,
) -> Result<Value, String> {
    let _guard = ROUTE_LOCK
        .lock()
        .map_err(|_| "路由状态锁不可用".to_string())?;
    let mut state = load_state();
    let session = if session.trim().is_empty() {
        "default"
    } else {
        session.trim()
    };
    let cwd_value = if cwd.trim().is_empty() {
        None
    } else {
        Some(cwd.to_string())
    };

    let stale = now_ms().saturating_sub(state.roles_at) > 10 * 60 * 1000;
    let config_changed = state.config_mtime != config_mtime();
    if state.roles.is_empty() || stale || config_changed || event == Some("refresh") {
        if let Err(err) = refresh_roles(&mut state) {
            if state.roles.is_empty() {
                return Err(err);
            }
        }
    }

    match event {
        Some("refresh") => {
            save_state(&state)?;
            return Ok(json!({
                "ok": true,
                "roles": state.roles.clone(),
                "defaultThinkingLevel": state.default_thinking_level.clone(),
                "statePath": state_path().to_string_lossy(),
            }));
        }
        Some("plan-written") => {
            state.sessions.insert(
                session.to_string(),
                SessionState {
                    mode: "execute".into(),
                    updated_at: now_ms(),
                    source: "plan-written".into(),
                    cwd: cwd_value.clone(),
                },
            );
            save_state(&state)?;
            let decision = decide_execute("plan-written", "PLAN.md 已写入，切换到执行");
            return Ok(build_decision(&state, &decision, true, session));
        }
        Some("rework") => {
            state.sessions.insert(
                session.to_string(),
                SessionState {
                    mode: "execute".into(),
                    updated_at: now_ms(),
                    source: "rework".into(),
                    cwd: cwd_value.clone(),
                },
            );
            save_state(&state)?;
            let decision = decide_execute("rework", "自动返工，保持执行模型");
            return Ok(build_decision(&state, &decision, true, session));
        }
        Some("reset") => {
            state.sessions.remove(session);
            save_state(&state)?;
            return Ok(json!({
                "ok": true,
                "reset": true,
                "sessionId": session,
            }));
        }
        _ => {}
    }

    let ready = plan_ready(cwd);
    let current = state.sessions.get(session).map(|s| s.mode.clone());
    let decision = classify(message, current.as_deref(), ready, &state.rules);
    state.sessions.insert(
        session.to_string(),
        SessionState {
            mode: decision.mode.clone(),
            updated_at: now_ms(),
            source: decision.source.clone(),
            cwd: cwd_value.clone(),
        },
    );
    save_state(&state)?;
    Ok(build_decision(&state, &decision, ready, session))
}

// ── OMP extension install ───────────────────────────────────────────────────

const EXTENSION_SOURCE: &str = include_str!("../extensions/fusion-loop.ts");

pub fn install_extension() -> Result<Value, String> {
    let dir = omp_agent_dir().join("extensions");
    fs::create_dir_all(&dir)
        .map_err(|e| format!("无法创建 OMP 扩展目录 {}: {e}", dir.display()))?;
    let path = dir.join("fusion-loop.ts");
    write_text_atomic(&path, EXTENSION_SOURCE, None)?;

    let exe = current_exe_string();
    let info_path = omp_agent_dir().join("orzic-fusion-install.json");
    write_text_atomic(
        &info_path,
        &serde_json::to_string_pretty(&json!({
            "exe": exe,
            "installedAt": now_ms(),
        }))
        .map_err(|e| e.to_string())?,
        None,
    )?;

    let current = omp::cli_json(&["config", "get", "extensions"])?;
    let mut list = current
        .get("value")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let target = path.to_string_lossy().to_string();
    if !list.iter().any(|value| value.as_str() == Some(target.as_str())) {
        list.push(json!(target));
    }
    omp::cli_plain(&[
        "config",
        "set",
        "extensions",
        &serde_json::to_string(&Value::Array(list)).map_err(|e| e.to_string())?,
    ])?;

    let mut state = load_state();
    let _ = refresh_roles(&mut state);
    let _ = save_state(&state);

    Ok(json!({
        "installed": true,
        "registered": true,
        "extension": target,
        "exe": exe,
        "routeState": state_path().to_string_lossy(),
    }))
}

pub fn uninstall_extension() -> Result<Value, String> {
    let path = omp_agent_dir().join("extensions").join("fusion-loop.ts");
    let target = path.to_string_lossy().to_string();
    let current = omp::cli_json(&["config", "get", "extensions"])?;
    let list = current
        .get("value")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let next: Vec<Value> = list
        .into_iter()
        .filter(|value| value.as_str() != Some(target.as_str()))
        .collect();
    omp::cli_plain(&[
        "config",
        "set",
        "extensions",
        &serde_json::to_string(&Value::Array(next)).map_err(|e| e.to_string())?,
    ])?;
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|e| format!("无法删除 {}: {e}", path.display()))?;
    }
    Ok(json!({ "removed": true, "extension": target }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules() -> RouteRules {
        RouteRules::default()
    }

    #[test]
    fn new_wish_starts_on_the_planner() {
        let decision = classify("帮我做一个登录页面，按这张截图的感觉来", None, false, &rules());
        assert_eq!(decision.mode, "plan");
        assert_eq!(decision.source, "wish-intent");
    }

    #[test]
    fn pure_question_executes_when_not_planning() {
        let decision = classify("为什么这个按钮不显示？", None, false, &rules());
        assert_eq!(decision.mode, "execute");
        assert_eq!(decision.source, "question");
    }

    #[test]
    fn question_during_planning_stays_on_planner() {
        let decision = classify("这个是什么意思？", Some("plan"), false, &rules());
        assert_eq!(decision.mode, "plan");
        assert_eq!(decision.source, "sticky-question");
    }

    #[test]
    fn continuation_without_plan_does_not_escape_planning() {
        let decision = classify("继续执行", Some("plan"), false, &rules());
        assert_eq!(decision.mode, "plan");
        assert_eq!(decision.source, "plan-not-ready");
    }

    #[test]
    fn continuation_after_plan_switches_to_executor() {
        let decision = classify("继续执行", Some("plan"), true, &rules());
        assert_eq!(decision.mode, "execute");
    }

    #[test]
    fn negation_blocks_execution_phrase() {
        let decision = classify("先别执行，再评估一下", Some("execute"), true, &rules());
        assert_eq!(decision.mode, "plan");
        assert_eq!(decision.source, "replan");
    }

    #[test]
    fn code_blocks_are_masked() {
        let decision = classify("```\n开始执行\n```\n这是什么意思？", None, false, &rules());
        assert_eq!(decision.mode, "execute");
        assert_eq!(decision.source, "question");
    }

    #[test]
    fn new_wish_mid_execution_returns_to_planning() {
        let decision = classify("另外再加一个导出按钮", Some("execute"), true, &rules());
        assert_eq!(decision.mode, "plan");
        assert_eq!(decision.source, "new-wish");
    }

    #[test]
    fn explicit_command_wins() {
        assert_eq!(classify("/plan 直接做", Some("execute"), true, &rules()).mode, "plan");
        assert_eq!(classify("/exec 别规划了", Some("plan"), false, &rules()).mode, "execute");
    }

    #[test]
    fn ambiguous_message_keeps_the_current_mode() {
        let decision = classify("嗯，这个方向可以", Some("execute"), true, &rules());
        assert_eq!(decision.mode, "execute");
        assert_eq!(decision.source, "sticky");
    }
}
