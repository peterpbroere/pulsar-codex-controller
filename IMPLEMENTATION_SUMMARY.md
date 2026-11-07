# OpenCode session support — implementation summary

**Date:** 2026-11-07 · **Version base:** 0.1.17 (post `425e564`) · **Not committed** (working tree)

## What was added

Pulsar Codex Deck now monitors and controls local **OpenCode** TUI sessions alongside
Codex agents and ComfyUI instances. OpenCode becomes the third entry type
(`source:'opencode'`). Scope agreed with the maintainer:

- **Discovery:** automatic for TUI windows on this PC, zero configuration.
- **Control scope:** monitor + approve + abort + continue (full attention loop).
- **Key 2:** opens a TUI attached to the displayed session (`opencode attach <url> --session <id>`).
- **Model display:** the session's current model is shown like Codex's Model line.

## How discovery works

Every OpenCode TUI window and `opencode serve` instance hosts an HTTP server on
`127.0.0.1` at a randomly assigned port; headless `opencode run` processes bind
nothing. Every ~10 s Pulsar:

1. Runs `tasklist /FI "IMAGENAME eq opencode.exe"` and `netstat -ano` (both native
   Windows tools; no dependencies added).
2. Matches `LISTENING` TCP entries to OpenCode PIDs (`parseListeners`).
3. Verifies each candidate with `GET /global/health` (must return
   `healthy:true` + a version string).
4. Adds/removes servers; removed servers' rows disappear on the next scan.

Verified end-to-end against a locally spawned server before implementation.

## OpenCode APIs used

| Purpose | Endpoint |
| --- | --- |
| Server verify + version | `GET /global/health` |
| Session list (titles, directory, model) | `GET /session` |
| Per-session busy/idle/retry status | `GET /session/status` |
| Pending legacy permission requests | `GET /permission` |
| Pending v2 permission requests (per session) | `GET /api/session/{sessionID}/permission` → `{data:[…]}` |
| Live events (SSE, per server) | `GET /global/event` |
| Approve / reject a legacy permission | `POST /permission/{requestID}/reply` with `{reply:"once"\|"always"\|"reject"}` |
| Approve / reject a v2 permission | `POST /api/session/{sessionID}/permission/{requestID}/reply` with `{reply:"once"\|"always"\|"reject"}` |
| Abort a running turn | `POST /session/{id}/abort` |
| Send a Continue prompt | `POST /session/{id}/prompt_async` with `{parts:[{type:"text",text:"Continue"}]}` |

The SSE wire envelope is `{directory, project, payload:{id, type, properties}}`
(captured from a live 1.19.2 server); the monitor unwraps `payload` before
dispatching. Handled events: `session.updated`/`session.deleted` (title,
directory, model), `permission.asked`/`permission.v2.asked`,
`permission.replied`/`permission.v2.replied`, `session.error`,
`message.part.updated` (tool-name activity text).

Legacy (`/permission`) and v2 (`/api/session/…`) permission requests are
tracked separately. Legacy requests use the global list authoritatively. V2
requests arrive via SSE *and* are polled per busy session each cycle, so
requests that were already pending before Pulsar started (or before an SSE
reconnect) are discovered, and requests resolved elsewhere are dropped by the
authoritative per-session list.

## Architecture

- **`src/main/opencode.ts` (new)** — `OpenCodeMonitor`: discovery, polling
  (2 s), SSE streaming with reconnect, row building, and actions. Pure
  Electron-side HTTP; **no Python/backend changes and no Codex changes**.
  Injectable `now()` clock and `discover()` function for deterministic tests.
- **`src/shared/types.ts`** — `Row.source` is now `'comfyui'|'opencode'`; new
  `OpenCodeStatus` (`connected`, `url`, `port`, `version`, `model`, `modelVariant`).
- **`src/main/controller.ts`** — rows filter hides offline OpenCode entries from
  the pad (like ComfyUI); `action()` routes OpenCode verbs to an
  `opencode-action` intent; `modelLabel()` prefers the OpenCode model.
