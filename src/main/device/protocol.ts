import type { HidTarget } from '../../shared/types';
import { XpadDevice } from './hid';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export const LCD_WIDTH = 240;
export const LCD_HEIGHT = 135;
export const BACKLIGHT_COUNT = 10;
export const KEY_LED_COUNT = 3;

const PACKET_SIZE = 1024;
const REPORT_ID = 0x22;
const ECHO = 0x04; // "application echo"; responses mirror it
const LED_TOTAL = BACKLIGHT_COUNT + KEY_LED_COUNT;

const CMD_SCREEN_INFO = 0x02;
const CMD_KEY_INFO = 0x10; // read/write one key's mapping; header index selects the key
const CMD_DISPLAY = 0x25; // read/write framebuffer (RGB565 LE, u32 byte offset)
const CMD_LED_COLORS = 0x27; // read/write 13 x [R,G,B,0]

/**
 * KeyInfo entry (56 bytes): u32 key_class (1 = keyboard key), u16 site_x/y,
 * u16 width/height, ... , modifier byte at offset 20, HID keycode at 21.
 * The three magnetic pad keys are entries 0/1/2 (left/center/right by
 * ascending site_x); factory keycodes are q/w/e.
 */
const KEY_INFO_SIZE = 56;
const KEY_MODIFIER_OFFSET = 20;
const KEY_KEYCODE_OFFSET = 21;

/**
 * Sayo v2 protocol for the Pulsar XPAD Mini (SayoDevice-based firmware).
 * See docs/PROTOCOL.md for the reverse-engineering notes.
 *
 * Packet (1024 bytes, fast channel usagePage 0xFF12):
 *   [0]    report id 0x22
 *   [1]    echo
 *   [2:4]  checksum: u16 LE sum of the used packet as 16-bit LE words
 *   [4:6]  length u16 LE = payload + 4
 *   [6]    command
 *   [7]    index
 *   [8..]  payload
 *
 * Writes go to device RAM only (no Save command is ever sent), so unplugging
 * restores the device's own settings.
 */
export class XpadProtocol {
  private _ready = false;
  private lastError = 0;
  private navigationProfile: number | null = null;
  private nextProfileRead = 0;
  /** Invoked (again on every reconnect) once ScreenInfo has verified the protocol. */
  onReady: (() => void) | null = null;

  constructor(private device: XpadDevice) {
    device.on('connect', () => {
      this.lastFrame = null;
      this.lastLedPayload = null;
      void this.verify();
    });
    device.on('disconnect', () => {
      this.navigationProfile = null;
      this.originalKeys.clear();
      this._ready = false;
      this.lastFrame = null;
      this.lastLedPayload = null;
    });
  }

  get ready(): boolean {
    return this._ready;
  }

  /** Confirm the device speaks the protocol by requesting ScreenInfo. */
  private async verify(): Promise<void> {
    const dev = this.device.bulk;
    if (!dev) return;
    try {
      const onData = (data: Buffer) => {
        const buf = Buffer.from(data);
        if (buf[0] !== REPORT_ID || buf[6] !== CMD_SCREEN_INFO) return;
        const width = buf.readUInt16LE(8);
        const height = buf.readUInt16LE(10);
        console.log(`[protocol] ScreenInfo ${width}x${height} — protocol ready`);
        if (width !== LCD_WIDTH || height !== LCD_HEIGHT) {
          console.error('[protocol] Unexpected screen dimensions; no writes enabled');
          dev.removeListener('data', onData);
          return;
        }
        this._ready = true;
        if(buf.length>=52 && (buf[13]>>4)>=5)this.navigationProfile=buf[13]&15;
        dev.removeListener('data', onData);
        this.onReady?.();
      };
      dev.on('data', onData);
      dev.write(this.buildPacket(CMD_SCREEN_INFO, Buffer.alloc(0)));
      setTimeout(() => dev.removeListener('data', onData), 2000);
    } catch (err) {
      console.error('[protocol] verify failed', err);
    }
  }

  /**
   * Set all 13 LEDs for one animation frame via cmd 0x27.
   * The payload must be exactly 13 entries (52 bytes) — the firmware rejects
   * other lengths outright.
   * @param colors 13 colors by DEVICE index: 0-2 key LEDs left/center/right,
   *   3-12 light bar right -> left (see docs/PROTOCOL.md, calibrated layout)
   */
  private lastLedPayload: Buffer | null = null;
  private originalKeys = new Map<number, Buffer>();

