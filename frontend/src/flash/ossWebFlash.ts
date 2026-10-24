/**
 * Open-source Web Serial flasher behind the lib/proWebFlash.ts seam, so the
 * board menu's "Flash to real board" works in a plain self-hosted build:
 * ESP32 / S3 / C3 through esptool-js, Arduino Uno / Nano through STK500v1.
 * A pro overlay that installs its own flasher replaces this one.
 */
import { installWebFlashImpl, type WebFlashImpl } from '../lib/proWebFlash';
import { ESP_CHIP_BY_KIND, flashEsp } from './espWebFlash';
import { AVR_FLASH_KINDS, flashAvr } from './avrWebFlash';

const hasWebSerial = () => typeof navigator !== 'undefined' && 'serial' in navigator;
const supported = (kind: string) => kind in ESP_CHIP_BY_KIND || AVR_FLASH_KINDS.has(kind);

// Granted at the click (preparePort), used after the compile finishes.
let grantedPort: SerialPort | null = null;

export const ossWebFlash: WebFlashImpl = {
  available: (boardKind) => hasWebSerial() && supported(boardKind),

  async preparePort() {
    try {
      grantedPort = await navigator.serial.requestPort();
    } catch {
      throw new Error('No serial port was selected. Plug the board in over USB and pick its port.');
    }
  },

  async flash(req) {
    const port = grantedPort ?? (await navigator.serial.requestPort());
    grantedPort = null;
    if (req.boardKind in ESP_CHIP_BY_KIND) return flashEsp(port, req);
    if (AVR_FLASH_KINDS.has(req.boardKind)) return flashAvr(port, req);
    throw new Error(`Flashing a ${req.boardKind} from the browser is not supported yet.`);
  },
};

export function installOssWebFlash(): void {
  installWebFlashImpl(ossWebFlash);
}
