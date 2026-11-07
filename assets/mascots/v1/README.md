# Desk companions

Original tuxedo cat and owl artwork created for Pulsar Codex Deck using built-in
OpenAI image generation. These assets use the repository's MIT license.

`cat/` and `owl/` contain transparent 64 × 64 PNG animation frames. `manifest.json`
defines their order and individual frame durations. The app preloads 48 × 48
copies using nearest-neighbor scaling for the LCD and desktop companion preview.

Agent states are `idle`, `working`, `approval`, `done`, and `error`. The
five-second `done` animation marks an observed transition from an active turn
to idle, then returns to `idle`. It does not determine whether the user's
overall task was completed. No completion animation is inferred for sessions
first discovered while idle.

The separate `voice-listening` and `voice-speaking` states are conversation
animations for the selected voice target only, and only while native voice is
active. The companion shows listening otherwise and switches to speaking when
native assistant transcript activity indicates a reply. These are animated
conversation poses, not audio-volume lip sync. Choosing **Off** still suppresses
the companion; neither voice animation changes agent status or approval state.

Source atlases and exact generation prompts are in `sources/`. Rebuild atlas
frames, previews, and the manifest with `node scripts/build-mascot-previews.cjs`.
Use `node scripts/build-mascot-previews.cjs --previews-only` to build GIF previews
and the HTML gallery from the current manifest and PNG frames without reslicing
atlases or writing the manifest. Preview exports are ignored by Git and are not
needed by the installed app.

The runtime player validates the choice and manifest, follows the selected
agent, and has no authority to change agent status or resolve approval requests.
