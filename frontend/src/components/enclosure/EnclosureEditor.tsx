/**
 * The enclosure spec as the user can edit it in the dialog: the board (a
 * catalogue board or a prototype board) with the height of what is on it, the
 * battery compartment, the modules inside the case (parts of the project that
 * have a module table entry), the board's connector windows (on / off) and every
 * extra opening — the part it is for (its `name` is the part id the assistant
 * gave it), the face, the shape and the sizes. Edits stay a draft until
 * "Rebuild" sends the changed spec.
 *
 * Mounted with a key per build, so a new build (from the assistant or from a
 * rebuild) starts a fresh draft.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import registry from '../../services/ComponentRegistry';
import type {
  EnclosureBuild,
  EnclosureCatalog,
  EnclosureExtra,
  EnclosureFace,
  EnclosureModuleSpec,
  EnclosureSpec,
} from '../../services/enclosureService';
import { useSimulatorStore } from '../../store/useSimulatorStore';

type SizeKey = 'diameter' | 'width' | 'height' | 'slot_count' | 'slot_pitch';

const SIZE_FIELDS: Record<NonNullable<EnclosureExtra['shape']>, SizeKey[]> = {
  circle: ['diameter'],
  rect: ['width', 'height'],
  slots: ['width', 'height', 'slot_count', 'slot_pitch'],
};

const fmt = (v: number | null | undefined) => (v == null ? '—' : String(Math.round(v * 10) / 10));

function sizesValid(e: EnclosureExtra): boolean {
  return SIZE_FIELDS[e.shape ?? 'circle'].every((k) => {
    const v = e[k];
    return typeof v === 'number' && Number.isFinite(v) && v > 0;
  });
}

/** The part of the spec this editor changes. */
type Draft = Pick<EnclosureBuild['spec'], 'board' | 'top_height' | 'battery' | 'battery_side' | 'modules' | 'extras' | 'skip_connectors'>;

const draftOf = (spec: EnclosureBuild['spec']): Draft => ({
  board: spec.board,
  top_height: spec.top_height,
  battery: spec.battery,
  battery_side: spec.battery_side,
  modules: spec.modules,
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
  const { t } = useTranslation();
  const components = useSimulatorStore((s) => s.components);
  const [draft, setDraft] = useState<Draft>(() => draftOf(build.spec));
  const { extras, skip_connectors: skip } = draft;
  const change = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setExtras = (update: (list: EnclosureExtra[]) => EnclosureExtra[]) => setDraft((d) => ({ ...d, extras: update(d.extras) }));
  const setModules = (update: (list: EnclosureModuleSpec[]) => EnclosureModuleSpec[]) => setDraft((d) => ({ ...d, modules: update(d.modules) }));
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

  // Parts of the project that can go inside: a module table entry exists for their type, not yet added.
  const addable = catalog
    ? components.flatMap((c) => {
        const module = catalog.modules.find((m) => m.part_types.includes(c.metadataId));
        return module && !draft.modules.some((m) => m.name === c.id) ? [{ part: c.id, module }] : [];
      })
    : [];
  const placedOf = (name: string) => (draft.board === build.spec.board ? build.modules.find((m) => m.name === name) : undefined);

  const position = (e: EnclosureExtra) =>
    e.face === 'top' || e.face === 'bottom'
      ? `X ${fmt(e.center_x)}, Y ${fmt(e.center_y)}`
      : t('enclosure.sidePosition', 'along {{along}}, {{z}} above the board', { along: fmt(e.along), z: fmt(e.z) });

  const setSize = (i: number, key: SizeKey, value: string) =>
    setExtras((list) => list.map((e, j) => (j === i ? { ...e, [key]: value === '' ? null : Number(value) } : e)));

  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(build.spec));
  const valid = extras.every(sizesValid) && (draft.top_height == null || draft.top_height > 0);

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
                  {b.name}
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
          <label className="enc-field">
            <span>{t('enclosure.battery', 'Battery')}</span>
            <select value={draft.battery ?? ''} onChange={(e) => change({ battery: e.target.value || null })}>
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
              {table?.name ?? t('enclosure.ownSize', 'own size')} · {fmt(l)} × {fmt(w)} × {fmt(m.height ?? table?.top_height)} {t('enclosure.mm', 'mm')} ·{' '}
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
                  onChange={(ev) => setSize(i, key, ev.target.value)}
                />
              </label>
            ))}
            <span className="enc-muted-inline">{t('enclosure.mm', 'mm')}</span>
          </span>
          <span className="enc-opening-sub">
            {faceLabel(e.face)} · {t(`enclosure.shape.${e.shape ?? 'circle'}`, e.shape ?? 'circle')} · {position(e)}
          </span>
        </div>
      ))}

      {extras.length === 0 && (!sameBoard || build.connectors.length === 0) && <p className="enc-muted">{t('enclosure.noOpenings', 'No openings.')}</p>}

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
          {!valid && <span className="enc-error">{t('enclosure.badSize', 'Every size must be above zero.')}</span>}
        </div>
      )}
    </div>
  );
}
