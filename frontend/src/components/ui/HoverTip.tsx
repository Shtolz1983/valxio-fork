/**
 * Instant tooltip for icon-only buttons. The native `title` shows after about
 * a second and is easy to miss; this one appears on hover or keyboard focus,
 * under the button, and is rendered in a portal so a panel's
 * `overflow: hidden` cannot clip it.
 */
import { cloneElement, useCallback, useRef, useState, type FocusEvent, type MouseEvent, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

const SHOW_DELAY_MS = 150;
const MAX_WIDTH = 260;

type TriggerProps = {
  onMouseEnter?: (e: MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (e: MouseEvent<HTMLElement>) => void;
  onFocus?: (e: FocusEvent<HTMLElement>) => void;
  onBlur?: (e: FocusEvent<HTMLElement>) => void;
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  'aria-label'?: string;
};

export const HoverTip = ({ text, children }: { text: string; children: ReactElement<TriggerProps> }) => {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((el: HTMLElement) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const r = el.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left, window.innerWidth - MAX_WIDTH - 8));
      setPos({ left, top: r.bottom + 6 });
    }, SHOW_DELAY_MS);
  }, []);
  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setPos(null);
  }, []);

  const p = children.props;
  const trigger = cloneElement(children, {
    'aria-label': p['aria-label'] ?? text,
    onMouseEnter: (e: MouseEvent<HTMLElement>) => {
      p.onMouseEnter?.(e);
      show(e.currentTarget);
    },
    onMouseLeave: (e: MouseEvent<HTMLElement>) => {
      p.onMouseLeave?.(e);
      hide();
    },
    onFocus: (e: FocusEvent<HTMLElement>) => {
      p.onFocus?.(e);
      if (e.currentTarget.matches(':focus-visible')) show(e.currentTarget);
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      p.onBlur?.(e);
      hide();
    },
    onClick: (e: MouseEvent<HTMLElement>) => {
      hide();
      p.onClick?.(e);
    },
  });

  return (
    <>
      {trigger}
      {pos &&
        createPortal(
          <div
            role="tooltip"
            style={{
              position: 'fixed',
              left: pos.left,
              top: pos.top,
              maxWidth: MAX_WIDTH,
              zIndex: 9800,
              padding: '5px 8px',
              fontSize: 12,
              fontWeight: 400,
              letterSpacing: 0,
              lineHeight: 1.4,
              color: 'var(--wb-13)',
              background: 'var(--wb-5)',
              border: '1px solid var(--wb-6)',
              borderRadius: 4,
              boxShadow: 'var(--shadow-4)',
              pointerEvents: 'none',
              fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
            }}
          >
            {text}
          </div>,
          document.body,
        )}
    </>
  );
};
