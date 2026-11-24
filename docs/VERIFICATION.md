# Verification

This page records the behavior behind the public 0.2.x release and the checks run for it.

## Session behavior

The live-session behavior was implemented before the 0.2.0 packaging commit, not in that commit alone:

| Commit | Change |
|---|---|
| `05d3fe1` | Read Orca agent state via `workspace.list` + `agents.list`, match by session id, request `agent:read` / `workspace:read` |
| `624e7fd` | Subscribe to `agent.status.changed`, surface host-read failures, keep recent records when active state is unknown |
| `b28d9cf` | Active-first ordering, then newest activity |
| `8e97ea9` | Looser session-row layout; no separate model caption |
| `e5f4b3c` | Preserve event state across late snapshots; only `working` survives the 20-minute window |

Related regression coverage:

- `orzic-session-state.test.mjs` — session id comes from the JSONL suffix; two sessions in the same project keep distinct ids; a status event only changes the matching id; 20-minute boundary; working-beyond-window visibility; active/inactive sorting and tie-break; late snapshot override release.
- `panel.test.tsx` — persisted/visible session rows use their own models; active-but-old rows stay visible; old idle rows do not; planning renders as `规划`, not `主脑`; a `working → done` event updates only that row; a host read failure is shown without hiding recent rows.
- `npm test` → 150 tests, 149 passed, 1 skipped.
- `npm run typecheck` → passed.
- `orca plugin check .` → panel rendered; the stand-in host warning comes from the test host, not a panel error.
- `orca plugin validate .` → `esseener.orcai` 0.2.5 valid, no errors.

## Routing rules

The editable switch rules live in the same `orzic-acceptance.json` as the route models:

| Field | Behavior |
|---|---|
| `routing.useBuiltin` | When false, only the custom phrase lists participate |
| `routing.replanPhrases` | Literal, case-insensitive; a match returns the next execution-phase message to the planner and wins over both custom and built-in execute phrases |
| `routing.executePhrases` | Literal, case-insensitive; keeps an already handed-off session on the executor |
| `routing.planRequired` | Literal, case-insensitive; every entry must appear in `PLAN.md` before the handoff |

New tasks still start on the planner, and a custom execute phrase cannot bypass `PLAN.md`. The extension reads the file on each message, so a panel save applies to the next message without an OMP restart.

Coverage:

- `orzic-routing.test.mjs` — defaults, normalization and limits, custom re-plan priority, built-in off, custom execute, plan-required matching, legacy-empty preservation, explicit empty saves, preset-vs-replan precedence, negated English, and the bare-`开始` question.
- `orzic-loop.test.mjs` — custom execute cannot skip planning; custom execute keeps a handed-off session on the executor; custom and built-in re-plan precedence; a bare-`开始` question stays on the planner; missing `PLAN.md` markers block handoff; editing the rule file applies without reload.
- `panel.test.tsx` — starter rules prefill without a write; `填入常用规则` changes only the draft; explicit empty saves and reopens empty; the fixed gate is visible; cancel and failed-save paths still hold.

`npm test` → 150 tests, 149 passed, 1 skipped; `npm run typecheck` → passed.

## Acceptance criteria and review range (0.2.5)

- `criteria` is an editable string in the acceptance config. The panel pre-fills `DEFAULT_ACCEPTANCE_CRITERIA`; saving it sends `criteria` through `fusion.set`. The OMP judge (manual and detached driver) appends it to the prompt as `验收标准(逐条核对,不满足即 finding)`. The external `ocr` path still uses `rule.json`.
- The detached driver reads the approved plan's `baseRevision` and reviews `git diff <base>..<HEAD>`. If the base is missing or not an ancestor, it falls back to `HEAD`/`HEAD~1`; a plan with no base is still reviewable.
- The deterministic `checkCmd` gate runs before the paid judge in both paths; a failure returns `REWORK` with a `(check)` finding.
- The panel's `运行验收` button is always visible, including when `ocr` is off; in that mode manual review uses the OMP judge. Manual review also runs `checkCmd`, so it can short-circuit before the judge.
- Coverage: `acceptance.test.ts` (failing manual check → rework, no judge); `orzic-driver.test.mjs` (criteria in prompt; plan-base diff includes runtime and docs commits); `panel.test.tsx` (criteria prefill, save, and manual review without `ocr`).

