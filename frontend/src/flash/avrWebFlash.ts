/**
 * Arduino Uno / Nano flashing over Web Serial: the STK500v1 protocol their
 * Optiboot bootloader speaks (what avrdude's "arduino" programmer does).
 *
 *   reset via DTR → GET_SYNC → READ_SIGN (must be an ATmega328P) →
 *   ENTER_PROGMODE → per 128-byte page: LOAD_ADDRESS + PROG_PAGE →
 *   read back and compare → LEAVE_PROGMODE
 *
 * The protocol runs over a small SerialLink so tests can drive it with a
 * fake bootloader; webSerialLink() adapts a real Web Serial port.
 */
import { hexToUint8Array } from '../utils/hexParser';
import type { WebFlashProgress, WebFlashRequest, WebFlashResult } from '../lib/proWebFlash';

export const AVR_FLASH_KINDS = new Set(['arduino-uno', 'arduino-nano']);

const STK = {
  OK: 0x10,
  INSYNC: 0x14,
  CRC_EOP: 0x20,
  GET_SYNC: 0x30,
  ENTER_PROGMODE: 0x50,
  LEAVE_PROGMODE: 0x51,
  LOAD_ADDRESS: 0x55,
  PROG_PAGE: 0x64,
  READ_PAGE: 0x74,
  READ_SIGN: 0x75,
} as const;

const ATMEGA328P_SIGNATURE = [0x1e, 0x95, 0x0f];
const PAGE_SIZE = 128;
/** Optiboot (Uno, new Nano) runs at 115200; the old Nano bootloader at 57600. */
const BAUD_RATES = [115200, 57600];

export interface SerialLink {
  write(bytes: Uint8Array): Promise<void>;
  /** Exactly n bytes, or rejects after timeoutMs. */
  read(n: number, timeoutMs: number): Promise<Uint8Array>;
  /** Drop whatever is buffered (bytes the running sketch was printing). */
  drain(): void;
  /** Pulse the board's reset line (DTR/RTS), as avrdude does. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex4 = (n: number) => n.toString(16).padStart(4, '0');

/**
 * Largest single Web Serial write. CH340 USB-serial chips (most Nano / Uno
 * clones) on macOS can drop the tail of a 133-byte page sent in one write,
 * leaving the bootloader waiting for bytes that never come.
 */
const WRITE_CHUNK = 32;

/**
 * Largest read-back asked for at once. The same CH340 setups can lose part of
 * a 130-byte READ_PAGE answer in Chrome (the bytes never arrive), so the
 * verification reads small pieces and retries a piece once after a resync.
 */
const READ_CHUNK = 32;

class Stk500 {
  private link: SerialLink;

  constructor(link: SerialLink) {
    this.link = link;
  }

  /**
   * Send a command and read INSYNC, `replyLength` payload bytes, OK. A
   * failure names the command (`what`) and how far the reply got, so a
   * flash that stalls on real hardware says where.
   */
  async command(what: string, bytes: number[], replyLength = 0, timeoutMs = 500): Promise<Uint8Array> {
    await this.link.write(new Uint8Array([...bytes, STK.CRC_EOP]));
    const step = async (part: string, n: number) => {
      try {
        return await this.link.read(n, timeoutMs);
      } catch (err) {
        const got = err instanceof Error && err.message.startsWith('got ') ? ` (${err.message})` : '';
        throw new Error(`${what}: no ${part} from the bootloader within ${timeoutMs} ms${got}`);
      }
    };
    const head = await step('reply', 1);
    if (head[0] !== STK.INSYNC) throw new Error(`${what}: bootloader out of sync (got 0x${head[0].toString(16)})`);
    const payload = replyLength ? await step(`${replyLength}-byte answer`, replyLength) : new Uint8Array();
    const tail = await step('end of reply', 1);
    if (tail[0] !== STK.OK) throw new Error(`${what}: bootloader refused the command (got 0x${tail[0].toString(16)})`);
    return payload;
  }

  async sync(): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      this.link.drain();
      try {
        await this.command('GET_SYNC', [STK.GET_SYNC], 0, 200);
        return;
      } catch {
        await sleep(50);
      }
    }
    throw new Error('no answer from the bootloader');
  }

  signature(): Promise<Uint8Array> {
    return this.command('READ_SIGN', [STK.READ_SIGN], 3);
  }

  async loadAddress(byteAddress: number): Promise<void> {
    const word = byteAddress >> 1;
    await this.command(`LOAD_ADDRESS 0x${hex4(byteAddress)}`, [STK.LOAD_ADDRESS, word & 0xff, (word >> 8) & 0xff]);
  }

  async writePage(byteAddress: number, data: Uint8Array): Promise<void> {
    await this.loadAddress(byteAddress);
    await this.command(
      `PROG_PAGE 0x${hex4(byteAddress)}`,
      [STK.PROG_PAGE, (data.length >> 8) & 0xff, data.length & 0xff, 0x46, ...data],
      0,
      1000,
    );
  }

  async readPage(byteAddress: number, length: number): Promise<Uint8Array> {
    await this.loadAddress(byteAddress);
    return this.command(
      `READ_PAGE 0x${hex4(byteAddress)}`,
      [STK.READ_PAGE, (length >> 8) & 0xff, length & 0xff, 0x46],
      length,
      1000,
    );
  }

  /** A page read back in READ_CHUNK pieces; a lost piece is read again once. */
  async readBack(byteAddress: number, length: number): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    for (let off = 0; off < length; off += READ_CHUNK) {
      const n = Math.min(READ_CHUNK, length - off);
      let piece: Uint8Array;
      try {
        piece = await this.readPage(byteAddress + off, n);
      } catch {
        // Let the rest of the broken answer arrive, drop it, and resync.
        await sleep(100);
        this.link.drain();
        await this.sync();
        piece = await this.readPage(byteAddress + off, n);
      }
      out.set(piece, off);
    }
    return out;
  }
}

