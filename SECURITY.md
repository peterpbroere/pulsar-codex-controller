# Security

Please use GitHub's **Report a vulnerability** feature for security issues when
available. Otherwise open an issue requesting a private contact without posting
credentials, exploit details, private commands, or session files.

Pulsar Codex Deck controls local Codex sessions using their supported shared
server. It does not accept remote network requests and does not need a separate
OpenAI API key. Approval decisions use exact live request identifiers; keystroke
simulation is not used to approve commands in a terminal.

Hardware changes are temporary and are never saved to firmware. Full access
mode deliberately disables the selected Codex thread's sandbox and approvals;
the app requires a visible confirmation before applying a permission preset.
Other clients can still change a thread's settings or resolve requests.

The small LCD can truncate requests. Inspect the full request on PC when the
preview is insufficient. Only supported command/file-change requests can be
approved; questions and unsupported request types remain in Codex.

The Windows release is unsigned. Verify SHA256SUMS.txt against the matching
GitHub release. Do not download repackaged installers from other websites.
