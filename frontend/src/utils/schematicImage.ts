/**
 * "Schematic image (PNG)": the circuit on the canvas as a picture, taken in
 * the browser from the live canvas — whatever the zoom and pan, the image
 * holds every board, part and wire at 2× scale with a margin around them,
 * on the canvas's own background (so it matches the light or dark theme).
 *
 * The parts are Web Components drawing into shadow DOM; modern-screenshot
 * clones those too, which a plain SVG serialisation of the page would miss.
 */
import { domToBlob } from 'modern-screenshot';

const MARGIN = 24;

/**
 * Canvas UI that is not part of the circuit: the boards' control rows, wire
 * drag handles, and what carries data-canvas-ui (the selected board's ring,
 * its run-state dot, the SPICE summary and voltage labels).
 */
const NOT_CIRCUIT = ['board-docks-layer'];

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Bounds of the circuit in world (unzoomed) pixels, or null when the canvas is empty. */
function circuitBounds(world: HTMLElement, ids: string[]): Box | null {
  const wr = world.getBoundingClientRect();
  const zoom = wr.width / world.offsetWidth || 1;
  const box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const take = (r: DOMRect) => {
    if (!r.width && !r.height) return;
    box.minX = Math.min(box.minX, (r.left - wr.left) / zoom);
    box.minY = Math.min(box.minY, (r.top - wr.top) / zoom);
    box.maxX = Math.max(box.maxX, (r.right - wr.left) / zoom);
    box.maxY = Math.max(box.maxY, (r.bottom - wr.top) / zoom);
  };
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el || !world.contains(el)) continue;
    take(el.getBoundingClientRect());
    // A part's drawing can overflow its host element (the DHT22's pins do).
    const drawing = el.shadowRoot?.querySelector('svg');
    if (drawing) take(drawing.getBoundingClientRect());
  }
  world.querySelectorAll('.wire-layer > g, .wire-layer > path').forEach((w) => take(w.getBoundingClientRect()));
  return box.minX === Infinity ? null : box;
}

function isCircuit(node: Node): boolean {
  if (!(node instanceof Element)) return true;
  if (node.hasAttribute('data-wire-handle') || node.hasAttribute('data-canvas-ui')) return false;
  return !NOT_CIRCUIT.some((c) => node.classList.contains(c));
}

/**
 * The PNG of the circuit drawn inside `world` (the canvas's pan/zoom layer);
 * `ids` are the boards' and parts' element ids. Null when there is nothing on it.
 */
export async function captureSchematic(world: HTMLElement, ids: string[]): Promise<Blob | null> {
  const b = circuitBounds(world, ids);
  if (!b) return null;
  const width = Math.ceil(b.maxX - b.minX + 2 * MARGIN);
  const height = Math.ceil(b.maxY - b.minY + 2 * MARGIN);
  const background = getComputedStyle(world.parentElement ?? world).backgroundColor;
  return domToBlob(world, {
    width,
    height,
    scale: 2,
    backgroundColor: background && background !== 'rgba(0, 0, 0, 0)' ? background : null,
    // The clone drops the user's pan and zoom and moves the circuit to the top-left corner.
    style: { transform: `translate(${MARGIN - b.minX}px, ${MARGIN - b.minY}px)`, width: `${width}px`, height: `${height}px` },
    filter: isCircuit,
    type: 'image/png',
  });
}
