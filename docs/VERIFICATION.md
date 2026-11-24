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
- `npm test` → 139 tests, 138 passed, 1 skipped.
- `npm run typecheck` → passed.
- `orca plugin check .` → panel rendered with no issues or warnings.
- `orca plugin validate .` → `esseener.orcai` 0.2.2 valid, no errors.

## Routing rules

The editable switch rules live in the same `orzic-acceptance.json` as the route models:

| Field | Behavior |
|---|---|
| `routing.useBuiltin` | When false, only the custom phrase lists participate |
| `routing.replanPhrases` | Literal, case-insensitive; a match returns the next execution-phase message to the planner and wins over an execute phrase |
| `routing.executePhrases` | Literal, case-insensitive; keeps an already handed-off session on the executor |
| `routing.planRequired` | Literal, case-insensitive; every entry must appear in `PLAN.md` before the handoff |

New tasks still start on the planner, and a custom execute phrase cannot bypass `PLAN.md`. The extension reads the file on each message, so a panel save applies to the next message without an OMP restart.

Coverage:

- `orzic-routing.test.mjs` — defaults, normalization and limits, custom re-plan priority, built-in off, custom execute, and plan-required matching.
- `orzic-loop.test.mjs` — custom execute cannot skip planning; custom execute keeps a handed-off session on the executor; custom re-plan wins; missing `PLAN.md` markers block handoff; editing the rule file applies without reload.
- `panel.test.tsx` — rules save with normalized values; cancel writes nothing; a rejected save shows the error.

`npm test` → 139 tests, 138 passed, 1 skipped; `npm run typecheck` → passed.

## Ordering decision

The active-first ordering is intentional. The earlier prototype kept every row in a fixed slot, but the product request changed to: active sessions at the top, then the rest by time, with more active/recent sessions first. The README states that a status or activity change moves a row. The list does not reorder just because the same snapshot is redrawn.

## Identity and minimum Orca

- Plugin id is `orcai`; the existing `esseener/orzic` repository is a different Team Flow plugin and already owns the `orzic` id.
- Panel id remains `orzic`, so `--panel orzic` keeps working for existing scripts.
- Minimum Orca is `>=1.4.268`: the `agents.list` `workspaceId` parameter belongs to host API 1.10 (Orca 1.4.260), so 1.4.268 includes it.
- Upgrade path: unload the old development key `local.orzic`, load the new `esseener.orcai`, and copy any notes first because plugin storage is not migrated across identities.

## Editable routing (0.2.2)

- `orzic-routing.test.mjs` covers literal phrase normalization/deduplication, custom execution and re-plan phrases, re-plan precedence, and case-insensitive `PLAN.md` requirements.
- `orzic-loop.test.mjs` covers a custom execution phrase, custom re-plan precedence, a rejected plan missing required content, and changing the rule file before the next prompt without reloading.
- `panel.test.tsx` covers opening the editor, saving phrases through `fusion.set`, cancelling without writing, and showing a failed save; 139 tests, 138 passed, 1 skipped.
- Active-first ordering is a later product request and intentionally moves rows when host state or recency changes; the README documents this behavior.

## Published artifact

- Repository: `https://github.com/esseener/orcai`
- Release: `v0.2.0` (first public package); `v0.2.1` restores the panel id; `v0.2.2` corrects the development key, upgrade notes, and verified minimum Orca version.
- `orca plugin release-entry .` on the tagged commit reports plugin key `esseener.orcai`, execution `trusted-worker`, and the expected capabilities/contributions.