- **`src/main/display.ts`** — top line shows the model (clipped, e.g.
  `claude-sonnet-4-5 ·…`); right-hand status text shows `OPENCODE` instead of the
  Codex permission-mode label.
- **`src/main/index.ts`** — monitor wired into `syncSnapshot()`, a 1 s tick
  timer, intent routing (`opencode-action`, busy-wrapped; `focus` spawns a
  terminal without blocking), `close()` on quit, and an OpenCode demo row.
- **`src/main/voice-session.ts`** — voice explicitly refuses OpenCode entries
  (Codex-native voice does not apply).
- **`ui/app.js` / `ui/index.html`** — `OPENCODE` chips in the session list,
  model line in the details panel, sidebar retitle to “Agents & connections”.
  Offline OpenCode entries select normally (their panel explains the outage);
  only offline ComfyUI entries open the connection editor.

## Safety properties preserved

- **Approve only the exact shown request:** the row's control token *is* the
  OpenCode permission request ID; a new request changes the token, which clears
  the displayed-approval state (existing stale-check machinery), and the monitor
  re-validates the token before replying. Approval is `once` — single-use by
  OpenCode's own semantics.
- **Waiting is amber and wins** over error/running/idle, as everywhere else.
- Requests resolved elsewhere (another client, the TUI) are refused as stale
  with an honest notice; unsupported question types stay in OpenCode.
- Read-only monitoring elsewhere: no config changes, no session creation, no
  renames. Titles/directories are display-only.

## Row mapping

| OpenCode | Pad state |
| --- | --- |
| Permission pending | `waiting` · amber · Approve/Reject |
| Status `retry` | `error` · red · retry message shown |
| Status `busy` | `running` · blue · Stop turn; tool activity as detail |
| Status `idle` | `idle` · green · Continue |

Up to the 12 most recently updated sessions per window; child (subagent)
sessions and archived sessions are skipped. Labels use the session title with a
directory-basename fallback, matching Codex conventions.

## Validation

- `tests/opencode.test.cjs` (new): 14 tests against a stub HTTP+SSE server —
  netstat parsing, attach args (with `--session`), model/preview normalization,
  discovery + row mapping (child/archived filtering, retry/busy states),
  SSE-driven waiting/approve with stale-token refusal, v2 permissions (reply on
  the session endpoint, survival across repeated polls, startup discovery via
  polling, removal when resolved elsewhere), legacy requests resolved
  elsewhere, reject/abort/continue posts, vanished-server cleanup, offline
  entry selection (PC only, out of pad browsing), controller routing + LCD
  render.
- SSE fixtures use the wire envelope captured from a live opencode 1.19.2
  server, so the production parser is exercised with real-shaped messages.
- Full suite: **118/118 passing** (`npm test`).
- `git diff --check` clean.
- Visual inspection at 240×135 (agent + details pages) and PC dashboard via
  demo-mode captures: OPENCODE chip, model line, amber NEEDS YOU, lit APPROVE.

## Review fixes (round 1)

1. **[P1] SSE events ignored** — the monitor now unwraps the real
   `{payload:{type, properties}}` envelope (captured live; previously read
   top-level fields that never existed).
2. **[P1] v2 permissions unapprovable / vanishing** — v2 requests now reply via
   `POST /api/session/{sessionID}/permission/{requestID}/reply`; the per-session
   list response is read from `data` (was `value`); regression test covers
   repeated polls.
3. **[P2] Open on PC** — `opencode attach` now passes `--session <id>` so the
   TUI opens the displayed session, not just the server.
4. **[P2] Offline OpenCode entry click** — only offline ComfyUI entries open
   the connection editor; offline OpenCode entries select normally.

## Review fixes (round 2)

1. **[P1] v2 approvals missed at startup/reconnect** — polling now queries
   `GET /api/session/{id}/permission` for every busy session (plus sessions
   already holding a v2 request), so an approval that existed before Pulsar
   connected appears instead of an endless "Working". That per-session list is
   authoritative: requests resolved elsewhere are dropped on the next poll
   (replacing the old miss-counter backstop).
