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

class Stk500 {
  private link: SerialLink;

  constructor(link: SerialLink) {
    this.link = link;
  }

  /** Send a command and read INSYNC, `replyLength` payload bytes, OK. */
  async command(bytes: number[], replyLength = 0, timeoutMs = 500): Promise<Uint8Array> {
    await this.link.write(new Uint8Array([...bytes, STK.CRC_EOP]));
    const head = await this.link.read(1, timeoutMs);
    if (head[0] !== STK.INSYNC) throw new Error(`bootloader out of sync (got 0x${head[0].toString(16)})`);
    const payload = replyLength ? await this.link.read(replyLength, timeoutMs) : new Uint8Array();
    const tail = await this.link.read(1, timeoutMs);
    if (tail[0] !== STK.OK) throw new Error(`bootloader refused the command (got 0x${tail[0].toString(16)})`);
    return payload;
  }

  async sync(): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      this.link.drain();
      try {
        await this.command([STK.GET_SYNC], 0, 200);
        return;
      } catch {
        await sleep(50);
      }
    }
    throw new Error('no answer from the bootloader');
  }

  signature(): Promise<Uint8Array> {
    return this.command([STK.READ_SIGN], 3);
  }

  async loadAddress(byteAddress: number): Promise<void> {
    const word = byteAddress >> 1;
    await this.command([STK.LOAD_ADDRESS, word & 0xff, (word >> 8) & 0xff]);
  }

  async writePage(byteAddress: number, data: Uint8Array): Promise<void> {
    await this.loadAddress(byteAddress);
    await this.command([STK.PROG_PAGE, (data.length >> 8) & 0xff, data.length & 0xff, 0x46, ...data], 0, 1000);
  }

  async readPage(byteAddress: number, length: number): Promise<Uint8Array> {
    await this.loadAddress(byteAddress);
    return this.command([STK.READ_PAGE, (length >> 8) & 0xff, length & 0xff, 0x46], length, 1000);
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

      await stk.command([STK.ENTER_PROGMODE]);
      for (let i = 0; i < pages.length; i++) {
        if (signal?.aborted) throw new Error('Cancelled.');
        await stk.writePage(i * PAGE_SIZE, pages[i]);
        onProgress({ phase: 'writing', pct: Math.round(((i + 1) / pages.length) * 90) });
      }
      for (let i = 0; i < pages.length; i++) {
        const back = await stk.readPage(i * PAGE_SIZE, PAGE_SIZE);
        if (!back.every((b, j) => b === pages[i][j])) {
          throw new Error(`Verification failed at 0x${(i * PAGE_SIZE).toString(16)} — the flash did not take. Try again.`);
        }
      }
      onProgress({ phase: 'writing', pct: 100, line: `Wrote and verified ${pages.length * PAGE_SIZE} bytes.` });
      onProgress({ phase: 'resetting', pct: 100, line: 'Starting the sketch…' });
      await stk.command([STK.LEAVE_PROGMODE]);
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
        await writer.write(bytes);
      },
      async read(n, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (buffer.length < n) {
          const left = deadline - Date.now();
          if (left <= 0 || closed) throw new Error('timeout');
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
