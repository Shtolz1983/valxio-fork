/**
 * Whether a board can go onto real hardware from here, and the hint that says
 * how. The board menu's "Flash to real board" and the toolbar's upload button
 * both ask this, so they always agree.
 *
 * Flashing needs USB serial: the desktop shell always has it; on the web a
 * Web Serial flasher may be installed for the board kind (flash/ossWebFlash.ts
 * or a pro overlay's). RP2040 / RP2350 boards also program from a .uf2
 * dropped on their BOOTSEL drive, which needs no flasher at all.
 */
import type { BoardInstance } from '../types/board';
import { webFlashAvailable, webFlashMpyAvailable } from '../lib/proWebFlash';
import { boardKindHasUf2 } from './uf2Download';

/** Keys under editor.canvas.flashHint. */
export type FlashHint = 'mpy' | 'mpyUnavailable' | 'ready' | 'willCompile' | 'uf2Download';

export interface FlashOffer {
  enabled: boolean;
  hint: FlashHint;
}

/** Null when this board cannot be flashed here at all. */
export function flashOffer(
  board: Pick<BoardInstance, 'boardKind' | 'languageMode' | 'compiledProgram'>,
  desktop: boolean,
): FlashOffer | null {
  const isMpy = board.languageMode === 'micropython';
  const webFlashOk = webFlashAvailable(board.boardKind);
  const uf2Only = !desktop && !webFlashOk && !isMpy && boardKindHasUf2(board.boardKind);
  if (!desktop && !webFlashOk && !uf2Only) return null;
  // MicroPython boards don't compile to a flash image; they flash only when
  // the web flasher implements the MicroPython path (firmware install + raw-REPL
  // file upload). Arduino / ESP-IDF boards are always flashable: the Flash
  // dialog compiles first when there is no build (or a stale one).
  const mpyWebOk = isMpy && !desktop && webFlashMpyAvailable(board.boardKind);
  return {
    enabled: isMpy ? mpyWebOk : true,
    hint: isMpy
      ? mpyWebOk
        ? 'mpy'
        : 'mpyUnavailable'
      : uf2Only
        ? 'uf2Download'
        : board.compiledProgram
          ? 'ready'
          : 'willCompile',
  };
}
