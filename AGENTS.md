# Working on Pulsar Codex Deck

These instructions apply to the whole repository and to any coding model working
here. They record project decisions and working preferences established with the
maintainer. Explicit instructions for the current task take precedence.

**Update this file as new, clear rules are discussed and agreed with the
maintainer.** Record durable decisions, not guesses, temporary troubleshooting
steps, or every suggestion in a conversation. Revise superseded guidance rather
than accumulating contradictory rules.

## Working with the maintainer

- Explain the intended change briefly before implementing it. Be explicit about
  dependencies, API keys, costs, extensions, external configuration changes, and
  application restarts. Do not reveal these as surprises after implementation.
- When asked to discuss an idea or investigate feasibility, do that first. Do
  not treat discussion as permission to implement. When implementation is
  requested, carry it through and verify it within the authorized scope.
- Read the code and available context before asking questions. Ask about material
  ambiguities; resolve routine implementation details yourself. Do not repeatedly
  ask for authorization already given.
- Think before researching or running tools. Keep exploration focused and avoid
  redundant checks. Both the maintainer's time and token costs matter.
- Give concise, concrete progress updates during longer work. Explain what
  changed, how it was checked, and any limitations. Do not claim a tool action,
  successful test, installation, commit, push, or release without evidence.
- Distinguish source changes, locally built artifacts, installed versions,
  commits pushed to GitHub, and published releases. One does not imply another.
- Keep the scope of an investigation literal. For example, a request about a
  wireless adapter is not a request to redesign or dismantle the pad.

## Model delegation and token efficiency

- For substantial coding tasks, use the primary model as architect, coordinator,
  and final reviewer.
- For multiple-file tasks or substantial exploration, delegate bounded routine
  work to cheaper subagents when available. Specify file scopes and acceptance
  criteria, keep architecture with the primary model, and review worker changes
  and test results. Escalate difficult or failed work to the primary model.
- Avoid subagents for trivial tasks where coordination costs more than doing the
  work directly. If delegation is unavailable, proceed directly.
- Optimize total usage per successful task. Use focused searches and concise
  output; do not repeatedly read large files or rerun successful checks without
  a reason. If an RTK output wrapper is present, treat its condensed output as
  complete; bypass it only when the result is unusable.

## Project and code map

Pulsar Codex Deck controls existing Codex sessions from a Pulsar Lab XPAD Mini
(240 x 135 LCD) and monitors optional ComfyUI instances. The supported packaged
target is Windows x64. Do not claim Linux/macOS hardware support without testing.
Packaged users should not need Python, Node.js, another checkout, or a Flipper
Zero. Prefer a streamlined, configurable setup over machine-specific assumptions.

- `src/main/controller.ts`: navigation, actions, preferences, and menu state.
- `src/main/display.ts`, `title-scroll.ts`: shared LCD layout and title scrolling.
- `src/main/device/`: direct USB input and hardware protocol.
- `src/main/index.ts`: Electron app, integration, persistence, and lifecycle.
- `src/main/backend.ts`, `python/adapter.py`, `python/agent_deck/`: Codex bridge,
  session discovery, hooks, and control requests.
- `src/main/voice-session.ts`, `voice-audio*.ts`, `ui/voice.*`: native voice and
  audio lifecycle. `ui/microphone-selector.js` manages microphone choices.
- `src/main/comfyui.ts`, `comfyui/pulsar_deck/`: ComfyUI monitoring and the
  optional progress helper.
- `src/main/mascot.ts`, `assets/mascots/v1/`: companion animation player/assets.
- `src/shared/types.ts`, `src/preload/`, `ui/`: shared contracts, Electron bridge,
  and desktop UI.
- `tests/`, `scripts/`, `packaging/`, `.github/workflows/`: checks, tooling,
  installer, CI, and releases.

Read `README.md` and `CONTRIBUTING.md` for setup and current behavior. Confirm
versions and protocol details in source; do not assume old conversation details
are still current.

## Controls and UI decisions to preserve

| Control | Established behavior |
| --- | --- |
| Turn knob | Browse agents; navigate the open menu |
| Press knob | Open details; select or confirm a menu item |
| Key 1 | Direct, single-press approval of the selected displayed request, once |
| Key 2 | Open the selected session or ComfyUI instance on PC |
| Key 3 tap | Start/end native voice; end the existing voice session even when browsing another entry |
| Key 3 hold | Next waiting/error entry (700 ms) |
| + | Open/close global settings, returning to the previous screen |
| x (physical cross) | Back; in multi-step selectors, return one step |

- Knob navigation is central to the design. Show one selected agent with room
  for useful details, rather than crowding the LCD with a list.
- Use Codex session titles as the main labels, with existing-name/directory
  fallbacks. Scroll long overview titles with pauses at the ends. Show the
  working directory beneath activity/status text. Do not rename Codex sessions
  or generate new titles as a side effect of displaying them.
- Display Model and **Effort** near the top. Selecting Model & Effort is a single
  flow: model, supported effort, review, apply. Preserve permission settings and
  reject stale selections. Do not hard-code a model catalog.
