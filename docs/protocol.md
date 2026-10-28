# Pulsar XPAD Mini — protocol reference (reverse-engineered, verified)

Status: **verified against the live device** (2026-07-18). The XPAD Mini runs
**SayoDevice-based firmware** and speaks the Sayo "API v2" HID protocol.

## Discovery trail

- Bibimbap web driver (`bbb.pulsar.gg`) routes VID 0x3710 PID 0x2507 to the
  `/sKey` Flutter app; its device logic is Rust→WASM (flutter_rust_bridge):
  `sKey/pkg/rust_lib_bibimbap_bg.wasm` (source paths inside:
  `src/api/sayo_device/*.rs` — hence SayoDevice).
- Community references for the Sayo protocol:
  - khang06's O3C internals gist (packet framing, command list)
  - [SayoGroup/SayoDeviceStreamingAssistant](https://github.com/SayoGroup/SayoDeviceStreamingAssistant)
    (`SayoHid.cs` — header builder, ScreenInfo, framebuffer streaming)
  - SoulDee/sayo-device-web-hid (v1 protocol, older devices)

## Device identity

- VID `0x3710`, PID `0x2507`, product "Pulsar Lab Xpad Mini", model code `0x23` (35)
- LCD: **240 × 135**, RGB565 little-endian, 60 Hz (firmware-reported; marketing says 136)
- LEDs: **13 addressable** — **indexes 0–2 are the key LEDs (left, center,
  right); indexes 3–12 are the light bar running RIGHT→LEFT** (3 = right end,
  12 = left end). Calibrated visually 2026-07-19 by lighting individual
  indexes — an earlier version of this doc had it backwards. The bar sits
  behind a diffuser and is much dimmer than the key LEDs (~5% duty is
  invisible on the bar; ~17% reads as a subtle glow).

## HID channels

| Usage page | Usage | Report | Packet size | Purpose |
|---|---|---|---|---|
| 0xFF00 | 0x01 | 0x02 | 64 | Sayo API **v1** (legacy config) |
| 0xFF11 | 0x02 | 0x21 | 64 | API **v2**, slow channel |
| 0xFF12 | 0x02 | 0x22 | 1024 | API **v2**, fast channel ← use this |

## API v2 framing

All output reports; responses arrive as input reports with the same layout.

```
offset  size  field
0       1     report id (0x22 fast / 0x21 slow)
1       1     echo — client tag, mirrored in responses (web UI: 3, streaming: 4)
2       2     checksum u16 LE — sum of the used packet as 16-bit LE words,
              computed with this field zeroed; used length = 8 + payload
              (word-padded)
4       2     length u16 LE = payload bytes + 4
6       1     command
7       1     index (response correlation within a packet)
8       n     payload
```

Unsupported/error responses come back with length ≤ 4 and a status in the
length's high byte (e.g. 0xFC = unsupported).

## Commands (XPAD Mini, from Info response)

Supported: `01 02 03 05 0D 0E 10 15 16 17 18 19 1A 1C 1D 1E 1F 20 21 22 23 25
26 27 28 2A 2B` (not 0x11/0x12 Light/Palette of older devices!)

### 0x00 — Info
Empty request. Response payload: `u16 model_code, u16 fw_version, u8[4],
u8 battery, u8 fn, u8 cpu_s, u8 cpu_ms, …` then the supported-command list.

### 0x02 — ScreenInfo
Empty request. Response: `u16 width, u16 height, u8 refresh_rate, pad,
u16 sys_ms, u32 sys_s, u16 vid, u16 pid, u8 cpu_1m, u8 cpu_5m, …clocks`.
Verified: 240×135@60, vid 0x3710, pid 0x2507.

### 0x25 — Display (framebuffer read/write) ✔ verified
- **Read**: payload = `u32 byte_offset` (len 8). Response: `u32 byte_offset`
  + up to 1012 bytes of RGB565 LE framebuffer.
- **Write (live streaming!)**: payload = `u32 byte_offset` + RGB565 LE pixel
  data. Chunk the 240×135×2 = 64 800-byte frame into 1012-byte chunks.
  Writing shows immediately; the firmware UI stops overdrawing while streamed.
  SayoDevice's own streaming assistant sustains 30+ fps this way.

### 0x27 — Addressable LED colors ✔ verified
- **Read**: empty payload → 52-byte payload: 13 × `[R, G, B, 0]`.
- **Write**: 52-byte payload, same layout → sets all 13 LEDs instantly and
  suppresses the firmware's own effect until reboot/profile switch.
  Order: 0–2 keys left/center/right, 3–12 bar right→left (see Device
  identity above). **The payload must be exactly 13 entries — writes with
  more entries (e.g. 16) are rejected outright and change nothing.**

### 0x10 — KeyInfo (per-key mapping) ✔ verified
- The **header index byte** (offset 7) selects the entry; payload-based
  addressing is rejected. Read: empty payload → 56-byte entry. Write: same
  56-byte entry as payload (RAM-only without Save).
- Entry layout: `u32 key_class` (1 = keyboard key), `u16 site_x`, `u16
  site_y`, `u16 width`, `u16 height`, `u16 ?? (100)`, `u16 pad`, then key
  data: **modifier byte at offset 20** (standard HID modifier bitmask: 0x01
  LCtrl, 0x02 LShift, 0x04 LAlt, 0x08 LWin/LCmd), **HID keycode at offset
  21** (0 = no keyboard key, i.e. a pure modifier-only chord).
- XPAD Mini: entries 0/1/2 = the three magnetic keys left/center/right
  (ascending site_x), factory keycodes q/w/e (0x14/0x1A/0x08); entries 3-7 =
  knob/buttons (different class). The app rewrites 0-2 on every connect to
  whatever the configured key actions resolve to — default left=`y`
  (0x00/0x1C), right=`n` (0x00/0x11), center=**Left Ctrl+Left Win held**
  (mod=0x09, key=0x00 — Wispr Flow's own Windows push-to-talk default).
- Caution: concurrent LED/LCD streaming garbles read responses — pause
  streaming while reading. v1 cmd 0x16 (Key) is stubbed on this firmware.

### Others (observed, not needed by this app)
- 0x03 Setting (read: 40-byte config blob)
- 0x26 LED config: color + mode + speed/brightness + palette, ends with magic
  `0x7296 0x7296`
- 0x28 brightness/gamma curve LUT
- 0x2B flash asset table (multi-packet response, offsets of stored images)
- 0x0D Save — **never sent by this app**: all our writes are RAM-only, so
  unplugging restores factory behavior.

## Safety notes

- No Save (0x0D), no MemoryWrite, no bootloader commands — everything this app
  does is transient.
- The keyboard collections (MI_00 etc.) are never touched.

## Pulsar Codex Deck additions

This file began as the MIT-licensed upstream protocol reference. The following
observations were verified on the device while developing this Codex controller:

- Knob mappings are KeyInfo indices 13 (press), 14 (clockwise), 15 (counterclockwise).
  Preserve the encoder class flags and physical metadata. Keyboard output type is
  u32 zero at offset 16, with modifier/usage at offsets 20/21.
- Read KeyStatus (0x1E, empty payload): a four-byte active-low button mask.
  The released baseline was 0x3ffff. A physical + hold cleared bit 16 (0x2ffff),
  and a physical � hold cleared bit 17 (0x1ffff). Edge detection maps these to
  global settings and Back, independently of firmware profile changes.
- Merely simulating a SystemInfo profile change did not validate a physical +
  press during streaming. The current app uses raw KeyStatus rather than that proxy.
- Keep the HID read loop draining display acknowledgements between requests.
  Serialize display bursts and raw-input reads, validate response checksums, and
  discard malformed responses. A held auxiliary button must not repeat its action.
- SystemInfo (0x02) returns a 44-byte payload. The low nibble of payload byte 5 is
  the selected hardware profile; the high nibble is the profile count. The app
  preserves the active profile and uses no Save/flash commands.
