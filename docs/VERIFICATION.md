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
- `npm test` → 126 tests, 125 passed, 1 skipped.
- `npm run typecheck` → passed.
- `orca plugin check .` → panel rendered with no issues or warnings.
- `orca plugin validate .` → `esseener.orcai` 0.2.1 valid, no errors.

## Ordering decision

The active-first ordering is intentional. The earlier prototype kept every row in a fixed slot, but the product request changed to: active sessions at the top, then the rest by time, with more active/recent sessions first. The README states that a status or activity change moves a row. The list does not reorder just because the same snapshot is redrawn.

## Identity and minimum Orca

- Plugin id is `orcai`; the existing `esseener/orzic` repository is a different Team Flow plugin and already owns the `orzic` id.
- Panel id remains `orzic`, so `--panel orzic` keeps working for existing scripts.
- Minimum Orca remains `>=1.4.268`. The host API 1.10 `workspaceId` parameter used by `agents.list` shipped in Orca 1.4.260, so 1.4.268 includes it.
- Upgrade path: unload the old development key `local.orzic`, load the new `local.orcai`, and copy any notes first because plugin storage is not migrated across identities.

## Published artifact

- Repository: `https://github.com/esseener/orcai`
- Release: `v0.2.0` (first public package); `v0.2.1` restores the panel id and minimum-version compatibility.
- `orca plugin release-entry .` on the tagged commit reports plugin key `esseener.orcai`, execution `trusted-worker`, and the expected capabilities/contributions.
