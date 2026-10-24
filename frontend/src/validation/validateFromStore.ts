/**
 * Runs the logic-level validator on the circuit and sketches the stores hold.
 * Kept apart from circuitValidator.ts so the validator itself stays pure
 * (no store imports) and testable in isolation.
 */
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useEditorStore } from '../store/useEditorStore';
import type { CircuitWarning } from '../simulation/verify/circuitVerifier';
import { validateCircuit } from './circuitValidator';

export function validateCircuitFromStore(): CircuitWarning[] {
  const sim = useSimulatorStore.getState();
  const editor = useEditorStore.getState();
  const code: Record<string, string> = {};
  for (const b of sim.boards) {
    code[b.id] = editor
      .getGroupFiles(b.activeFileGroupId)
      .map((f) => f.content)
      .join('\n');
  }
  return validateCircuit({
    boards: sim.boards.map((b) => ({ id: b.id, boardKind: b.boardKind })),
    components: sim.components.map((c) => ({ id: c.id, metadataId: c.metadataId, properties: c.properties })),
    wires: sim.wires,
    code,
  });
}
