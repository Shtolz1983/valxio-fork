/**
 * Quick tooltips for a toolbar: pointing at (or tabbing to) an element with a
 * `title` inside `host` shows that text under it after a short delay, styled
 * like the app, instead of the browser's slow, small native tooltip.
 *
 * The title moves to `data-tip` while its tooltip is up, so the native one does
 * not show as well, and comes back when the pointer leaves. Disabled buttons
 * get no pointer events of their own, so hovering is followed by position
 * (elementFromPoint) rather than by event targets.
 */
import { useEffect } from 'react';
import './hoverTips.css';

const DELAY_MS = 250;
const GAP = 6;
const EDGE = 4;

/** `host` is the toolbar element (a callback ref's value, so a later mount is picked up). */
export function useHoverTips(host: HTMLElement | null): void {
  useEffect(() => {
    if (!host) return;
    const tip = document.createElement('div');
    tip.className = 'hover-tip';
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);

    let target: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const hide = () => {
      clearTimeout(timer);
      tip.classList.remove('is-shown');
      if (target) {
        const text = target.dataset.tip;
        delete target.dataset.tip;
        // React may have set a new title meanwhile; that one wins.
        if (text && !target.hasAttribute('title')) target.setAttribute('title', text);
      }
      target = null;
    };

    const place = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      const w = tip.offsetWidth;
      const left = Math.min(Math.max(r.left + r.width / 2 - w / 2, EDGE), window.innerWidth - w - EDGE);
      tip.style.left = `${left}px`;
      tip.style.top = `${r.bottom + GAP}px`;
    };

    const show = (el: HTMLElement) => {
      const text = el.getAttribute('title');
      if (!text) return;
      target = el;
      el.dataset.tip = text;
      el.removeAttribute('title');
      timer = setTimeout(() => {
        tip.textContent = text;
        place(el);
        tip.classList.add('is-shown');
      }, DELAY_MS);
    };

    const titled = (node: Element | null) => {
      const el = node?.closest<HTMLElement>('[title], [data-tip]') ?? null;
      return el && host.contains(el) ? el : null;
    };

    const track = (x: number, y: number) => {
      const el = titled(document.elementFromPoint(x, y));
      if (el === target) return;
      hide();
      if (el) show(el);
    };

    const onMove = (e: PointerEvent) => track(e.clientX, e.clientY);
    const onFocus = (e: FocusEvent) => {
      const el = titled(e.target as Element);
      if (el === target) return;
      hide();
      if (el && (e.target as HTMLElement).matches(':focus-visible')) show(el);
    };

    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerleave', hide);
    host.addEventListener('pointerdown', hide);
    host.addEventListener('focusin', onFocus);
    host.addEventListener('focusout', hide);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      hide();
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerleave', hide);
      host.removeEventListener('pointerdown', hide);
      host.removeEventListener('focusin', onFocus);
      host.removeEventListener('focusout', hide);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      tip.remove();
    };
  }, [host]);
}