- Waiting is amber and takes priority over red errors, blue work, and green
  idle. Cosmetic animations must not obscure or change actual approval status.
- Controls must work while a game has focus. Preserve direct USB input; do not
  replace it with global keyboard shortcuts or injected approval keystrokes.
- Call the character **Companion** in visible UI and documentation. Keep Cat,
  Owl, and Off. Internal `mascot` identifiers and saved preference keys remain
  compatible; a label change is not a reason to reset users' choices.
- Preserve the established pixel art style and character identities. Headset
  listening/speaking animations belong only to the active voice target; browsing
  another agent must not move the call. Off stays off. Speaking currently follows
  assistant transcript activity; do not describe it as exact lip sync.

## Approval, hardware, and integration boundaries

- Approve only the exact live request the user was shown. Preserve request IDs,
  control tokens, stale-request checks, and single-use behavior. Keep unsupported
  approval types and structured questions in Codex. Never add automatic approval
  as an incidental implementation detail.
- Permission presets affect the selected agent's subsequent turns. Preserve the
  explicit review and effective-settings readback; custom policies stay Custom.
- Hardware changes stay temporary and RAM-only. Never add firmware flashing,
  Save, or bootloader commands. Preserve orderly mapping restoration on Quit.
- Preserve other integrations when editing hooks, create backups, and keep hook
  installation explicit. Do not silently alter the user's Codex installation.
- ComfyUI connections are configured by users with names and URLs. Multiple
  instances are independent. Hide offline instances from pad navigation while
  retaining them in the PC app for configuration.
- ComfyUI monitoring is read-only. Preserve latest completed image previews,
  current-node names, and total/current-node progress. Missing progress is
  unknown, not a fabricated number. Do not launch/cancel jobs or change workflows
  as part of monitoring.
- Basic ComfyUI monitoring needs no extension. Detailed progress uses the bundled
  optional helper. Explain its exact files/behavior before installing or updating
  it; leave unrelated ComfyUI files, extensions, dependencies, and client routing
  alone. Make setup available through the app rather than requiring users to
  invent their own helper.

## Voice and microphone behavior

- Use the existing signed-in Codex native voice integration. Do not introduce a
  separately billed API key, speech service, local model, or download without
  explaining the change and obtaining agreement to that change in scope.
- Preserve the working native WebRTC transport and session correlation. Reject
  stale events; browsing agents must not retarget a running call.
- Microphone enumeration must work before starting voice and must not record.
  Keep stable device IDs, named-device caching, saved/disconnected choices, and
  automatic refresh. Do not require starting a call and refreshing to see inputs.
- Start recording only on an explicit voice action. Release capture immediately
  on stop, error, disconnect, or Quit. Never auto-resume a microphone session.
- Spoken replies default off; keep the saved toggle and voice selection. Voice
  changes apply to the next call and do not implicitly enable spoken replies.
- Native voice can delegate work to the coding agent; not every conversational
  utterance appears in its terminal. Do not claim delegated work was completed
  just because the voice assistant acknowledged it.

## Validation and delivery

- Inspect `git status` before editing. Preserve unrelated and already-uncommitted
  work. Do not commit, push, tag, publish a release, install, or restart the user's
  running app merely because source editing was requested.
- For TypeScript/UI behavior changes, run `npm test`. For Python/backend changes,
  also run `.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py" -v`.
  Match checks to the change; documentation-only edits do not need a full build.
- Run `git diff --check`. Before publishing, run
  `node scripts/check-public-files.cjs` and inspect newly added files too.
- Add meaningful regression tests for behavior changes. Do not write tests that
  merely restate trivial implementation details. Clearly separate automated,
  demo, packaged-app, real-device, and user-confirmed testing.
- Use `npm run demo` or an isolated `PULSAR_STATE_DIR` with `--demo --no-device`
  for UI experiments. Do not trigger approvals, change live settings, or capture
  microphone audio simply to render a preview.
- Visually inspect LCD changes at 240 x 135 and the desktop UI. Keep details
  readable. Bundle all animation states; preserve transparency and nearest-pixel
  scaling. Preview generation must not accidentally overwrite original frames.
- `npm run dist:win` builds the backend, Windows installer, and portable ZIP in
  `release/`. Follow the release workflow; keep package/lock versions consistent
  and release tags matched to the package version. A local build is not a GitHub
  release. Do not claim a standalone installer works without checking its bundle.
- When an installation/restart is authorized, use a clean Quit, preserve user
  preferences, ComfyUI connections, and existing startup configuration, then
  verify the installed version and device reconnection. Do not force-kill a
  live voice session. Autostart is opt-in, not a new default for everyone.
- Keep generated builds, runtime profiles, logs, credentials, private session
  content, and machine-specific paths out of public commits. Use synthetic
  screenshots. Keep development artifacts in ignored `work/`; packaged settings
  live under `%APPDATA%\PulsarCodexDeck`. Maintain README instructions when public
  behavior or setup changes.
