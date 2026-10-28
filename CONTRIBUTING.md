# Contributing

Bug reports, documentation improvements, and pull requests are welcome.

## Development

Use Windows 10/11 x64, Node.js 22.12+ and Python 3.9+:

```powershell
npm ci
npm run setup
npm test
.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py" -v
npm start
```

Run `npm run demo` to explore the UI without a device or live agent controls.
The source checkout stores preferences and development artifacts under `work/`.

To build the installer and ZIP, run `npm run dist:win`. The backend build bundles
Python; the release build never reads your Codex credentials or hook file.

## Before opening a pull request

- Explain the concrete behavior change and how you tested it.
- Preserve exact-request approvals, single-press confirmation, and stale-request checks.
- Hardware writes must stay RAM-only. Never add Save/flash/bootloader commands.
- Distinguish unit tests, synthetic previews, and real-device tests in your notes.
- Hook changes must preserve other integrations, back up configuration, and remain explicit.
- Do not add automatic approval responses, login autostart, or telemetry implicitly.
- Keep screenshots synthetic; do not include real session IDs, commands, tokens, or private paths.

The shared Codex server and XPad protocol are experimental. Include your Codex
version, firmware release number, Windows version, and reproducible steps in
hardware bug reports. Redact credentials and private commands from logs.
