/**
 * The enclosure spec as the user can edit it in the dialog: the board (a
 * catalogue board or a prototype board) with the height of what is on it, the
 * battery compartment, the modules inside the case and the displays under the
 * lid (parts of the project that have a module table entry), the board's
 * connector windows (on / off), every extra opening — the part it is for (its
 * `name` is the part id the assistant gave it), the face, the shape, the sizes
 * and the position — and new openings the user adds. Edits stay a draft until
 * "Rebuild" sends the changed spec.
 *
 * Mounted with a key per build, so a new build (from the assistant or from a
 * rebuild) starts a fresh draft.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import registry from '../../services/ComponentRegistry';
import {
  localName,
  type EnclosureBuild,
  type EnclosureCatalog,
  type EnclosureExtra,
  type EnclosureFace,
  type EnclosureLidModuleSpec,
  type EnclosureModule,
  type EnclosureModuleSpec,
  type EnclosureSide,
  type EnclosureSpec,
  type EnclosureWallModuleSpec,
} from '../../services/enclosureService';
import { useSimulatorStore } from '../../store/useSimulatorStore';

type SizeKey = 'diameter' | 'width' | 'height' | 'slot_count' | 'slot_pitch';

const SIZE_FIELDS: Record<NonNullable<EnclosureExtra['shape']>, SizeKey[]> = {
  circle: ['diameter'],
  rect: ['width', 'height'],
  slots: ['width', 'height', 'slot_count', 'slot_pitch'],
};

const fmt = (v: number | null | undefined) => (v == null ? '—' : String(Math.round(v * 10) / 10));

type PosKey = 'along' | 'z' | 'center_x' | 'center_y';

const isFlat = (face: EnclosureFace) => face === 'top' || face === 'bottom';
/** Side walls place an opening along the wall and above the PCB top; the lid and the bottom by X and Y. */
const posFields = (face: EnclosureFace): PosKey[] => (isFlat(face) ? ['center_x', 'center_y'] : ['along', 'z']);

/** A new opening's sizes, by shape. */
const NEW_SIZES: Record<NonNullable<EnclosureExtra['shape']>, Partial<EnclosureExtra>> = {
  circle: { diameter: 6 },
  rect: { width: 10, height: 4 },
  slots: { width: 2, height: 8, slot_count: 5, slot_pitch: 4 },
};

const FACES: EnclosureFace[] = ['top', 'left', 'right', 'front', 'back', 'bottom'];

function extraValid(e: EnclosureExtra): boolean {
  const sized = SIZE_FIELDS[e.shape ?? 'circle'].every((k) => {
    const v = e[k];
    return typeof v === 'number' && Number.isFinite(v) && v > 0;
  });
  return sized && posFields(e.face).every((k) => typeof e[k] === 'number' && Number.isFinite(e[k]));
}

/** The part of the spec this editor changes. */
type Draft = Pick<
  EnclosureBuild['spec'],
  | 'board'
  | 'top_height'
  | 'side_clearance'
  | 'battery'
  | 'battery_side'
  | 'battery_hatch'
  | 'modules'
  | 'lid_modules'
  | 'wall_modules'
  | 'extras'
  | 'skip_connectors'
>;

const SIDES: EnclosureSide[] = ['left', 'right', 'front', 'back'];

const draftOf = (spec: EnclosureBuild['spec']): Draft => ({
  board: spec.board,
  top_height: spec.top_height,
  side_clearance: spec.side_clearance ?? {},
  battery: spec.battery,
  battery_side: spec.battery_side,
  battery_hatch: spec.battery_hatch,
  modules: spec.modules,
  lid_modules: spec.lid_modules,
  wall_modules: spec.wall_modules ?? [],
  extras: spec.extras,
  skip_connectors: [...spec.skip_connectors].sort(),
});

interface Props {
  build: EnclosureBuild;
  /** Boards and batteries to choose from; null while loading. */
  catalog: EnclosureCatalog | null;
  busy: boolean;
  onApply: (spec: EnclosureSpec) => void;
}

