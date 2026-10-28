// @vitest-environment jsdom
/**
 * The AI chat inside the enclosure dialog (components/enclosure/EnclosureChat.tsx)
 * is the AI panel's conversation, not a second one: it shows the same items,
 * sends through the same store, and opens the panel so the bridge connects.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));
vi.mock('../ai/tools', () => ({ runAiTool: vi.fn() }));
// CodeMirror does not run in jsdom: a plain box stands in for the message editor.
vi.mock('../components/ai/ChatInput', () => ({
  ChatInput: (p: { value: string; onChange: (v: string) => void; disabled?: boolean }) =>
    createElement('textarea', { value: p.value, disabled: p.disabled, onChange: (e: { target: { value: string } }) => p.onChange(e.target.value) }),
}));

import { EnclosureChat } from '../components/enclosure/EnclosureChat';
import { useAiStore, type AiChatItem } from '../store/useAiStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom does not scroll: the chat keeps its last message in view with scrollTo.
Element.prototype.scrollTo ??= () => {};

let host: HTMLDivElement;
let root: Root;
const ITEMS: AiChatItem[] = [
  { id: 'u1', kind: 'user', text: 'a 6 mm cable hole on the left wall' },
  { id: 'a1', kind: 'assistant', text: 'Added it.', streaming: false },
];

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('enclosure chat', () => {
  it('shows the AI panel’s conversation and opens the panel', () => {
    const setOpen = vi.fn();
    useAiStore.setState({ items: ITEMS, connection: 'connected', busy: false, open: false, setOpen });
    act(() => root.render(createElement(EnclosureChat)));
    expect(setOpen).toHaveBeenCalledWith(true);
    expect([...host.querySelectorAll('.ai-msg')].map((m) => m.textContent)).toEqual(['a 6 mm cable hole on the left wall', 'Added it.']);
  });

  it('sends through the same store and can stop a running answer', () => {
    const send = vi.fn();
    const cancel = vi.fn();
    useAiStore.setState({ items: [], connection: 'connected', busy: false, open: true, send, cancel });
    act(() => root.render(createElement(EnclosureChat)));
    const box = host.querySelector('textarea')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'make the display window wider');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => host.querySelector<HTMLButtonElement>('.ai-send-btn')!.click());
    expect(send).toHaveBeenCalledWith('make the display window wider');

    act(() => useAiStore.setState({ busy: true }));
    act(() => host.querySelector<HTMLButtonElement>('.ai-send-btn')!.click());
    expect(cancel).toHaveBeenCalled();
  });

  it('says so when the bridge is not connected', () => {
    useAiStore.setState({ items: [], connection: 'disconnected', busy: false, open: true });
    act(() => root.render(createElement(EnclosureChat)));
    expect(host.textContent).toContain('not connected');
    expect(host.querySelector('textarea')!.disabled).toBe(true);
  });
});