  async restoreKeys(): Promise<void> {
    const dev = this.device.bulk;
    if (!dev) return;
    for (const [index, entry] of this.originalKeys) {
      this.tryWrite(dev, this.buildPacket(CMD_KEY_INFO, entry, index), 'restoreKeys');
    }
    this.originalKeys.clear();
  }

  setLeds(colors: Rgb[]): void {
    const dev = this.device.bulk;
    if (!dev) return;
    const payload = Buffer.alloc(LED_TOTAL * 4);
    for (let i = 0; i < LED_TOTAL; i++) {
      const c = colors[i] ?? { r: 0, g: 0, b: 0 };
      payload[i * 4] = c.r;
      payload[i * 4 + 1] = c.g;
      payload[i * 4 + 2] = c.b;
    }
    // Unchanged frames (idle glow, steady, flash plateaus) are skipped: every
    // needless packet is firmware time not spent scanning keys.
    if (this.lastLedPayload?.equals(payload)) return;
    if (this.tryWrite(dev, this.buildPacket(CMD_LED_COLORS, payload), 'setLeds')) {
      this.lastLedPayload = payload;
    } else {
      this.lastLedPayload = null;
    }
  }

  /** Read one KeyInfo entry (null on timeout/garbled response). */
  private readKeyInfo(index: number): Promise<Buffer | null> {
    const dev = this.device.bulk;
    if (!dev) return Promise.resolve(null);
    return new Promise((resolve) => {
      const finish = (result: Buffer | null) => {
        clearTimeout(timer);
        dev.removeListener('data', onData);
        resolve(result);
      };
      const onData = (data: Buffer) => {
        const buf = Buffer.from(data);
        if (buf[0] !== REPORT_ID || buf[6] !== CMD_KEY_INFO || buf[7] !== index) return;
        const len = buf.readUInt16LE(4);
        // Concurrent LED/LCD traffic can garble responses; validate the shape.
        if (len - 4 !== KEY_INFO_SIZE) return finish(null);
        finish(buf.slice(8, 8 + KEY_INFO_SIZE));
      };
      const timer = setTimeout(() => finish(null), 1500);
      dev.on('data', onData);
      if (!this.tryWrite(dev, this.buildPacket(CMD_KEY_INFO, Buffer.alloc(0), index), 'readKeyInfo')) {
        finish(null);
      }
    });
  }

