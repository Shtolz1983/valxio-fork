/**
 * "The board's firmware just booted" for boards whose firmware runs in a
 * backend worker (ESP32 under QEMU).
 *
 * A voltage or a pin level a module sets before the run starts never reaches
 * such a board: the bridge drops messages while its socket is closed, and a
 * fresh worker starts with every ADC channel at 0 V. I2C records travel with
 * the start command, levels do not, so a module puts its levels again when
 * the worker says it has booted. Boards simulated in the tab have no bridge
 * and never call back.
 */

type SystemEventHandler = ((event: string, data: Record<string, unknown>) => void) | null;
interface BridgeLike {
  onSystemEvent: SystemEventHandler;
}

const listeners = new WeakMap<BridgeLike, Set<() => void>>();

function bridgeOf(simulator: unknown): BridgeLike | null {
  const bridge = (simulator as { bridge?: unknown } | null)?.bridge as BridgeLike | undefined;
  return bridge && typeof bridge === 'object' && 'onSystemEvent' in bridge ? bridge : null;
}

/** Call `fn` every time the simulator's worker reports a boot; returns the unsubscribe. */
export function onBoardBooted(simulator: unknown, fn: () => void): () => void {
  const bridge = bridgeOf(simulator);
  if (!bridge) return () => {};
  let set = listeners.get(bridge);
  if (!set) {
    const own = new Set<() => void>();
    set = own;
    listeners.set(bridge, own);
    // Chained, not replaced: whatever the app put there keeps hearing events.
    const previous = bridge.onSystemEvent;
    bridge.onSystemEvent = (event, data) => {
      previous?.(event, data);
      if (event === 'booted') for (const f of [...own]) f();
    };
  }
  set.add(fn);
  const mine = set;
  return () => {
    mine.delete(fn);
  };
}
