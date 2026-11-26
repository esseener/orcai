use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::BTreeSet;

/// OMP accepts these as `--thinking` values and as the `:<level>` suffix on a
/// model selector stored in `modelRoles`.
pub const THINKING_LEVELS: &[&str] = &[
    "off", "minimal", "low", "medium", "high", "xhigh", "max", "auto",
];

/// Roles OMP itself consumes. Anything else in `modelRoles` is preserved and
/// shown as a custom role instead of being dropped.
pub const ROLE_DEFS: &[(&str, &str, &str)] = &[
    ("plan", "规划 Plan", "只读规划阶段使用的模型"),
    ("default", "执行 Execute", "执行阶段的主模型"),
    ("advisor", "顾问 Advisor", "每轮被动审查并注入建议"),
    ("smol", "轻量 Smol", "快速 / 低成本任务"),
    ("slow", "深思 Slow", "需要深入分析的任务"),
    ("review", "审查 Review", "独立验收 / 评审"),
];

pub fn is_thinking_level(value: &str) -> bool {
    THINKING_LEVELS
        .iter()
        .any(|level| level.eq_ignore_ascii_case(value))
}

/// Split a stored selector into `(model, thinking)`.
///
/// Model IDs may themselves contain `:` (e.g.
/// `magpie/work/global:deepseek-v4.1-flash-sg`), so a known selector always
/// wins over suffix splitting. Only a suffix that is a real thinking level and
/// whose base is a known selector is treated as effort; the final fallback
/// still accepts any `:<level>` suffix so a stale catalog does not break reads.
pub fn decode_selector(raw: &str, known: &BTreeSet<String>) -> (String, Option<String>) {
    let selector = raw.trim();
    if selector.is_empty() {
        return (String::new(), None);
    }
    if known.contains(selector) {
        return (selector.to_string(), None);
    }
    if let Some((base, effort)) = selector.rsplit_once(':') {
        if !base.is_empty() && is_thinking_level(effort) {
            return (base.to_string(), Some(effort.to_ascii_lowercase()));
        }
    }
    (selector.to_string(), None)
}