  /**
   * Map the three pad keys (factory q/w/e) to the given targets (modifier
   * bits + usage — modifier-only combos like Ctrl+Win work too) so the pad
   * emits the configured actions BY ITSELF (a hotkey round-trip through the
   * app clumps under load) — RAM-only, like everything else here: no Save is
   * sent, replugging restores the on-device keymap, and this re-runs on every
   * reconnect. Null targets and non-keyboard entry classes are left alone.
   */
  async remapPadKeys(targets: (HidTarget | null)[]): Promise<void> {
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      if (target === null) continue;
      let entry: Buffer | null = null;
      for (let attempt = 0; attempt < 3 && !entry; attempt++) {
        entry = await this.readKeyInfo(i);
      }
      if (!entry || entry.readUInt32LE(0) !== 1) {
        throw new Error(`Cannot remap key ${i + 1}: unreadable or non-keyboard mapping`);
      }
      if (!this.originalKeys.has(i)) this.originalKeys.set(i, Buffer.from(entry));
      const curMod = entry[KEY_MODIFIER_OFFSET];
      const curKey = entry[KEY_KEYCODE_OFFSET];
      if (curMod === target.mod && curKey === target.key) continue;
      const patched = Buffer.from(entry);
      patched.writeUInt32LE(0,16);
      patched.fill(0,20,32);
      patched[KEY_MODIFIER_OFFSET] = target.mod;
      patched[KEY_KEYCODE_OFFSET] = target.key;
      const dev = this.device.bulk;
      if (!dev) return;
      if (!this.tryWrite(dev, this.buildPacket(CMD_KEY_INFO, patched, i), 'remapPadKeys')) {
        throw new Error(`Cannot write key ${i + 1} mapping`);
      }
      console.log(
        `[protocol] pad key ${i} mapped mod=0x${curMod.toString(16)},key=0x${curKey.toString(
          16
        )} -> mod=0x${target.mod.toString(16)},key=0x${target.key.toString(16)}`
      );
    }
  }

  /** KeyInfo indices 13/14/15 are knob press/clockwise/counterclockwise. */
  async remapKnob(): Promise<void> {
    for (const [index, usage] of [[13, 0x6d], [14, 0x6c], [15, 0x6b]]) {
      const entry = await this.readKeyInfo(index);
      if (!entry || (entry.readUInt32LE(0) & 0xff) !== 1) throw new Error(`Knob entry ${index} is unavailable`);
      if (!this.originalKeys.has(index)) this.originalKeys.set(index, Buffer.from(entry));
      const mapped = Buffer.from(entry);
      // Preserve the physical class/encoder flags; replace only the action fields.
      mapped.writeUInt32LE(0, 16); mapped.fill(0,20,32); mapped[21]=usage;
      const dev = this.device.bulk;
      if (!dev || !this.tryWrite(dev,this.buildPacket(CMD_KEY_INFO,mapped,index),'remapKnob')) throw new Error('Knob mapping failed');
      await new Promise(resolve=>setTimeout(resolve,35));
      const check=await this.readKeyInfo(index);
      if (!check?.equals(mapped)) throw new Error(`Knob mapping ${index} readback failed`);
      console.log(`[protocol] knob ${index} mapped to F${usage-0x68+13}`);
    }
  }

  private readSystemInfo(): Promise<Buffer> {
    const dev=this.device.bulk;
    if(!dev)return Promise.reject(new Error('Device disconnected'));
    return new Promise((resolve,reject)=>{
      const finish=(data?:Buffer)=>{clearTimeout(timer);dev.removeListener('data',onData);if(data)resolve(data);else reject(new Error('Profile read timed out'));};
      const onData=(b:Buffer)=>{if(b[0]===REPORT_ID&&b[6]===CMD_SCREEN_INFO&&b.readUInt16LE(4)-4===44)finish(Buffer.from(b.subarray(8,52)));};
      const timer=setTimeout(()=>finish(),800);dev.on('data',onData);
      if(!this.tryWrite(dev,this.buildPacket(CMD_SCREEN_INFO,Buffer.alloc(0)),'profileRead'))finish();
    });
  }

  /** Raw physical inputs, including the firmware-owned function buttons. */
  readButtonState(): Promise<number> {
    const dev=this.device.bulk;
    if(!dev)return Promise.reject(new Error('Device disconnected'));
    return new Promise((resolve,reject)=>{
      let finished=false;
      const finish=(error?:Error,state?:number)=>{
        if(finished)return;finished=true;clearTimeout(timer);dev.removeListener('data',onData);
        if(error)reject(error);else resolve(state!);
      };
      const onData=(b:Buffer)=>{
        if(b[6]===0x1e && process.env.PULSAR_INPUT_DEBUG)console.log('[input packet]',b.subarray(0,16).toString('hex'));
        if(b.length<12||b[0]!==REPORT_ID||b[6]!==0x1e||b[7]!==0||b.readUInt16LE(4)!==8)return;
        let sum=0;for(let i=0;i<12;i+=2)if(i!==2)sum=(sum+b.readUInt16LE(i))&0xffff;
        if(sum!==b.readUInt16LE(2))return;
        finish(undefined,b.readUInt32LE(8));
      };
      const timer=setTimeout(()=>finish(new Error('Raw button read timed out')),150);
      dev.on('data',onData);
      if(!this.tryWrite(dev,this.buildPacket(0x1e,Buffer.alloc(0)),'rawButtons'))finish(new Error('Raw button read failed'));
    });
  }

  /** The physical + cycles profiles; consume that transition and restore RAM profile. */
  async checkSettingsButton(): Promise<boolean> {
    if(Date.now()<this.nextProfileRead)return false;
    this.nextProfileRead=Date.now()+150;
    const info=await this.readSystemInfo();
    if(info.readUInt16LE(0)!==LCD_WIDTH||info.readUInt16LE(2)!==LCD_HEIGHT||(info[5]>>4)<5)throw new Error('Unsupported profile information');
    const selected=info[5]&15;
    if(this.navigationProfile===null){this.navigationProfile=selected;return false;}
    if(selected===this.navigationProfile)return false;
    info[5]=(info[5]&0xf0)|this.navigationProfile;
    const dev=this.device.bulk;
    if(!dev||!this.tryWrite(dev,this.buildPacket(CMD_SCREEN_INFO,info),'restoreProfile'))throw new Error('Could not restore active profile');
    await new Promise(resolve=>setTimeout(resolve,80));
    const check=await this.readSystemInfo();
    if((check[5]&15)!==this.navigationProfile)throw new Error('Profile restoration was not confirmed');
    this.lastFrame=null;
    return true;
  }

  private lastFrame: Buffer | null = null;
  private framesUntilFull = 0;
  private lastLcdWrite = 0;

  /**
   * Stream one LCD frame via cmd 0x25.
   *
   * Only chunks that differ from the previously sent frame are transmitted
   * (pixel-art animation frames share most of their content), with a full
   * refresh every ~30 frames to heal dropped packets. Yields to the event
   * loop between chunk groups so the LED ticker stays on schedule.
   *
   * @param rgb565 240x135 RGB565-LE framebuffer (must not be mutated after)
   */
  async drawLcdFrame(rgb565: Buffer): Promise<boolean> {
    const dev = this.device.bulk;
    if (!dev) return false;
    const chunk = PACKET_SIZE - 12;
    const force = this.lastFrame === null || this.framesUntilFull <= 0;
    // Full refreshes are 65-packet bursts that delay the firmware's key
    // reporting; keep them rare (errors force one immediately anyway).
    this.framesUntilFull = force ? 300 : this.framesUntilFull - 1;

    let sent = 0;
    for (let off = 0; off < rgb565.length; off += chunk) {
      const n = Math.min(chunk, rgb565.length - off);
      if (
        !force &&
        this.lastFrame &&
        rgb565.compare(this.lastFrame, off, off + n, off, off + n) === 0
      ) {
        continue;
      }
      const payload = Buffer.alloc(4 + n);
      payload.writeUInt32LE(off, 0);
      rgb565.copy(payload, 4, off, off + n);
      if (!this.tryWrite(dev, this.buildPacket(CMD_DISPLAY, payload), 'drawLcdFrame')) {
        this.lastFrame = null; // force a clean full frame after errors
        return false;
      }
      // Yield after every blocking write so the LED ticker keeps its cadence,
      // and pause briefly every few packets so the firmware's key scanner
      // isn't starved by long write bursts (measured as clumpy keystrokes).
      if (++sent % 6 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 4));
      } else {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    if (sent === 0 && Date.now() - this.lastLcdWrite > 250) {
      // The firmware's own UI resumes drawing after ~0.5 s without 0x25
      // traffic (its stock background flashes through on long animation
      // holds). One small keep-alive chunk sustains the suppression.
      const n = Math.min(chunk, rgb565.length);
      const payload = Buffer.alloc(4 + n);
      payload.writeUInt32LE(0, 0);
      rgb565.copy(payload, 4, 0, n);
      sent = this.tryWrite(dev, this.buildPacket(CMD_DISPLAY, payload), 'lcdKeepAlive')
        ? 1
        : 0;
    }
    if (sent > 0) this.lastLcdWrite = Date.now();
    this.lastFrame = rgb565;
    return this.device.connected;
  }

  private buildPacket(cmd: number, payload: Buffer, index = 0): Buffer {
    const buf = Buffer.alloc(PACKET_SIZE);
    buf[0] = REPORT_ID;
    buf[1] = ECHO;
    buf.writeUInt16LE(payload.length + 4, 4);
    buf[6] = cmd;
    buf[7] = index;
    payload.copy(buf, 8);
    const used = 8 + payload.length + (payload.length % 2);
    let sum = 0;
    for (let i = 0; i < used; i += 2) sum = (sum + buf.readUInt16LE(i)) & 0xffff;
    buf.writeUInt16LE(sum, 2);
    return buf;
  }

  private tryWrite(
    dev: NonNullable<XpadDevice['bulk']>,
    packet: Buffer,
    what: string
  ): boolean {
    try {
      dev.write(packet);
      return true;
    } catch (err) {
      // Throttle error spam from a 30 Hz ticker during unplug races.
      const now = Date.now();
      if (now - this.lastError > 5000) {
        this.lastError = now;
        console.error(`[protocol] ${what} write failed`, err);
      }
      return false;
    }
  }
}
