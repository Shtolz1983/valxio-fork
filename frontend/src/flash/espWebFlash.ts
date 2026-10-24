/**
 * ESP32-family flashing over Web Serial with esptool-js.
 *
 * The compile endpoint returns one merged flash image that starts at offset
 * 0x0 (bootloader at the chip's ROM offset, partition table, app — trimmed
 * of trailing 0xFF, see backend espidf_compiler._merge_flash_image), so the
 * whole image is written in one piece at address 0.
 */
import { ESPLoader, Transport, type IEspLoaderTerminal } from 'esptool-js';
import type { WebFlashProgress, WebFlashRequest, WebFlashResult } from '../lib/proWebFlash';

/** Board kind → chip name esptool-js reports (ROM.CHIP_NAME). */
export const ESP_CHIP_BY_KIND: Record<string, string> = {
  esp32: 'ESP32',
  'esp32-devkit-c-v4': 'ESP32',
  'esp32-cam': 'ESP32',
  'wemos-lolin32-lite': 'ESP32',
  'esp32-s3': 'ESP32-S3',
  'xiao-esp32-s3': 'ESP32-S3',
  'arduino-nano-esp32': 'ESP32-S3',
  'esp32-c3': 'ESP32-C3',
  'xiao-esp32-c3': 'ESP32-C3',
  'aitewinrobot-esp32c3-supermini': 'ESP32-C3',
};

const FLASH_BAUD = 921600;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function terminal(onProgress: (p: WebFlashProgress) => void): IEspLoaderTerminal {
  let partial = '';
  return {
    clean() {},
    write(data: string) {
      partial += data;
    },
    writeLine(data: string) {
      const line = (partial + data).trim();
      partial = '';
      if (line) onProgress({ phase: 'connecting', pct: 0, line });
    },
  };
}

export async function flashEsp(port: SerialPort, req: WebFlashRequest): Promise<WebFlashResult> {
  const t0 = performance.now();
  const expected = ESP_CHIP_BY_KIND[req.boardKind];
  const image = base64ToBytes(req.binaryBase64);
  if (image.length === 0) throw new Error('There is no compiled program to flash — compile the sketch first.');

  const transport = new Transport(port, false);
  const onAbort = () => void transport.disconnect().catch(() => {});
  req.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const loader = new ESPLoader({ transport, baudrate: FLASH_BAUD, terminal: terminal(req.onProgress) });
    req.onProgress({ phase: 'connecting', pct: 0, line: 'Connecting to the board…' });
    try {
      await loader.main('default_reset');
    } catch (err) {
      throw new Error(
        `The board did not answer (${err instanceof Error ? err.message : String(err)}). ` +
          'Hold the BOOT button, press and release EN/RST, release BOOT, then try again.',
      );
    }
    const chip = loader.chip.CHIP_NAME;
    if (expected && chip !== expected) {
      throw new Error(`The connected board is an ${chip}, but this project is built for an ${expected}. Pick the matching board on the canvas.`);
    }

    await loader.writeFlash({
      fileArray: [{ data: image, address: 0 }],
      flashSize: 'keep',
      flashMode: 'keep',
      flashFreq: 'keep',
      eraseAll: false,
      compress: true,
      reportProgress: (_i, written, total) =>
        req.onProgress({ phase: 'writing', pct: total ? Math.round((written / total) * 100) : 0 }),
    });

    req.onProgress({ phase: 'resetting', pct: 100, line: 'Restarting the board…' });
    await loader.after('hard_reset');
    return { chipName: chip, elapsedMs: Math.round(performance.now() - t0) };
  } finally {
    req.signal.removeEventListener('abort', onAbort);
    await transport.disconnect().catch(() => {});
  }
}