pub fn encode_selector(model: &str, thinking: Option<&str>) -> String {
    let model = model.trim();
    match thinking.map(str::trim).filter(|level| !level.is_empty()) {
        Some(level) => format!("{model}:{}", level.to_ascii_lowercase()),
        None => model.to_string(),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RoleView {
    pub role: String,
    pub label: String,
    pub description: String,
    pub raw: String,
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub custom: bool,
}

fn role_def(role: &str) -> (&'static str, &'static str) {
    ROLE_DEFS
        .iter()
        .find(|(name, _, _)| *name == role)
        .map(|(_, label, description)| (*label, *description))
        .unwrap_or(("自定义 Custom", "OMP 中已有的其他模型角色"))
}

fn view(role: &str, raw: &str, known: &BTreeSet<String>) -> RoleView {
    let (model, thinking) = decode_selector(raw, known);
    let (label, description) = role_def(role);
    RoleView {
        role: role.to_string(),
        label: label.to_string(),
        description: description.to_string(),
        raw: raw.to_string(),
        model: if model.is_empty() { None } else { Some(model) },
        thinking,
        custom: !ROLE_DEFS.iter().any(|(name, _, _)| *name == role),
    }
}

/// Every known role is returned even when OMP has no assignment for it, so the
/// console can offer an empty picker instead of hiding the role.
pub fn parse_roles(raw: Option<&Value>, known: &BTreeSet<String>) -> Vec<RoleView> {
    let map = raw.and_then(Value::as_object);
    let mut out = Vec::new();
    for (role, _, _) in ROLE_DEFS {
        let value = map
            .and_then(|m| m.get(*role))
            .and_then(Value::as_str)
            .unwrap_or("");
        out.push(view(role, value, known));
    }
    if let Some(m) = map {
        let mut extras: Vec<(&String, &Value)> = m
            .iter()
            .filter(|(key, _)| !ROLE_DEFS.iter().any(|(role, _, _)| role == key))
            .collect();
        extras.sort_by(|a, b| a.0.cmp(b.0));
        for (key, value) in extras {
            if let Some(selector) = value.as_str() {
                out.push(view(key, selector, known));
            }
        }
    }
    out
}

/// Merge role edits into the existing record. A blank model removes the role;
/// unknown roles already in the record are preserved untouched.
pub fn merge_roles(
    current: &Map<String, Value>,
    edits: &[(String, String, Option<String>)],
) -> Result<Map<String, Value>, String> {
    let mut roles = current.clone();
    for (role, model, thinking) in edits {
        let role = role.trim();
        if role.is_empty() {
            return Err("角色名不能为空".into());
        }
        let model = model.trim();
        if model.is_empty() {
            roles.remove(role);
            continue;
        }
        if let Some(level) = thinking.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
            if !is_thinking_level(level) {
                return Err(format!("未知思考强度：{level}"));
            }
        }
        let encoded = encode_selector(
            model,
            thinking.as_deref().map(str::trim).filter(|l| !l.is_empty()),
        );
        roles.insert(role.to_string(), Value::String(encoded));
    }
    Ok(roles)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn known() -> BTreeSet<String> {
        [
            "magpie/work/global:deepseek-v4.1-flash-sg",
            "devin/swe-2",
            "openai-codex/gpt-6.1-sol",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    }

    #[test]
    fn colon_inside_model_id_is_not_an_effort() {
        let (model, thinking) =
            decode_selector("magpie/work/global:deepseek-v4.1-flash-sg", &known());
        assert_eq!(model, "magpie/work/global:deepseek-v4.1-flash-sg");
        assert_eq!(thinking, None);
    }

    #[test]
    fn effort_suffix_is_split_when_base_is_known() {
        let (model, thinking) = decode_selector("devin/swe-2:max", &known());
        assert_eq!(model, "devin/swe-2");
        assert_eq!(thinking.as_deref(), Some("max"));
    }

    #[test]
    fn unknown_suffix_stays_part_of_the_model() {
        let (model, thinking) = decode_selector("vendor/model:variant", &known());
        assert_eq!(model, "vendor/model:variant");
        assert_eq!(thinking, None);
    }

    #[test]
    fn encode_decode_roundtrip_handles_colons_and_effort() {
        let set = known();
        let encoded = encode_selector("magpie/work/global:deepseek-v4.1-flash-sg", Some("xhigh"));
        assert_eq!(
            encoded,
            "magpie/work/global:deepseek-v4.1-flash-sg:xhigh"
        );
        let (model, thinking) = decode_selector(&encoded, &set);
        assert_eq!(model, "magpie/work/global:deepseek-v4.1-flash-sg");
        assert_eq!(thinking.as_deref(), Some("xhigh"));
    }

    #[test]
    fn merge_preserves_unknown_roles_and_clears_blank() {
        let current = json!({
            "default": "devin/swe-2:high",
            "plan": "openai-codex/gpt-6.1-sol",
            "bespoke": "vendor/other"
        })
        .as_object()
        .unwrap()
        .clone();

        let merged = merge_roles(
            &current,
            &[
                ("default".into(), "devin/swe-2".into(), Some("low".into())),
                ("plan".into(), "".into(), None),
            ],
        )
        .unwrap();

        assert_eq!(merged["default"], "devin/swe-2:low");
        assert!(merged.get("plan").is_none());
        assert_eq!(merged["bespoke"], "vendor/other");
    }

    #[test]
    fn parse_shows_every_builtin_role_and_extras() {
        let roles = parse_roles(
            Some(&json!({"default": "devin/swe-2:max", "bespoke": "vendor/other"})),
            &known(),
        );
        assert_eq!(roles.len(), ROLE_DEFS.len() + 1);
        let default = roles.iter().find(|r| r.role == "default").unwrap();
        assert_eq!(default.model.as_deref(), Some("devin/swe-2"));
        assert_eq!(default.thinking.as_deref(), Some("max"));
        assert!(roles.iter().any(|r| r.role == "bespoke" && r.custom));
        assert!(roles
            .iter()
            .any(|r| r.role == "plan" && r.model.is_none()));
    }

    #[test]
    fn invalid_effort_is_rejected() {
        let current = Map::new();
        let err = merge_roles(
            &current,
            &[("default".into(), "devin/swe-2".into(), Some("ultra".into()))],
        )
        .unwrap_err();
        assert!(err.contains("未知思考强度"));
    }
}