2. **[P2] Offline OpenCode entries selectable** — `Controller.select`/`row`
   now work from the full snapshot: offline OpenCode entries can be clicked on
   the PC (panel shows the outage, pad shows OFFLINE state) while offline
   ComfyUI connections stay editor-only (pinned behavior) and knob browsing
   still skips offline entries.
3. **[P2] Child/archived sessions via events** — `session.updated` events now
   pass through the same `parentID`/archived filters as polling, immediately
   removing (not re-adding) such sessions. An offline server's rows also now
   report state `offline` with no approval actions instead of stale statuses.

## Review fixes (round 3 — live-testing feedback)

- **[UX] Session flood** — running `opencode serve` exposed the shared
  database: every recorded session from every project (months-old greetings,
  benchmark subagents) appeared on the pad as "READY" agents. `rows()` now
  hides sessions that are idle for more than 24 h; busy/retrying/approval
  sessions always show. Regression test included.

## Review fixes (round 4 — live-testing feedback)

- **Cross-instance visibility settled empirically**: a `serve` instance shares
  *history* (all sessions from the database, all projects) but not *live
  state* — during a 60 s probe its event stream carried only its own
  `server.connected` while another instance was generating events, and its
  status map stayed empty. Live turns and permission requests exist only in
  the instance's memory, which is why headless/`run`-style sessions (like the
  maintainer's own OpenScale conversation) cannot be monitored or attached to.
- **[UX] Duplicate rows** — with `serve` and a port-hosting TUI running at the
  same time, both list the same database sessions. `rows()` now deduplicates
  by session ID, preferring the instance that holds live state (busy/waiting/
  error). Regression test included.
- **Launcher fix (user-side)** — the maintainer's local launcher script (the
  `opencodeGlm` alias target) now picks a free port and passes `--port`, so
  future sessions started via the alias host a server and appear on the pad.
  Already-running sessions cannot be retrofitted.

## Review fixes (round 5 — permission presets)

- **Per-session permission presets for OpenCode** — verified live on 1.19.2
  that `PATCH /session/{id}` accepts a permission ruleset, that session
  `ask` rules override config allow-defaults (bash ask appeared and was
  approved via the pad's Key 1), that `deny` rules block silently without an
  ask, and that readback reflects the stored ruleset. The four Codex presets
  map to rulesets (`Auto` = clear overrides); anything else reads back as
  **Custom**. Applied via `opencode-settings` intents with the same
  confirm-then-readback contract; rows expose `Permission mode` in the menu
  while `Model & Effort` stays Codex-only.

## Known limitations / next steps

- **TUI windows must be started with `--port`** (e.g. `opencode --port 4096`):
  verified live on 1.19.2 that a TUI without `--port` binds no server and is
  undetectable, while `--port 4299` binds, answers `/global/health`, and lists
  sessions. README documents this. A PowerShell wrapper that auto-picks a free
  port could hide this entirely (offered, not installed).
- Validated against spawned TUI/`serve` instances and stub servers; **not yet
  exercised against real TUI windows with the physical pad** — do a live check
  before release, including a real v2 permission request end-to-end.
- Local-machine discovery only; remote servers would follow the ComfyUI
  manual-connection pattern (not built).
- No Model/Effort *selection* for OpenCode (model is per-message in OpenCode;
  Pulsar displays but does not change it). No voice for OpenCode entries.
- OpenCode's server API is experimental (tested with 1.19.2); version drift may
  require updates.
- Auth-protected servers (`OPENCODE_SERVER_PASSWORD`) are not supported yet.

## Files changed

```
M  README.md                    OpenCode section + capability bullet
M  src/shared/types.ts          Row.source union, OpenCodeStatus
A  src/main/opencode.ts         Monitor: discovery, SSE, polling, actions
M  src/main/controller.ts       rows filter, intent routing, modelLabel
M  src/main/display.ts          OpenCode top line + status label
M  src/main/index.ts            wiring, timers, cleanup, demo row
M  src/main/voice-session.ts    OpenCode voice guard
M  ui/app.js, ui/index.html     chips, model line, sidebar title
A  tests/opencode.test.cjs      14 tests, stub HTTP+SSE server
```
