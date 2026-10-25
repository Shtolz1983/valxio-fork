// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { reroutableWireCount, rerouteWires } from '../utils/rerouteWires';
import type { Wire } from '../types/wire';

const wire = (id: string, patch: Partial<Wire> = {}): Wire => ({
  id,
  start: { componentId: 'dht11_1', pinName: 'DATA', x: 513, y: 43 },
  end: { componentId: 'arduino-nano', pinName: '4', x: 147, y: 55 },
  waypoints: [],
  color: '#22cc44',
  ...patch,
});

describe('Edit → Route wires', () => {
  beforeEach(() => {
    useSimulatorStore.getState().clearHistory();
    useSimulatorStore.setState({
      wires: [
        wire('old-agent'),
        wire('hand', { waypoints: [{ x: 300, y: 20 }] }),
        wire('routed', { autoRouted: true, waypoints: [{ x: 147, y: 43 }] }),
        wire('seat', { bb: true }),
      ],
    });
  });

  it('hands only the wires nobody shaped to the router, in one undo step', () => {
    expect(reroutableWireCount()).toBe(1);
    expect(rerouteWires()).toBe(1);
    const byId = Object.fromEntries(useSimulatorStore.getState().wires.map((w) => [w.id, w]));
    expect(byId['old-agent'].autoRouted).toBe(true);
    expect(byId['hand'].autoRouted).toBeUndefined();
    expect(byId['hand'].waypoints).toEqual([{ x: 300, y: 20 }]);
    expect(byId['seat'].autoRouted).toBeUndefined();
    expect(reroutableWireCount()).toBe(0);

    useSimulatorStore.getState().undo();
    const old = useSimulatorStore.getState().wires.find((w) => w.id === 'old-agent')!;
    expect(old.autoRouted).toBeUndefined();
    expect(old.waypoints).toEqual([]);
  });

  it('does nothing when every wire already has a shape', () => {
    useSimulatorStore.setState({ wires: [wire('hand', { waypoints: [{ x: 1, y: 2 }] })] });
    const historyBefore = useSimulatorStore.getState().history.length;
    expect(rerouteWires()).toBe(0);
    expect(useSimulatorStore.getState().history.length).toBe(historyBefore);
  });
});
