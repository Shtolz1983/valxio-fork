import { describe, expect, it } from 'vitest';
import { exampleProjects as examples } from '../data/examples';
import { stripBrandPrefix, isBoardComponentType } from '../utils/exampleToBuildNetlistInput';
import { validateCircuit } from '../validation/circuitValidator';

/**
 * The logic-level validator feeds the Run button's pre-flight
 * (verifyCircuitFromStore): an error there pops the "run anyway?" modal. The
 * gallery examples are known to work, so none of them may produce an error —
 * an error on one is a false positive in a rule, not a bad example.
 * Warnings are allowed (they are advice and do not block) and only reported.
 */
type Example = (typeof examples)[number];

function boardsOf(example: Example): Array<{ id: string; boardKind: string; code: string }> {
  const multi = (example as { boards?: Array<{ boardKind: string; code?: string }> }).boards;
  if (multi && multi.length) {
    const count = new Map<string, number>();
    return multi.map((b) => {
      const n = (count.get(b.boardKind) ?? 0) + 1;
      count.set(b.boardKind, n);
      return { id: n === 1 ? b.boardKind : `${b.boardKind}-${n}`, boardKind: b.boardKind, code: b.code ?? '' };
    });
  }
  const code = example.files?.map((f) => f.content).join('\n') ?? example.code ?? '';
  const legacy = (example.components ?? []).filter((c) => isBoardComponentType(c.type));
  if (legacy.length) return legacy.map((c) => ({ id: c.id, boardKind: stripBrandPrefix(c.type), code }));
  // Single-board examples name the board by an id no component declares.
  const kind = (example as { boardType?: string }).boardType ?? 'arduino-uno';
  const declared = new Set(example.components?.map((c) => c.id) ?? []);
  const refs = new Set<string>();
  for (const w of example.wires ?? []) {
    for (const ep of [w.start, w.end]) if (!declared.has(ep.componentId)) refs.add(ep.componentId);
  }
  return [...refs].map((id) => ({ id, boardKind: kind, code }));
}

describe('gallery: the logic-level validator raises no errors on working examples', () => {
  it('audits every wired example', () => {
    const candidates = examples.filter((e) => (e.components?.length ?? 0) > 0 && (e.wires?.length ?? 0) > 0);
    const errored: string[] = [];
    const warned = new Map<string, number>();

    for (const ex of candidates) {
      const boards = boardsOf(ex);
      const findings = validateCircuit({
        boards,
        components: (ex.components ?? [])
          .filter((c) => !isBoardComponentType(c.type))
          .map((c) => ({ id: c.id, metadataId: stripBrandPrefix(c.type), properties: c.properties ?? {} })),
        wires: (ex.wires ?? []).map((w) => ({ id: w.id, start: w.start, end: w.end })),
        code: Object.fromEntries(boards.map((b) => [b.id, b.code])),
      });
      for (const f of findings) {
        if (f.severity === 'error') errored.push(`${ex.id} [${f.code}] ${f.message.slice(0, 140)}`);
        else warned.set(f.code, (warned.get(f.code) ?? 0) + 1);
      }
    }

    if (warned.size) {
      console.log(`\n=== validator warnings over ${candidates.length} wired examples ===`);
      for (const [code, n] of warned) console.log(`  ${code.padEnd(24)} ${n}`);
    }
    expect(errored).toEqual([]);
  });
});
