/**
 * The AI chat's message box: a CodeMirror editor where `$` opens the list of
 * parts (ai/partMentions.ts) and a picked part sits in the text as a chip,
 * stored as `$[type]` and removed whole by Backspace.
 *
 * Keys: with sendKey "enter", Enter sends and Shift+Enter breaks the line; with
 * "mod-enter" (the large editor) Enter breaks the line and Ctrl/Cmd+Enter
 * sends. While the parts list is open, Enter/Tab pick and Esc closes it.
 * Pasted or dropped images go to onImages instead of the text.
 */
import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  WidgetType,
  keymap,
  placeholder as placeholderExt,
  tooltips,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, insertNewline } from '@codemirror/commands';
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { ComponentRegistry } from '../../services/ComponentRegistry';
import { imageFiles } from '../../ai/images';
import { MENTION_RE, mentionLabel, mentionParts, mentionText, searchMentionParts } from '../../ai/partMentions';

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  sendKey: 'enter' | 'mod-enter';
  onEscape?: () => void;
  onImages: (files: File[]) => void;
  placeholder: string;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

class MentionWidget extends WidgetType {
  readonly type: string;
  readonly label: string;
  constructor(type: string, label: string) {
    super();
    this.type = type;
    this.label = label;
  }
  eq(other: MentionWidget) {
    return other.type === this.type && other.label === this.label;
  }
  toDOM() {
    const chip = document.createElement('span');
    chip.className = 'ai-mention';
    chip.textContent = this.label;
    chip.title = this.type;
    return chip;
  }
}

const mentionMatcher = new MatchDecorator({
  regexp: new RegExp(MENTION_RE.source, 'g'),
  decoration: (m) => Decoration.replace({ widget: new MentionWidget(m[1], mentionLabel(m[1])) }),
});

const mentionChips = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = mentionMatcher.createDeco(view);
    }
    update(update: ViewUpdate) {
      this.decorations = mentionMatcher.updateDeco(update, this.decorations);
    }
  },
  {
    decorations: (v) => v.decorations,
    // The cursor steps over a chip and Backspace deletes it whole.
    provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
  },
);

export const ChatInput: React.FC<ChatInputProps> = (props) => {
  const { t, i18n } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const editable = useRef(new Compartment());
  const hint = useRef(new Compartment());
  // The editor is built once; its handlers read the latest props through this.
  const latest = useRef({ props, t, ru: false });
  useLayoutEffect(() => {
    latest.current = { props, t, ru: i18n.language.startsWith('ru') };
  });

  useEffect(() => {
    const send = () => {
      latest.current.props.onSubmit();
      return true;
    };
    const partsSource = (ctx: CompletionContext): CompletionResult | null => {
      const typed = ctx.matchBefore(/\$[^\s$[\]]*/);
      if (!typed) return null;
      const { t: tr, ru } = latest.current;
      const options = searchMentionParts(mentionParts(), typed.text.slice(1)).map(
        (p): Completion => ({
          label: p.name,
          detail: p.card
            ? ((ru ? p.card.titleRu : undefined) ?? p.card.title)
            : ComponentRegistry.getCategoryDisplayName(p.category),
          info: p.card?.sim ? tr('aiPanel.mentionSim', 'Simulated values') : undefined,
          section: p.card
            ? { name: tr('aiPanel.mentionCatalog', 'Sensor catalogue'), rank: 0 }
            : { name: tr('aiPanel.mentionParts', 'Parts'), rank: 1 },
          apply: `${mentionText(p.type)} `,
        }),
      );
      return { from: typed.from, options, filter: false };
    };

    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          history(),
          EditorView.lineWrapping,
          editable.current.of([EditorView.editable.of(!props.disabled), EditorState.readOnly.of(!!props.disabled)]),
          hint.current.of(placeholderExt(props.placeholder)),
          mentionChips,
          // In <body>, so the list is not cut off by the panel or the dialog.
          tooltips({ parent: document.body }),
          autocompletion({ override: [partsSource], icons: false, maxRenderedOptions: 50 }),
          Prec.high(
            keymap.of([
              { key: 'Enter', run: () => (latest.current.props.sendKey === 'enter' ? send() : false) },
              { key: 'Shift-Enter', run: insertNewline },
              { key: 'Mod-Enter', run: send },
              {
                key: 'Escape',
                run: () => {
                  const onEscape = latest.current.props.onEscape;
                  if (!onEscape) return false;
                  onEscape();
                  return true;
                },
              },
            ]),
          ),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.props.onChange(u.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            paste: (e) => {
              const files = imageFiles(e.clipboardData?.items);
              if (!files.length) return false;
              e.preventDefault();
              latest.current.props.onImages(files);
              return true;
            },
            // Files are never pasted into the text (CodeMirror would insert their
            // contents); images become attachments. The composer still sees the
            // drop (defaultPrevented) to clear its highlight.
            drop: (e) => {
              if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return false;
              e.preventDefault();
              const files = imageFiles(e.dataTransfer?.files);
              if (files.length) latest.current.props.onImages(files);
              return true;
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    if (props.autoFocus) {
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.length } });
    }
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The editor is created once per mount; later prop changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A draft changed from outside (cleared after sending, typed in the other box).
  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === props.value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.value } });
  }, [props.value]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [
        editable.current.reconfigure([EditorView.editable.of(!props.disabled), EditorState.readOnly.of(!!props.disabled)]),
        hint.current.reconfigure(placeholderExt(props.placeholder)),
      ],
    });
  }, [props.disabled, props.placeholder]);

  return (
    <div
      ref={host}
      className={`ai-cm${props.disabled ? ' is-disabled' : ''}${props.className ? ` ${props.className}` : ''}`}
      style={props.style}
    />
  );
};