## Ordering decision

The active-first ordering is intentional. The earlier prototype kept every row in a fixed slot, but the product request changed to: active sessions at the top, then the rest by time, with more active/recent sessions first. The README states that a status or activity change moves a row. The list does not reorder just because the same snapshot is redrawn.

## Identity and minimum Orca

- Plugin id is `orcai`; the existing `esseener/orzic` repository is a different Team Flow plugin and already owns the `orzic` id.
- Panel id remains `orzic`, so `--panel orzic` keeps working for existing scripts.
- Minimum Orca is `>=1.4.268`: the `agents.list` `workspaceId` parameter belongs to host API 1.10 (Orca 1.4.260), so 1.4.268 includes it.
- Upgrade path: unload the old development key `local.orzic`, load the new `esseener.orcai`, and copy any notes first because plugin storage is not migrated across identities.

## Editable routing (0.2.3+)

- Starter presets cover re-planning, execution continuations, and negative phrases.
- 0.2.4 tried to migrate a pre-preset empty config to the starter presets. That was wrong: an old empty default and an explicit empty save have the same stored shape before `presetVersion` existed. 0.2.5 keeps both empty; the editor prefills the starter rules as an unsaved draft, and only `保存规则` writes `presetVersion: 1`.
- Matching precedence is: custom re-plan phrases, built-in re-plan recognition, custom execute phrases, built-in short/execute recognition. This keeps `先评估风险，再决定是否开始执行` on the planner even when `开始执行` is a preset. A custom execute phrase that intentionally contains re-plan words requires turning built-in recognition off.
- `orzic-routing.test.mjs` covers literal phrase normalization/deduplication, custom execution and re-plan phrases, re-plan precedence over presets, legacy empty preservation, explicit empty saves, negated English input, and the bare-`开始` question false positive.
- `orzic-loop.test.mjs` covers a custom execution phrase, custom re-plan precedence, built-in re-plan precedence over a saved execution preset, a bare-`开始` question staying on the planner, a rejected plan missing required content, and changing the rule file before the next prompt without reloading.
- `panel.test.tsx` covers starter-rule prefill without a write, `填入常用规则` changing only the draft, explicit empty save and reopen, the visible fixed `PLAN.md` gate, and the existing save/cancel/error paths.
- `npm test` → 150 tests, 149 passed, 1 skipped; `npm run typecheck` → passed.

## Live panel and install verification (0.2.5)

- `npm run check:version` → manifest, package, lock, and panel all report `0.2.5`.
- `orca plugin install .` → installed `esseener.orcai` 0.2.5; it asked for no new access and kept the existing approval. `orca plugin list` shows it `running` as `trusted-worker`.
- `orca plugin shot esseener.orcai --panel orzic --json` → settled, no panel errors, no pending host requests.
- `orca plugin check .` → panel rendered; the only warning is the stand-in host's missing `workspace.list`, not a panel error.
- `npm test` → 150 tests, 149 passed, 1 skipped; `npm run typecheck` → passed.

## Live panel and install verification (0.2.4)

- Packed with `npm pack` (`orca-plugin-0.2.4.tgz`), installed with `orca plugin install ./orca-plugin-0.2.4.tgz`; Orca reported a successful install and `orca plugin list` showed `esseener.orcai` 0.2.4.
- Opened the packaged panel with `orca plugin open --panel orzic`; the rendered editor showed the 20 re-plan phrases and 20 execute phrases, the three field labels, and the save/fill actions. No development overlay was present.
- `orca plugin request fusion.status` against the installed worker returned the full normalized routing payload (20/20/0) and the current models; the panel rendered the same values.

## Published artifact

- Repository: `https://github.com/esseener/orcai`
- Release: `v0.2.0` (first public package); `v0.2.1` restores the panel id; `v0.2.2` corrects the development key, upgrade notes, and verified minimum Orca version.
- `orca plugin release-entry .` on the tagged commit reports plugin key `esseener.orcai`, execution `trusted-worker`, and the expected capabilities/contributions.
