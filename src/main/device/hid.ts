import { EventEmitter } from 'node:events';
import HID from 'node-hid';

export const XPAD_VID = 0x3710;
export const XPAD_PID = 0x2507;

/** Vendor collections on interface 1 (see tools/hid-enum.js output, docs/PROTOCOL.md). */
export const USAGE_PAGE_CONFIG = 0xff00; // Col01 — config/command channel
export const USAGE_PAGE_AUX = 0xff11; // Col02
export const USAGE_PAGE_BULK = 0xff12; // Col03 — suspected bulk/LCD channel

const RECONNECT_POLL_MS = 3000;

export interface XpadChannels {
  config: HID.HID | null;
  aux: HID.HID | null;
  bulk: HID.HID | null;
}

/**
 * Finds and holds open handles to the XPAD Mini's vendor HID collections,
 * re-opening them automatically when the device is unplugged/replugged.
 *
 * Emits: 'connect', 'disconnect'.
 */
export class XpadDevice extends EventEmitter {
  private channels: XpadChannels = { config: null, aux: null, bulk: null };
  private pollTimer: NodeJS.Timeout | null = null;
  private _connected = false;

  get connected(): boolean {
    return this._connected;
  }

  get config(): HID.HID | null {
    return this.channels.config;
  }

  get aux(): HID.HID | null {
    return this.channels.aux;
  }

  get bulk(): HID.HID | null {
    return this.channels.bulk;
  }

  start(): void {
    this.tryOpen();
    this.pollTimer = setInterval(() => {
      if (!this._connected) this.tryOpen();
    }, RECONNECT_POLL_MS);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.closeAll();
  }

  private tryOpen(): void {
    let infos: HID.Device[];
    try {
      infos = HID.devices().filter(
        (d) => d.vendorId === XPAD_VID && d.productId === XPAD_PID
      );
    } catch (err) {
      console.error('[hid] enumerate failed', err);
      return;
    }
    if (infos.length === 0) return;

    const byPage = (page: number) => infos.find((d) => d.usagePage === page);
    const open = (info?: HID.Device): HID.HID | null => {
      if (!info?.path) return null;
      try {
        const dev = new HID.HID(info.path);
        dev.on('error', () => this.onError());
        return dev;
      } catch (err) {
        console.error('[hid] open failed', info.path, err);
        return null;
      }
    };

    const config = open(byPage(USAGE_PAGE_CONFIG));
    if (!config) return; // config channel is mandatory
    this.channels = {
      config,
      aux: open(byPage(USAGE_PAGE_AUX)),
      bulk: open(byPage(USAGE_PAGE_BULK)),
    };
    // Keep the HID read loop draining LCD acknowledgements between RPC reads.
    // Otherwise node-hid pauses when the last temporary data listener is removed.
    this.channels.bulk?.on('data', () => {});
    this._connected = true;
    console.log('[hid] XPAD Mini connected');
    this.emit('connect');
  }

  private onError(): void {
    if (!this._connected) return;
    console.log('[hid] XPAD Mini disconnected');
    this.closeAll();
    this.emit('disconnect');
  }

  private closeAll(): void {
    this._connected = false;
    for (const key of ['config', 'aux', 'bulk'] as const) {
      try {
        this.channels[key]?.close();
      } catch {
        // already closed
      }
      this.channels[key] = null;
    }
  }
}
