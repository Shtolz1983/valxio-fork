// @vitest-environment jsdom
/**
 * The AI chat of each project (ai/chatHistory.ts, store/useAiStore.ts): what
 * survives a reload, and which chat the panel shows when another project
 * opens.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../ai/tools', () => ({ runAiTool: vi.fn() }));

import { currentChatKey, loadChat, saveChat } from '../ai/chatHistory';
import { useAiStore, type AiChatItem } from '../store/useAiStore';
import { useProjectStore } from '../store/useProjectStore';
import { buildVlxPayload } from '../utils/vlxFile';

const SESSION = '3f0c2a1e-1111-4222-8333-944455556666';

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

describe('chat history', () => {
  it('keeps the transcript and the session, not the photos or long tool arguments', () => {
    const items: AiChatItem[] = [
      { id: '1', kind: 'user', text: 'what is this?', images: ['data:image/jpeg;base64,AAAA', 'data:image/jpeg;base64,BBBB'] },
      { id: '2', kind: 'tool', name: 'write_file', input: { boardId: 'uno', name: 'sketch.ino', content: 'x'.repeat(5000) }, status: 'running' },
      { id: '3', kind: 'assistant', text: 'A BME280.', streaming: true },
    ];
    saveChat('ws:a', SESSION, items);
    const back = loadChat('ws:a')!;
    expect(back.sessionId).toBe(SESSION);
    expect(back.items[0]).toEqual({ id: '1', kind: 'user', text: 'what is this?', photos: 2 });
    expect(back.items[1]).toMatchObject({ kind: 'tool', input: { boardId: 'uno', name: 'sketch.ino' }, status: 'error' });
    expect((back.items[1] as { input: Record<string, unknown> }).input.content).toBeUndefined();
    expect(back.items[2]).toMatchObject({ kind: 'assistant', streaming: false });
    expect(localStorage.getItem('velxio.aiChat.v1')).not.toContain('base64');
  });

  it('an emptied chat is forgotten', () => {
    saveChat('ws:a', SESSION, [{ id: '1', kind: 'user', text: 'hi' }]);
    saveChat('ws:a', null, []);
    expect(loadChat('ws:a')).toBeNull();
  });

  it('files the chat under the project: server project id, else the workspace identity', () => {
    useProjectStore.getState().setWorkspaceId('w1');
    expect(currentChatKey()).toBe('ws:w1');
    useProjectStore.getState().setCurrentProject({ id: 'p9', slug: 's', ownerUsername: 'u', isPublic: false });
    expect(currentChatKey()).toBe('project:p9');
    useProjectStore.getState().clearCurrentProject();
    expect(currentChatKey()).toMatch(/^ws:/);
    expect(currentChatKey()).not.toBe('ws:w1');
  });

  it('the panel shows the open project’s chat and saves the one it leaves', () => {
    useProjectStore.getState().setWorkspaceId('alpha');
    useAiStore.setState({ items: [{ id: 'a', kind: 'user', text: 'weather station' }], sessionId: SESSION });
    vi.advanceTimersByTime(600);
    expect(loadChat('ws:alpha')?.items).toHaveLength(1);

    useProjectStore.getState().setWorkspaceId('beta');
    expect(useAiStore.getState().items).toEqual([]);
    expect(useAiStore.getState().sessionId).toBeNull();

    useProjectStore.getState().setWorkspaceId('alpha');
    expect(useAiStore.getState().items).toEqual([{ id: 'a', kind: 'user', text: 'weather station' }]);
    expect(useAiStore.getState().sessionId).toBe(SESSION);
  });

  it('a .vlx file carries the workspace identity', () => {
    useProjectStore.getState().setWorkspaceId('gamma');
    expect(buildVlxPayload().workspaceId).toBe('gamma');
  });
});
