# Third-party sources

## XPAD Mini hardware protocol

`src/main/device/hid.ts` and `src/main/device/protocol.ts` derive from
[SpinnerMaster/xpad-mini-claude-code](https://github.com/SpinnerMaster/xpad-mini-claude-code),
commit `ae6b5d12016de13870375a2a4b10659cd25fb67e`.

MIT license, copyright (c) 2026 SpinnerMaster. Full notice: [LICENSE.xpad](LICENSE.xpad).
The protocol notes in `docs/protocol.md` retain the upstream reference material;
direct physical-button findings are documented as local additions.

## Flipper Agent Deck

The modules under `python/agent_deck/` and `scripts/Focus-Agent.ps1` derive from
[peterpbroere/flipper-codex-controller](https://github.com/peterpbroere/flipper-codex-controller),
commit `6167d9b68a3fb456388a2e1a6f7dc5ff60ed5a4f`.

MIT license, copyright (c) 2026 Flipper Agent Deck contributors. Full notice:
[LICENSE.agent-deck](LICENSE.agent-deck). The event-store default is adapted for
standalone use; the original session reduction and exact-request control logic
are preserved. This app does not expose the original Flipper YOLO auto-response
toggle or start the Flipper bridge.

## Runtime dependencies

Electron, node-hid, sharp/libvips, Python, psutil, websocket-client, PyInstaller,
and their dependencies retain their respective licenses. Runtime notices shipped
by Electron and the Python distribution remain in the packaged runtime. This
repository's MIT license does not replace those notices.

No third-party character artwork, private sessions, credentials, or generated
hardware diagnostics are included in the public source or distributable app.
