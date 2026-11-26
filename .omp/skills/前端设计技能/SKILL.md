---
name: 前端设计技能
description: 前端设计技能。Use when changing or reviewing the Orzic for Fusion local console UI in Orzic for fusion/src/ui; covers poster-style layout, pure-black top bar, offline assets, responsive states, and browser verification.
---

# 前端设计技能（Fusion UI）

Use this for the Fusion console only. It is a working night desk, not a marketing site. Preserve the model pickers, save flow, MCP registration, session gates, and PASS/REWORK states.

## Visual direction

- The top bar is full-bleed `#000000`, edge to edge. Set `<meta name="theme-color" content="#000000">` for the app window frame and use a zero-width `<title>` so the title bar has no text.
- Put the extracted white mark at the page top-left (50px) beside a 40px/700 `Orzic` wordmark, bottom-aligned, with a restrained shadow; do not shrink the wordmark on narrow screens. Keep the version pill and actions right-aligned, wrapping only when space runs out.
- Keep the favicon fully transparent (cache-busted `/favicon-v2.png`) so the native title bar has no icon. After the Edge app window appears, set `WM_SETICON` `ICON_BIG` from the EXE icon resource and `ICON_SMALL` to 0; this gives the taskbar the new mark while the title bar stays blank. Do not use a separate `--user-data-dir`, because that triggers Edge account sync prompts. Verify the real window frame and taskbar, not only a page screenshot.
- Build hierarchy with type and rules: one large page title, one short description, one clear primary action. The OMP detail is the exception: its heading names the Agent, and the three-step poster strips carry the visual weight. Do not put every section in the same rounded card.
- The role page may use a poster composition: a compact heading beside three staggered strips labelled `01` plan, `02` execute, `03` review. The strips are decorative and must be `aria-hidden`; never make them look like clickable controls.
- Use the page number and kicker as orientation, not as an extra card. Only the two top-level pages carry numbers (`01` agents, `02` overview); an Agent detail is a sub-view with a back link and its name as the title, never a numbered page.
- The reference screenshots are direction, not assets. Do not copy torn paper, stars, illustrations, screenshots, or their copy.
- One accent (cobalt), one paper text colour, one graphite surface ramp. Green, amber, and red are status only and always carry a text label.

## Hard constraints

- All UI resources are embedded with `include_str!` / `include_bytes!` and served under `default-src 'self'; script-src 'self'`. No CDN, remote fonts, GSAP runtime, external images, or inline event handlers.
- Prefer the Windows system font stack. If a local display font is truly needed, put the licensed file in `src/ui/`, add a same-origin route, and verify the licence first.
- Use CSS/WAAPI for motion only when it explains a state change. Respect `prefers-reduced-motion`.
- Keep the existing DOM ids and form/event contracts unless the change requires a matching JS edit.
- `html, body { overflow-x: clip; }`; grid tracks use `minmax(0, 1fr)`; long model names, paths, and diffs must wrap inside their own region.
- Every interactive element has a visible `:focus-visible`. The model popover must stay inside the viewport and be keyboard reachable.

## Page patterns

- Agents: the home page is a directory. Each row shows name, kind, managed capabilities, registration status, and one `查看配置` action, without a config path and without writing config inline. Custom JSON and snippets stay as separate sections below.
- Agent detail: a back link, the Agent name as the title, then a compact MCP card (status, path, format, register/unregister, remove custom record), followed by only the capabilities that Agent really has. A target without an adapter gets the MCP card plus a `仅支持 MCP 注册` note, never model or session forms.
- OMP detail: three-step poster strips, a quiet routing settings strip, then plan/execute/review groups with role rows. Save bar stays visible but does not cover controls.
- OpenCode/Codex detail: role row grid, a task sheet, then real plan/execute/review output. Environment details are secondary and must not repeat the MCP summary.
- Overview: Fusion's own version/executable plus a per-Agent capability and registration summary, then a separate cross-agent usage block. Do not put one adapter's runtime snapshot here.

## Verification

Before handing back:

1. Build the release binary; the HTML/CSS/JS are embedded, so an old EXE will not show the new UI.
2. Open the actual local console at 1365×768 and 390px, plus 320px for crowding.
3. Check the computed top-bar background is `rgb(0, 0, 0)` across the full width, including wrapped narrow layout.
4. Exercise model search, select/clear, thinking choice, reset/save, connector snippet switch/copy, and session disabled states.
5. Check no horizontal overflow, no clipped popover, no console errors, visible keyboard focus, and reduced-motion behavior.
6. Capture desktop and narrow screenshots for the handoff; do not use a mockup as evidence.

## Sources

- Hallmark, floor rules only (this is an existing console, not a new page): https://github.com/Nutlope/hallmark/blob/main/skills/hallmark/SKILL.md
- Frontend Design: https://github.com/anthropics/skills/tree/main/skills/frontend-design
- Taste Skill: https://github.com/Leonxlnx/taste-skill
- UI/UX Pro Max: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill
- gstack design review checklists: https://github.com/garrytan/gstack/blob/main/docs/skills.md
- Web Design Guidelines: https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines
- GSAP Skills, principles only: https://github.com/greensock/gsap-skills
- design-md-chrome, token-extraction idea only: https://github.com/bergside/design-md-chrome