export function EnclosureEditor({ build, catalog, busy, onApply }: Props) {
  const { t, i18n } = useTranslation();
  const components = useSimulatorStore((s) => s.components);
  const [draft, setDraft] = useState<Draft>(() => draftOf(build.spec));
  const { extras, skip_connectors: skip } = draft;
  const change = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setExtras = (update: (list: EnclosureExtra[]) => EnclosureExtra[]) => setDraft((d) => ({ ...d, extras: update(d.extras) }));
  const setModules = (update: (list: EnclosureModuleSpec[]) => EnclosureModuleSpec[]) => setDraft((d) => ({ ...d, modules: update(d.modules) }));
  const setLidModules = (update: (list: EnclosureLidModuleSpec[]) => EnclosureLidModuleSpec[]) =>
    setDraft((d) => ({ ...d, lid_modules: update(d.lid_modules) }));
  const setWallModules = (update: (list: EnclosureWallModuleSpec[]) => EnclosureWallModuleSpec[]) =>
    setDraft((d) => ({ ...d, wall_modules: update(d.wall_modules) }));
  const patchWallModule = (name: string, patch: Partial<EnclosureWallModuleSpec>) =>
    setWallModules((list) => list.map((x) => (x.name === name ? { ...x, ...patch } : x)));
  const setSkip = (update: (names: string[]) => string[]) => setDraft((d) => ({ ...d, skip_connectors: update(d.skip_connectors).sort() }));
  // Connector windows belong to the built board; another board brings its own after a rebuild.
  const sameBoard = draft.board === build.spec.board;
  const boardDefaultHeight = catalog?.boards.find((b) => b.id === draft.board)?.top_height;

  const faceLabel = (face: EnclosureFace) =>
    ({
      top: t('enclosure.face.top', 'lid'),
      bottom: t('enclosure.face.bottom', 'bottom'),
      left: t('enclosure.face.left', 'left wall'),
      right: t('enclosure.face.right', 'right wall'),
      front: t('enclosure.face.front', 'front wall'),
      back: t('enclosure.face.back', 'back wall'),
    })[face];

  const sizeLabel: Record<SizeKey, string> = {
    diameter: t('enclosure.dim.diameter', '⌀'),
    width: t('enclosure.dim.width', 'width'),
    height: t('enclosure.dim.height', 'height'),
    slot_count: t('enclosure.dim.count', 'slots'),
    slot_pitch: t('enclosure.dim.pitch', 'pitch'),
  };

  /** "bme1 · BME280" when the opening or module is named after a part on the canvas. */
  const partLabel = (name: string | undefined) => {
    if (!name) return t('enclosure.unnamed', 'opening');
    const comp = components.find((c) => c.id === name);
    const type = comp && registry.getById(comp.metadataId)?.name;
    return type ? `${name} · ${type}` : name;
  };

  // Parts of the project with a module table entry, not yet in the case: displays (a window) go under
  // the lid or on a wall, the rest inside.
  const used = new Set([...draft.modules, ...draft.lid_modules, ...draft.wall_modules].map((m) => m.name));
  const candidates = (underLid: boolean): Array<{ part: string; module: EnclosureModule }> =>
    catalog
      ? components.flatMap((c) => {
          const module = catalog.modules.find((m) => m.part_types.includes(c.metadataId) && !!m.window === underLid);
          return module && !used.has(c.id) ? [{ part: c.id, module }] : [];
        })
      : [];
  const addable = candidates(false);
  const addableUnderLid = candidates(true);
  const displayModules = catalog?.modules.filter((m) => m.window) ?? [];
  // A wall with connector windows cannot move out for a display; a new one goes on the first wall without.
  const connectorWalls = new Set(sameBoard ? build.connectors.filter((c) => !skip.includes(c.name)).map((c) => c.side) : []);
  const freeWall = (['front', 'back', 'right', 'left'] as const).find((s) => !connectorWalls.has(s)) ?? 'front';
  const placedOf = (name: string) => (draft.board === build.spec.board ? build.modules.find((m) => m.name === name) : undefined);

  const posLabel: Record<PosKey, string> = {
    along: t('enclosure.pos.along', 'along'),
    z: t('enclosure.pos.z', 'height'),
    center_x: 'X',
    center_y: 'Y',
  };

  /** Where an opening fits on a face of the built case, for the position fields' hint. */
  const rangeOf = (face: EnclosureFace, key: PosKey): [number, number] | undefined => {
    const f = build.faces?.[face] as { along?: [number, number]; z?: [number, number]; x?: [number, number]; y?: [number, number] } | undefined;
    if (!f) return undefined;
    return key === 'center_x' ? f.x : key === 'center_y' ? f.y : f[key];
  };

  const setField = (i: number, key: SizeKey | PosKey, value: string) =>
    setExtras((list) => list.map((e, j) => (j === i ? { ...e, [key]: value === '' ? null : Number(value) } : e)));

  // A new opening: the chosen face and shape, a default size, in the middle of that face.
  const [newFace, setNewFace] = useState<EnclosureFace>('top');
  const [newShape, setNewShape] = useState<NonNullable<EnclosureExtra['shape']>>('circle');
  const addOpening = () => {
    const mid = (r: [number, number] | undefined) => (r ? Math.round(((r[0] + r[1]) / 2) * 10) / 10 : 0);
    const taken = new Set(extras.map((e) => e.name));
    let n = 1;
    while (taken.has(`hole${n}`)) n++;
    const position = isFlat(newFace)
      ? { center_x: mid(rangeOf(newFace, 'center_x')), center_y: mid(rangeOf(newFace, 'center_y')) }
      : { along: mid(rangeOf(newFace, 'along')), z: mid(rangeOf(newFace, 'z')) };
    setExtras((list) => [...list, { name: `hole${n}`, face: newFace, shape: newShape, ...NEW_SIZES[newShape], ...position }]);
  };

  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(build.spec));
  const setGap = (side: EnclosureSide, value: string) =>
    setDraft((d) => {
      const gaps = { ...d.side_clearance };
      if (value === '') delete gaps[side];
      else gaps[side] = Number(value);
      return { ...d, side_clearance: gaps };
    });
  const valid =
    extras.every(extraValid) &&
    (draft.top_height == null || draft.top_height > 0) &&
    Object.values(draft.side_clearance).every((v) => Number.isFinite(v) && v! >= 0);

  return (
    <div className="enc-openings">
      <div className="enc-section">{t('enclosure.boardAndPower', 'Board and power')}</div>
      {catalog && (
        <>
          <label className="enc-field">
            <span>{t('enclosure.board', 'Board')}</span>
            <select value={draft.board} onChange={(e) => change({ board: e.target.value, skip_connectors: [] })}>
              {catalog.boards.map((b) => (
                <option key={b.id} value={b.id}>
                  {localName(b, i18n.language)}
                </option>
              ))}
            </select>
          </label>
          <label className="enc-field">
            <span>{t('enclosure.partsHeight', 'Parts above the board')}</span>
            <span className="enc-size">
              <input
                type="number"
                min={0.5}
                step={0.5}
                value={draft.top_height ?? ''}
                placeholder={boardDefaultHeight == null ? '' : String(boardDefaultHeight)}
                onChange={(e) => change({ top_height: e.target.value === '' ? null : Number(e.target.value) })}
              />
              {t('enclosure.mm', 'mm')}
            </span>
          </label>
          <div className="enc-field enc-gaps" title={t('enclosure.gapsHint', 'Room between the board and each wall; empty is the usual gap. A wall with a connector keeps the connector at its window.')}>
            <span>
              {t('enclosure.gaps', 'Gap to the walls')}, {t('enclosure.mm', 'mm')}
            </span>
            <span className="enc-gap-grid">
              {SIDES.map((side) => (
                <label key={side} className="enc-size">
                  {t(`enclosure.gapSide.${side}`, side)}
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={draft.side_clearance[side] ?? ''}
                    placeholder={String(build.spec.clearance ?? 1)}
                    onChange={(e) => setGap(side, e.target.value)}
                  />
                </label>
              ))}
            </span>
          </div>
          <label className="enc-field">
            <span>{t('enclosure.battery', 'Battery')}</span>
            <select
              value={draft.battery ?? ''}
              // no battery, no hatch for it
              onChange={(e) => change(e.target.value ? { battery: e.target.value } : { battery: null, battery_hatch: false })}
            >
              <option value="">{t('enclosure.noBattery', 'none (USB or external supply)')}</option>
              {catalog.batteries.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.id} · {b.length} × {b.width} × {b.height} {t('enclosure.mm', 'mm')}
                </option>
              ))}
            </select>
          </label>
          {draft.battery && (
            <label className="enc-field">
              <span>{t('enclosure.batterySide', 'Battery at the')}</span>
              <select value={draft.battery_side} onChange={(e) => change({ battery_side: e.target.value as Draft['battery_side'] })}>
                <option value="right">{t('enclosure.sideRight', 'right end')}</option>
                <option value="left">{t('enclosure.sideLeft', 'left end')}</option>
              </select>
            </label>
          )}
          {draft.battery && (
            <label className="enc-control enc-control-row">
              <input type="checkbox" checked={draft.battery_hatch} onChange={(e) => change({ battery_hatch: e.target.checked })} />
              <span>{t('enclosure.batteryHatch', 'Hatch in the bottom to change it')}</span>
            </label>
          )}
        </>
      )}

      <div className="enc-section">{t('enclosure.inside', 'Inside the case')}</div>
      {draft.modules.map((m) => {
        const table = catalog?.modules.find((x) => x.id === m.type);
        const [l, w] = m.size ?? table?.size ?? [0, 0];
        const placed = placedOf(m.name);
        return (
          <div key={m.name} className="enc-opening">
            <span className="enc-opening-head">
              <strong>{partLabel(m.name)}</strong>
              <button
                className="enc-icon enc-opening-remove"
                onClick={() => setModules((list) => list.filter((x) => x.name !== m.name))}
                title={t('enclosure.removeModule', 'Take it out of the case')}
              >
                <Trash2 size={13} />
              </button>
            </span>
            <span className="enc-opening-sub">
              {table ? localName(table, i18n.language) : t('enclosure.ownSize', 'own size')} · {fmt(l)} × {fmt(w)} × {fmt(m.height ?? table?.top_height)} {t('enclosure.mm', 'mm')} ·{' '}
              {placed
                ? `X ${fmt(placed.x0)}, Y ${fmt(placed.y0)}${m.position ? '' : ` (${t('enclosure.auto', 'placed by the generator')})`}`
                : t('enclosure.placedAfterRebuild', 'placed after a rebuild')}
            </span>
          </div>
        );
      })}
      {draft.modules.length === 0 && <p className="enc-muted">{t('enclosure.noModules', 'Only the board.')}</p>}
      {addable.length > 0 && (
        <label className="enc-field">
          <span>{t('enclosure.addModule', 'Put inside')}</span>
          <select
            value=""
            onChange={(e) => {
              const pick = addable.find((a) => a.part === e.target.value);
              if (pick) setModules((list) => [...list, { name: pick.part, type: pick.module.id }]);
            }}
          >
            <option value="">{t('enclosure.choosePart', 'a part of the project…')}</option>
            {addable.map((a) => (
              <option key={a.part} value={a.part}>
                {partLabel(a.part)}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="enc-section">{t('enclosure.underLid', 'Under the lid')}</div>
      {draft.lid_modules.map((m) => {
        const table = catalog?.modules.find((x) => x.id === m.type);
        const placed = draft.board === build.spec.board ? build.lid_modules.find((x) => x.name === m.name) : undefined;
        return (
          <div key={m.name} className="enc-opening">
            <span className="enc-opening-head">
              <strong>{partLabel(m.name)}</strong>
              <button
                className="enc-icon enc-opening-remove"
                onClick={() => setLidModules((list) => list.filter((x) => x.name !== m.name))}
                title={t('enclosure.removeModule', 'Take it out of the case')}
              >
                <Trash2 size={13} />
              </button>
            </span>
            <span className="enc-opening-sub">
              {[
                table ? localName(table, i18n.language) : m.type,
                table?.window &&
                  t('enclosure.windowSize', 'window {{w}} × {{h}} mm', { w: fmt(table.window.size[0]), h: fmt(table.window.size[1]) }),
                placed
                  ? `X ${fmt(placed.x0)}, Y ${fmt(placed.y0)}${m.position ? '' : ` (${t('enclosure.auto', 'placed by the generator')})`}`
                  : t('enclosure.placedAfterRebuild', 'placed after a rebuild'),
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
        );
      })}
      {draft.lid_modules.length === 0 && <p className="enc-muted">{t('enclosure.noLidModules', 'No displays.')}</p>}
      {addableUnderLid.length > 0 && (
        <label className="enc-field">
          <span>{t('enclosure.addLidModule', 'Hang under the lid')}</span>
          <select
            value=""
            onChange={(e) => {
              const pick = addableUnderLid.find((a) => a.part === e.target.value);
              if (pick) setLidModules((list) => [...list, { name: pick.part, type: pick.module.id }]);
            }}
          >
            <option value="">{t('enclosure.chooseDisplay', 'a display of the project…')}</option>
            {addableUnderLid.map((a) => (
              <option key={a.part} value={a.part}>
                {partLabel(a.part)}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="enc-section">{t('enclosure.onWalls', 'On the walls')}</div>
      {draft.wall_modules.map((m) => {
        const table = catalog?.modules.find((x) => x.id === m.type);
        const placed = draft.board === build.spec.board ? build.wall_modules?.find((x) => x.name === m.name) : undefined;
        const num = (v: string) => (v === '' ? null : Number(v));
        return (
          <div key={m.name} className="enc-opening enc-wall-module">
            <span className="enc-opening-head">
              <strong>{partLabel(m.name)}</strong>
              <button
                className="enc-icon enc-opening-remove"
                onClick={() => setWallModules((list) => list.filter((x) => x.name !== m.name))}
                title={t('enclosure.removeModule', 'Take it out of the case')}
              >
                <Trash2 size={13} />
              </button>
            </span>
            <span className="enc-sizes">
              <select value={m.face} onChange={(e) => patchWallModule(m.name, { face: e.target.value as EnclosureSide })}>
                {SIDES.map((s) => (
                  <option key={s} value={s} disabled={connectorWalls.has(s)}>
                    {faceLabel(s)}
                  </option>
                ))}
              </select>
              <select value={m.type} onChange={(e) => patchWallModule(m.name, { type: e.target.value })}>
                {displayModules.map((d) => (
                  <option key={d.id} value={d.id}>
                    {localName(d, i18n.language)}
                  </option>
                ))}
              </select>
            </span>
            <span className="enc-sizes">
              <label className="enc-size">
                {posLabel.along}
                <input
                  type="number"
                  step={1}
                  value={m.along ?? ''}
                  placeholder={placed ? fmt(placed.window.along) : ''}
                  onChange={(e) => patchWallModule(m.name, { along: num(e.target.value) })}
                />
              </label>
              <label className="enc-size">
                {posLabel.z}
                <input
                  type="number"
                  step={1}
                  value={m.z ?? ''}
                  placeholder={placed ? fmt(placed.window.z) : ''}
                  onChange={(e) => patchWallModule(m.name, { z: num(e.target.value) })}
                />
              </label>
              {t('enclosure.mm', 'mm')}
            </span>
            <span className="enc-opening-sub">
              {[
                table?.window &&
                  t('enclosure.windowSize', 'window {{w}} × {{h}} mm', { w: fmt(table.window.size[0]), h: fmt(table.window.size[1]) }),
                placed
                  ? m.along == null || m.z == null
                    ? t('enclosure.auto', 'placed by the generator')
                    : null
                  : t('enclosure.placedAfterRebuild', 'placed after a rebuild'),
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
        );
      })}
      {draft.wall_modules.length === 0 && <p className="enc-muted">{t('enclosure.noWallModules', 'No displays on the walls.')}</p>}
      {addableUnderLid.length > 0 && (
        <label className="enc-field">
          <span>{t('enclosure.addWallModule', 'Stand against a wall')}</span>
          <select
            value=""
            onChange={(e) => {
              const pick = addableUnderLid.find((a) => a.part === e.target.value);
              if (pick) setWallModules((list) => [...list, { name: pick.part, type: pick.module.id, face: freeWall }]);
            }}
          >
            <option value="">{t('enclosure.chooseDisplay', 'a display of the project…')}</option>
            {addableUnderLid.map((a) => (
              <option key={a.part} value={a.part}>
                {partLabel(a.part)}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="enc-section">{t('enclosure.openings', 'Openings')}</div>
      {!sameBoard && <p className="enc-muted">{t('enclosure.connectorsAfterRebuild', 'The windows for the new board’s connectors appear after a rebuild.')}</p>}
      {sameBoard && build.connectors.map((c) => {
        const open = !skip.includes(c.name);
        return (
          <label key={`c:${c.name}`} className="enc-opening">
            <span className="enc-opening-head">
              <input
                type="checkbox"
                checked={open}
                onChange={(e) => setSkip((s) => (e.target.checked ? s.filter((n) => n !== c.name) : [...s, c.name]))}
              />
              <strong>{c.name}</strong>
            </span>
            <span className="enc-opening-sub">
              {c.type} · {faceLabel(c.side)} ·{' '}
              {open && c.window
                ? t('enclosure.window', 'window {{w}} × {{h}} mm', { w: fmt(c.window.width), h: fmt(c.window.height) })
                : open
                  ? t('enclosure.windowAfterRebuild', 'window after rebuild')
                  : t('enclosure.closed', 'no window')}
            </span>
          </label>
        );
      })}

      {extras.map((e, i) => (
        <div key={i} className="enc-opening">
          <span className="enc-opening-head">
            <strong>{partLabel(e.name)}</strong>
            <button
              className="enc-icon enc-opening-remove"
              onClick={() => setExtras((list) => list.filter((_, j) => j !== i))}
              title={t('enclosure.remove', 'Remove this opening')}
            >
              <Trash2 size={13} />
            </button>
          </span>
          <span className="enc-sizes">
            {SIZE_FIELDS[e.shape ?? 'circle'].map((key) => (
              <label key={key} className="enc-size">
                <span>{sizeLabel[key]}</span>
                <input
                  type="number"
                  min={key === 'slot_count' ? 1 : 0.5}
                  step={key === 'slot_count' ? 1 : 0.1}
                  value={e[key] ?? ''}
                  onChange={(ev) => setField(i, key, ev.target.value)}
                />
              </label>
            ))}
            <span className="enc-muted-inline">{t('enclosure.mm', 'mm')}</span>
          </span>
          <span className="enc-sizes">
            {posFields(e.face).map((key) => {
              const range = rangeOf(e.face, key);
              return (
                <label key={key} className="enc-size">
                  <span>{posLabel[key]}</span>
                  <input
                    type="number"
                    step={0.5}
                    value={e[key] ?? ''}
                    title={range ? t('enclosure.range', 'from {{lo}} to {{hi}} mm', { lo: fmt(range[0]), hi: fmt(range[1]) }) : undefined}
                    onChange={(ev) => setField(i, key, ev.target.value)}
                  />
                </label>
              );
            })}
          </span>
          <span className="enc-opening-sub">
            {faceLabel(e.face)} · {t(`enclosure.shape.${e.shape ?? 'circle'}`, e.shape ?? 'circle')}
          </span>
        </div>
      ))}

      {extras.length === 0 && (!sameBoard || build.connectors.length === 0) && <p className="enc-muted">{t('enclosure.noOpenings', 'No openings.')}</p>}

      <div className="enc-add-opening">
        <select value={newFace} onChange={(e) => setNewFace(e.target.value as EnclosureFace)} aria-label={t('enclosure.newFace', 'Face')}>
          {FACES.map((f) => (
            <option key={f} value={f}>
              {faceLabel(f)}
            </option>
          ))}
        </select>
        <select
          value={newShape}
          onChange={(e) => setNewShape(e.target.value as NonNullable<EnclosureExtra['shape']>)}
          aria-label={t('enclosure.newShape', 'Shape')}
        >
          {(['circle', 'rect', 'slots'] as const).map((shape) => (
            <option key={shape} value={shape}>
              {t(`enclosure.shape.${shape}`, shape)}
            </option>
          ))}
        </select>
        <button className="enc-btn" onClick={addOpening}>
          {t('enclosure.addOpening', 'Add an opening')}
        </button>
      </div>

      {dirty && (
        <div className="enc-openings-actions">
          <button
            className="enc-btn enc-btn-primary"
            disabled={!valid || busy}
            onClick={() => onApply({ ...build.spec, ...draft })}
          >
            {t('enclosure.rebuild', 'Rebuild')}
          </button>
          <button
            className="enc-btn"
            onClick={() => setDraft(draftOf(build.spec))}
          >
            {t('enclosure.reset', 'Undo changes')}
          </button>
          {!valid && <span className="enc-error">{t('enclosure.badSize', 'Every size must be above zero and every position filled in.')}</span>}
        </div>
      )}
    </div>
  );
}
