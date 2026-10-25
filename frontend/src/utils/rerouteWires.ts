/**
 * Edit → "Route wires": hand the shape of every wire nobody bent by hand to
 * the auto-router, once, on request.
 *
 * Wires the agent drew before its wires were marked `autoRouted` (and wires
 * of older projects) keep the implicit elbow: horizontal first, then
 * vertical. Every wire from one module then runs along the same line and they
 * read as one. A wire without waypoints has no shape the user chose, so it
 * becomes system-owned and recalculateAllWirePositions lays it out beside
 * the others. Wires with waypoints are hand-authored and keep their shape.
 * One undo step brings every wire back as it was.
 */
import { useSimulatorStore } from '../store/useSimulatorStore';

/** How many wires the command would re-route now. */
export function reroutableWireCount(): number {
  return useSimulatorStore
    .getState()
    .wires.filter((w) => !w.bb && !w.autoRouted && w.waypoints.length === 0).length;
}

export function rerouteWires(): number {
  const store = useSimulatorStore.getState();
  const ids = new Set(
    store.wires.filter((w) => !w.bb && !w.autoRouted && w.waypoints.length === 0).map((w) => w.id),
  );
  if (ids.size === 0) return 0;
  const before = store.wires;
  store.pushCommand({
    description: 'Route wires',
    execute: () => {
      useSimulatorStore.setState((s) => ({
        wires: s.wires.map((w) => (ids.has(w.id) ? { ...w, autoRouted: true } : w)),
      }));
      useSimulatorStore.getState().recalculateAllWirePositions();
    },
    undo: () => useSimulatorStore.setState({ wires: before }),
  });
  return ids.size;
}
