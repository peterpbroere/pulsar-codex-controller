# Desk companions

Original tuxedo cat and owl artwork created for Pulsar Codex Deck using built-in
OpenAI image generation. These assets use the repository's MIT license.

`cat/` and `owl/` contain transparent 64 × 64 PNG animation frames. `manifest.json`
defines their order and individual frame durations. The app preloads 48 × 48
copies using nearest-neighbor scaling for the LCD and desktop companion preview.

States: `idle`, `working`, `approval`, `done`, `error`. The five-second `done`
animation marks an observed transition from an active turn to idle, then returns
to `idle`. It does not determine whether the user's overall task was completed.
No completion animation is inferred for sessions first discovered while idle.

Source atlases and exact generation prompts are in `sources/`. Rebuild exported
GIF previews and the HTML gallery with `node scripts/build-mascot-previews.cjs`.
Those exports are ignored by Git and are not needed by the installed app.

The runtime player validates the choice and manifest, follows the selected
agent, and has no authority to change agent status or resolve approval requests.