/** Program bytes from Intel HEX, padded to whole pages with 0xFF. */
export function programPages(hex: string): Uint8Array[] {
  const bytes = hexToUint8Array(hex);
  const pages: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += PAGE_SIZE) {
    const page = new Uint8Array(PAGE_SIZE).fill(0xff);
    page.set(bytes.subarray(at, Math.min(at + PAGE_SIZE, bytes.length)));
    pages.push(page);
  }
  return pages;
}

export async function flashAvrOverLink(
  open: (baud: number) => Promise<SerialLink>,
  hex: string,
  onProgress: (p: WebFlashProgress) => void,
  signal?: AbortSignal,
): Promise<WebFlashResult> {
  const t0 = performance.now();
  if (!hex.trim().startsWith(':')) throw new Error('There is no compiled program to flash — compile the sketch first.');
  const pages = programPages(hex);
  if (pages.length === 0) throw new Error('The compiled program is empty.');

  let lastError: unknown = null;
  for (const baud of BAUD_RATES) {
    const link = await open(baud);
    try {
      const stk = new Stk500(link);
      onProgress({ phase: 'connecting', pct: 0, line: `Resetting the board (bootloader at ${baud} baud)…` });
      await link.reset();
      await stk.sync();

      const sig = await stk.signature();
      if (!ATMEGA328P_SIGNATURE.every((b, i) => sig[i] === b)) {
        const got = [...sig].map((b) => b.toString(16).padStart(2, '0')).join(' ');
        throw new Error(`The connected chip (signature ${got}) is not an ATmega328P — is this an Uno or Nano?`);
      }
      onProgress({ phase: 'connecting', pct: 0, line: 'Bootloader answered: ATmega328P.' });

      await stk.command('ENTER_PROGMODE', [STK.ENTER_PROGMODE]);
      for (let i = 0; i < pages.length; i++) {
        if (signal?.aborted) throw new Error('Cancelled.');
        await stk.writePage(i * PAGE_SIZE, pages[i]);
        onProgress({ phase: 'writing', pct: Math.round(((i + 1) / pages.length) * 90) });
      }
      for (let i = 0; i < pages.length; i++) {
        if (signal?.aborted) throw new Error('Cancelled.');
        const back = await stk.readBack(i * PAGE_SIZE, PAGE_SIZE);
        if (!back.every((b, j) => b === pages[i][j])) {
          throw new Error(`Verification failed at 0x${(i * PAGE_SIZE).toString(16)} — the flash did not take. Try again.`);
        }
      }
      onProgress({ phase: 'writing', pct: 100, line: `Wrote and verified ${pages.length * PAGE_SIZE} bytes.` });
      onProgress({ phase: 'resetting', pct: 100, line: 'Starting the sketch…' });
      await stk.command('LEAVE_PROGMODE', [STK.LEAVE_PROGMODE]);
      return { chipName: 'ATmega328P', elapsedMs: Math.round(performance.now() - t0) };
    } catch (err) {
      lastError = err;
      // Only a board that never answered is worth retrying at the other baud.
      if (!(err instanceof Error && err.message === 'no answer from the bootloader')) throw err;
    } finally {
      await link.close();
    }
  }
  throw new Error(
    `The board's bootloader did not answer (${lastError instanceof Error ? lastError.message : String(lastError)}). ` +
      'Check the USB cable and that no other program (Serial Monitor, Arduino IDE) holds the port.',
  );
}

/** A Web Serial port as a SerialLink. */
export function webSerialLink(port: SerialPort) {
  return async (baud: number): Promise<SerialLink> => {
    await port.open({ baudRate: baud });
    const reader = port.readable!.getReader();
    const writer = port.writable!.getWriter();
    let buffer: number[] = [];
    // Wakes a pending read() when bytes arrive.
    const wake: { fn: (() => void) | null } = { fn: null };
    let closed = false;

    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) buffer.push(...value);
          wake.fn?.();
        }
      } catch {
        /* port closed */
      }
    })();

    return {
      async write(bytes) {
        for (let at = 0; at < bytes.length; at += WRITE_CHUNK) {
          await writer.write(bytes.subarray(at, at + WRITE_CHUNK));
        }
      },
      async read(n, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (buffer.length < n) {
          const left = deadline - Date.now();
          if (left <= 0 || closed) throw new Error(`got ${buffer.length} of ${n} bytes`);
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, left);
            wake.fn = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          wake.fn = null;
        }
        const out = new Uint8Array(buffer.slice(0, n));
        buffer = buffer.slice(n);
        return out;
      },
      drain() {
        buffer = [];
      },
      async reset() {
        await port.setSignals({ dataTerminalReady: false, requestToSend: false });
        await sleep(250);
        await port.setSignals({ dataTerminalReady: true, requestToSend: true });
        await sleep(50);
      },
      async close() {
        closed = true;
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        writer.releaseLock();
        await port.close().catch(() => {});
      },
    };
  };
}

export function flashAvr(port: SerialPort, req: WebFlashRequest): Promise<WebFlashResult> {
  // For AVR boards the dialog passes the Intel HEX text in binaryBase64.
  return flashAvrOverLink(webSerialLink(port), req.binaryBase64, req.onProgress, req.signal);
}
