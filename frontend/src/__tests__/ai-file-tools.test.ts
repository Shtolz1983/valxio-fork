// @vitest-environment jsdom
/**
 * The assistant's file tools (ai/tools.ts): a long sketch is seen whole
 * (get_project marks it cut, read_file returns it all) and changed in place
 * (edit_file), so the assistant never guesses the part it did not see.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { runAiTool } from '../ai/tools';
import { useEditorStore } from '../store/useEditorStore';
import { useSimulatorStore } from '../store/useSimulatorStore';

/** A ~16 000-character sketch, its lines numbered so a cut shows. */
const LONG = Array.from({ length: 400 }, (_, i) => `// line ${i + 1} ${'x'.repeat(30)}`).join('\n') + '\nvoid loop() {}\n';

function boardWithSketch(content: string) {
  const sim = useSimulatorStore.getState();
  const id = sim.addBoard('arduino-uno', 0, 0);
  const board = useSimulatorStore.getState().boards.find((b) => b.id === id)!;
  const ed = useEditorStore.getState();
  const file = ed.getGroupFiles(board.activeFileGroupId).find((f) => f.name === 'sketch.ino');
  if (file) ed.setGroupFileContent(board.activeFileGroupId, file.id, content);
  else ed.addFileToGroup(board.activeFileGroupId, { name: 'sketch.ino', content });
  return id;
}

const sketchOf = (boardId: string) => {
  const b = useSimulatorStore.getState().boards.find((x) => x.id === boardId)!;
  return useEditorStore.getState().getGroupFiles(b.activeFileGroupId).find((f) => f.name === 'sketch.ino')!.content;
};

let boardId: string;
beforeEach(() => {
  boardId = boardWithSketch(LONG);
});

describe('assistant file tools', () => {
  it('get_project shows a long sketch cut and says how to read the rest', async () => {
    const project = (await runAiTool('get_project', {})) as {
      boards: Array<{ id: string; files: Array<{ name: string; content: string; lines: number; truncated?: string }> }>;
    };
    const f = project.boards.find((b) => b.id === boardId)!.files.find((x) => x.name === 'sketch.ino')!;
    expect(f.lines).toBe(402);
    expect(f.content.length).toBeLessThan(LONG.length);
    expect(f.truncated).toMatch(/read_file/);
  });

  it('read_file returns the whole sketch, and pages by lines', async () => {
    const all = (await runAiTool('read_file', { boardId, name: 'sketch.ino' })) as { content: string; totalLines: number; more?: string };
    expect(all.content).toBe(LONG);
    expect(all.totalLines).toBe(402);
    expect(all.more).toBeUndefined();
    const page = (await runAiTool('read_file', { boardId, name: 'sketch.ino', startLine: 399, maxLines: 2 })) as {
      content: string;
      endLine: number;
      more?: string;
    };
    expect(page.content).toBe(`// line 399 ${'x'.repeat(30)}\n// line 400 ${'x'.repeat(30)}`);
    expect(page.endLine).toBe(400);
    expect(page.more).toMatch(/startLine 401/);
  });

  it('edit_file changes only the exact text, and refuses an ambiguous or missing one', async () => {
    await runAiTool('edit_file', { boardId, name: 'sketch.ino', oldText: 'void loop() {}', newText: 'void loop() { tick(); }' });
    const after = sketchOf(boardId);
    expect(after).toBe(LONG.replace('void loop() {}', 'void loop() { tick(); }'));
    await expect(runAiTool('edit_file', { boardId, name: 'sketch.ino', oldText: 'xxxxxxxxxx', newText: 'y' })).rejects.toThrow(/occurs \d+ times/);
    await expect(runAiTool('edit_file', { boardId, name: 'sketch.ino', oldText: 'joystick', newText: 'ir' })).rejects.toThrow(/not found/);
    await expect(runAiTool('read_file', { boardId, name: 'nope.ino' })).rejects.toThrow(/no file "nope.ino"/);
  });
});
