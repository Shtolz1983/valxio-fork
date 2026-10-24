import { describe, it, expect } from 'vitest';
import { flashAvrOverLink, programPages, type SerialLink } from '../flash/avrWebFlash';

/** A fake Optiboot: answers STK500v1 commands and keeps the flash it was sent. */
function fakeOptiboot(opts: { baud?: number; signature?: number[]; corruptReadback?: boolean } = {}) {
  const flash = new Uint8Array(32 * 1024).fill(0xff);
  const log: string[] = [];
  let address = 0;
  let out: number[] = [];

  const reply = (payload: number[] = []) => out.push(0x14, ...payload, 0x10);

  const open = async (baud: number): Promise<SerialLink> => {
    const answers = baud === (opts.baud ?? 115200);
    return {
      async write(bytes) {
        if (!answers) return;
        const [cmd] = bytes;
        switch (cmd) {
          case 0x30:
            log.push('sync');
            reply();
            break;
          case 0x75:
            reply(opts.signature ?? [0x1e, 0x95, 0x0f]);
            break;
          case 0x50:
            log.push('enter');
            reply();
            break;
          case 0x51:
            log.push('leave');
            reply();
            break;
          case 0x55:
            address = (bytes[1] | (bytes[2] << 8)) * 2;
            reply();
            break;
          case 0x64: {
            const len = (bytes[1] << 8) | bytes[2];
            flash.set(bytes.subarray(4, 4 + len), address);
            reply();
            break;
          }
          case 0x74: {
            const len = (bytes[1] << 8) | bytes[2];
            const data = [...flash.subarray(address, address + len)];
            if (opts.corruptReadback) data[0] ^= 0xff;
            reply(data);
            break;
          }
        }
      },
      async read(n) {
        if (out.length < n) throw new Error('timeout');
        const chunk = out.slice(0, n);
        out = out.slice(n);
        return new Uint8Array(chunk);
      },
      drain() {
        out = [];
      },
      async reset() {
        log.push(`reset@${baud}`);
      },
      async close() {},
    };
  };
  return { open, flash, log };
}

// Two data records (0x00 and 0x80) + EOF — 132 bytes of program, so two pages.
function hexOf(bytes: number[], base = 0): string {
  const lines: string[] = [];
  for (let at = 0; at < bytes.length; at += 16) {
    const chunk = bytes.slice(at, at + 16);
    const addr = base + at;
    const rec = [chunk.length, (addr >> 8) & 0xff, addr & 0xff, 0, ...chunk];
    const sum = (0x100 - (rec.reduce((a, b) => a + b, 0) & 0xff)) & 0xff;
    lines.push(':' + [...rec, sum].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase());
  }
  lines.push(':00000001FF');
  return lines.join('\n');
}

const PROGRAM = Array.from({ length: 132 }, (_, i) => (i * 7) & 0xff);

describe('AVR Web Serial flasher (STK500v1)', () => {
  it('pads the program to whole 128-byte pages', () => {
    const pages = programPages(hexOf(PROGRAM));
    expect(pages).toHaveLength(2);
    expect(pages[1][3]).toBe(PROGRAM[131]);
    expect(pages[1][4]).toBe(0xff);
  });

  it('writes, verifies and leaves programming mode', async () => {
    const board = fakeOptiboot();
    const result = await flashAvrOverLink(board.open, hexOf(PROGRAM), () => {});
    expect(result.chipName).toBe('ATmega328P');
    expect([...board.flash.subarray(0, PROGRAM.length)]).toEqual(PROGRAM);
    expect(board.log).toEqual(['reset@115200', 'sync', 'enter', 'leave']);
  });

  it('falls back to 57600 baud for the old Nano bootloader', async () => {
    const board = fakeOptiboot({ baud: 57600 });
    await flashAvrOverLink(board.open, hexOf(PROGRAM), () => {});
    expect(board.log[0]).toBe('reset@115200');
    expect(board.log).toContain('reset@57600');
    expect([...board.flash.subarray(0, PROGRAM.length)]).toEqual(PROGRAM);
  });

  it('refuses a chip that is not an ATmega328P', async () => {
    const board = fakeOptiboot({ signature: [0x1e, 0x98, 0x01] });
    await expect(flashAvrOverLink(board.open, hexOf(PROGRAM), () => {})).rejects.toThrow(/not an ATmega328P/);
    expect(board.log).not.toContain('enter');
  });

  it('reports a failed read-back', async () => {
    const board = fakeOptiboot({ corruptReadback: true });
    await expect(flashAvrOverLink(board.open, hexOf(PROGRAM), () => {})).rejects.toThrow(/Verification failed/);
  });

  it('explains a board that never answers', async () => {
    const board = fakeOptiboot({ baud: 9600 });
    await expect(flashAvrOverLink(board.open, hexOf(PROGRAM), () => {})).rejects.toThrow(/did not answer/);
  });

  it('rejects an empty program before touching the port', async () => {
    const board = fakeOptiboot();
    await expect(flashAvrOverLink(board.open, '', () => {})).rejects.toThrow(/compile the sketch first/);
    expect(board.log).toEqual([]);
  });
});
