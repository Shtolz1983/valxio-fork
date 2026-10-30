"""Geometry and printability checks. Every problem comes back as a Violation with a human-readable hint.

The hint is English, for the AI assistant; `code` and `params` let the editor say the same in the user's language.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from build123d import Axis, GeomType, Part, Vector

from .batteries import CATALOG as BATTERIES
from .enclosure import EXTRA_CORNER_MARGIN, KEEPOUT_GAP, LID_MODULE_INSET, LIP_HEIGHT, LIP_WIDTH, LID_FIT, Enclosure, Opening, _connector_rect, _rects_overlap

COLLISION_VOLUME = 0.05  # mm3; below this a touching contact is not a collision
MAX_BRIDGE = 25.0  # longest horizontal bridge considered printable
MAX_ROUND_OVERHANG = 8.0  # horizontal holes up to this height print without supports
OVERHANG_NZ = -0.72  # face normal Z below this means steeper than ~45 deg from vertical


@dataclass
class Violation:
    severity: Literal["error", "warning"]
    check: str
    message: str
    code: str = ""  # one per kind of problem: the editor's translation key
    params: dict = field(default_factory=dict)  # what the message names, numbers rounded as shown

    def __str__(self) -> str:
        return f"[{self.severity}] {self.check}: {self.message}"


def _v(severity: Literal["error", "warning"], check: str, code: str, message: str, **params) -> Violation:
    rounded = {k: round(v, 1) if isinstance(v, float) else v for k, v in params.items()}
    return Violation(severity, check, message, code, rounded)


def _named(what: str) -> dict:
    """A keepout or obstacle ("connector:usb", "module rtc1", "the board", "pcb") as a kind and a name."""
    for kind in ("lid module", "connector", "module", "display"):  # "lid module" before "module"
        for sep in (":", " "):
            if what.startswith(kind + sep):
                return {"what_kind": kind, "what_name": what[len(kind) + 1:]}
    return {"what_kind": what.removeprefix("the "), "what_name": ""}


def _volume(shape) -> float:
    """Volume of an intersect() result, which may be None, a Shape or a ShapeList."""
    if shape is None:
        return 0.0
    if isinstance(shape, list):
        return sum(s.volume for s in shape)
    return shape.volume


def check_thickness(enc: Enclosure) -> list[Violation]:
    spec = enc.layout.spec
    out = []
    for label, value in (("wall", spec.wall), ("floor", spec.floor), ("lid_thickness", spec.lid_thickness)):
        if value < spec.min_wall:
            out.append(_v("error", "thickness", "thin", f"{label}={value} mm is below min_wall={spec.min_wall} mm",
                          what=label, value=float(value), min=float(spec.min_wall)))
    return out


def check_collisions(enc: Enclosure) -> list[Violation]:
    out = []
    for part_name, part in enc.printed_parts():
        for ko_name, ko in enc.keepouts.items():
            v = _volume(part.intersect(ko))
            if v > COLLISION_VOLUME:
                out.append(_v(
                    "error", "collision", "collision",
                    f"{part_name} intrudes {v:.1f} mm3 into {ko_name}; increase clearance/top_clearance or check board data",
                    part=part_name, volume=v, **_named(ko_name),
                ))
    return out


def check_openings(enc: Enclosure) -> list[Violation]:
    lay, spec = enc.layout, enc.layout.spec
    lip_bottom = lay.z_top - LIP_HEIGHT
    displays = {m.name for m in lay.wall_modules}  # check_wall_modules places them, cradle included
    out = []
    for o in enc.openings:
        lo, hi = lay.side_range(o.side)
        if o.name not in displays and (o.along0 < lo or o.along1 > hi):
            # the case grows by itself where it can (enclosure._grow_for_extras): what is left is a wall with a
            # connector window in the way, so say how far along the wall the opening has to move
            length = o.along1 - o.along0
            ends = ("left", "right") if o.side in ("front", "back") else ("front", "back")
            held = {c.side for c in lay.windowed}
            if all(end in held for end in ends) and length > hi - lo - 2 * EXTRA_CORNER_MARGIN:
                out.append(_v(
                    "error", "opening", "opening_too_long",
                    f"{o.name} on {o.side} is {length:.1f} mm long, the wall inside is {hi - lo:.1f} mm and cannot grow past a "
                    f"connector window; make it shorter or set side_clearance for that end",
                    name=o.name, side=o.side, length=length, wall=hi - lo,
                ))
            else:
                shift = lo + EXTRA_CORNER_MARGIN - o.along0 if o.along0 < lo else hi - EXTRA_CORNER_MARGIN - o.along1
                out.append(_v(
                    "error", "opening", "opening_corner",
                    f"{o.name} on {o.side} runs past the inner corner (along {o.along0:.1f}..{o.along1:.1f}, cavity {lo:.1f}..{hi:.1f}); "
                    f"move it {shift:+.1f} mm along the wall",
                    name=o.name, side=o.side, shift=shift,
                ))
        if o.z1 > lip_bottom:
            out.append(_v(
                "error", "opening", "opening_lip",
                f"{o.name} on {o.side} reaches the lid lip (top {o.z1:.1f} > {lip_bottom:.1f}); raise top_clearance",
                name=o.name, side=o.side,
            ))
        elif lay.z_top - o.z1 < spec.min_wall:
            out.append(_v("error", "opening", "opening_thin_top", f"{o.name} leaves under {spec.min_wall} mm of wall above it",
                          name=o.name, side=o.side, min=float(spec.min_wall)))
        if o.z0 < lay.floor_top:
            out.append(_v("warning", "opening", "opening_floor", f"{o.name} on {o.side} cuts into the floor (bottom {o.z0:.1f} < {lay.floor_top:.1f})",
                          name=o.name, side=o.side))
    by_side: dict[str, list[Opening]] = {}
    for o in enc.openings:
        by_side.setdefault(o.side, []).append(o)
    for side, items in by_side.items():
        items.sort(key=lambda o: o.along0)
        for a, b in zip(items, items[1:]):
            overlap_z = a.z0 < b.z1 and b.z0 < a.z1
            if overlap_z and b.along0 - a.along1 < spec.min_wall:
                out.append(_v("error", "opening", "openings_close", f"{a.name} and {b.name} on {side} are closer than {spec.min_wall} mm",
                              name=a.name, other=b.name, side=side, min=float(spec.min_wall)))
    return out


def check_top_extras(enc: Enclosure) -> list[Violation]:
    lay = enc.layout
    inset = LID_FIT + LIP_WIDTH
    out = []
    for e in lay.spec.extras:
        if e.face not in ("top", "bottom"):
            continue
        if e.shape == "circle":
            hx = hy = e.diameter / 2
        elif e.shape == "rect":
            hx, hy = e.width / 2, e.height / 2
        else:
            hx, hy = (e.slot_count - 1) * e.slot_pitch / 2 + e.width / 2, e.height / 2
        margin = inset if e.face == "top" else 0
        inside = (
            e.center_x - hx >= lay.x0 + margin and e.center_x + hx <= lay.x1 - margin
            and e.center_y - hy >= lay.y0 + margin and e.center_y + hy <= lay.y1 - margin
        )
        if not inside:
            out.append(_v("error", "opening", "extra_outside", f"{e.name or e.shape} on {e.face} is outside the usable area",
                          name=e.name or e.shape, side=e.face))
        for px, py in lay.posts:
            if abs(e.center_x - px) < hx + 3.5 and abs(e.center_y - py) < hy + 3.5:
                out.append(_v("error", "opening", "extra_post", f"{e.name or e.shape} on {e.face} hits a lid screw post at ({px:.1f}, {py:.1f})",
                              name=e.name or e.shape, side=e.face, x=px, y=py))
    return out


def check_supports(enc: Enclosure) -> list[Violation]:
    """Something solid must sit right under the PCB at every mounting point."""
    lay, board = enc.layout, enc.layout.board
    z = lay.board_bottom - 0.3
    if board.mount == "standoffs":
        points = [(hx + 2.0, hy) for hx, hy in board.holes.positions]
    else:
        L, W = board.size
        d = board.support_depth
        points = [(d / 2, W / 2), (L - d / 2, W / 2)]
    out = []
    for x, y in points:
        if not enc.base.is_inside(Vector(x, y, z)):
            out.append(_v("error", "supports", "no_support", f"no support under the board near ({x:.1f}, {y:.1f})", x=x, y=y))
    for m in lay.modules:
        z = m.bottom - 0.3
        if m.module.mount == "standoffs":
            mpoints = [(hx + 2.0, hy) for hx, hy in m.holes()]
        else:
            d = m.module.support_depth
            cx, cy = (m.x0 + m.x1) / 2, (m.y0 + m.y1) / 2
            mpoints = [(cx, m.y0 + d / 2), (cx, m.y1 - d / 2)] if m.rotated else [(m.x0 + d / 2, cy), (m.x1 - d / 2, cy)]
        for x, y in mpoints:
            if not enc.base.is_inside(Vector(x, y, z)):
                out.append(_v("error", "supports", "no_support_module", f"no support under module {m.name} near ({x:.1f}, {y:.1f})",
                              name=m.name, x=x, y=y))
    for m in lay.lid_modules:
        for hx, hy in m.holes():
            if not enc.lid.is_inside(Vector(hx + 2.0, hy, m.pcb_top + 0.3)):
                out.append(_v("error", "supports", "no_lid_post", f"no lid post above display {m.name} near ({hx:.1f}, {hy:.1f})",
                              name=m.name, x=hx, y=hy))
    return out


def check_modules(enc: Enclosure) -> list[Violation]:
    """Modules stay inside the cavity and clear of the board, its connectors, the battery and each other."""
    lay = enc.layout
    L, W = lay.board.size
    g = KEEPOUT_GAP
    taken = [("the board", (-g, -g, L + g, W + g))]
    taken += [(f"connector {c.name}", _connector_rect(c, lay.board)) for c in lay.connectors]
    if lay.battery:
        taken.append(("the battery", lay.battery))
    out = []
    for m in lay.modules:
        if m.x0 < lay.x0 or m.y0 < lay.y0 or m.x1 > lay.x1 or m.y1 > lay.y1:
            out.append(_v("error", "module", "module_outside",
                          f"module {m.name} is outside the cavity (X {lay.x0:.1f}..{lay.x1:.1f}, Y {lay.y0:.1f}..{lay.y1:.1f})", name=m.name))
        for what, rect in taken:
            if _rects_overlap(m.rect(), rect):
                out.append(_v("error", "module", "module_overlap", f"module {m.name} overlaps {what}", name=m.name, **_named(what)))
        taken.append((f"module {m.name}", m.rect()))
    return out


def flip_for_print(lid: Part) -> Part:
    """Lid upside down, top face on the bed at Z=0."""
    flipped = lid.rotate(Axis.X, 180)
    return flipped.translate((0, 0, -flipped.bounding_box().min.Z))


def check_bed(enc: Enclosure) -> list[Violation]:
    spec = enc.layout.spec
    bx, by, bz = spec.bed
    out = []
    for name, part in enc.printed_parts():
        size = part.bounding_box().size
        xy = sorted([size.X, size.Y])
        if xy[0] > min(bx, by) or xy[1] > max(bx, by) or size.Z > bz:
            out.append(_v(
                "error", "bed", "bed", f"{name} {size.X:.0f}x{size.Y:.0f}x{size.Z:.0f} mm does not fit the bed {bx:.0f}x{by:.0f}x{bz:.0f}",
                part=name, size=f"{size.X:.0f} × {size.Y:.0f} × {size.Z:.0f}", bed=f"{bx:.0f} × {by:.0f} × {bz:.0f}",
            ))
    return out


def _face_overhang(face, min_z: float) -> tuple[str, str, dict] | None:
    """(code, reason, params) if this face needs supports in the given orientation, else None."""
    bb = face.bounding_box()
    if bb.max.Z - min_z < 0.05:
        return None  # on the bed
    if face.geom_type == GeomType.PLANE:
        nz = face.normal_at(face.center()).Z
        if nz > OVERHANG_NZ:
            return None
        if nz < -0.99:
            span = max(bb.size.X, bb.size.Y)
            return ("overhang_bridge", f"horizontal bridge {span:.1f} mm long", {"span": span}) if span > MAX_BRIDGE else None
        return "overhang_flat", f"flat overhang at {bb.min.Z:.1f} mm", {"z": bb.min.Z}
    samples = [face.position_at(u, v) for u in (0.1, 0.3, 0.5, 0.7, 0.9) for v in (0.1, 0.5, 0.9)]
    if not any(face.normal_at(p).Z < OVERHANG_NZ for p in samples):
        return None
    if bb.size.Z <= MAX_ROUND_OVERHANG:
        return None
    return "overhang_curved", f"curved overhang {bb.size.Z:.1f} mm tall at {bb.min.Z:.1f} mm", {"height": bb.size.Z, "z": bb.min.Z}


def check_overhangs(enc: Enclosure) -> list[Violation]:
    out = []
    parts = [(name, flip_for_print(p) if name == "lid" else p) for name, p in enc.printed_parts()]
    for name, part in parts:
        min_z = part.bounding_box().min.Z
        for face in part.faces():
            found = _face_overhang(face, min_z)
            if found:
                code, reason, params = found
                out.append(_v("warning", "overhang", code, f"{name}: {reason} needs supports", part=name, **params))
    return out


def check_hatch(enc: Enclosure) -> list[Violation]:
    """The battery hatch fills its opening without overlapping the base, and the bosses for its screws are there."""
    if not enc.hatch:
        return []
    out = []
    v = _volume(enc.hatch.intersect(enc.base))
    if v > COLLISION_VOLUME:
        out.append(_v("error", "hatch", "hatch_overlap", f"the battery hatch overlaps the base by {v:.1f} mm3", volume=v))
    lay = enc.layout
    for bx, by in lay.hatch_bosses():
        if not enc.base.is_inside(Vector(bx + 2.0, by, lay.floor_top + 0.5)):
            out.append(_v("error", "hatch", "hatch_no_boss", f"no screw boss for the battery hatch near ({bx:.1f}, {by:.1f})", x=bx, y=by))
    return out


def check_lid_modules(enc: Enclosure) -> list[Violation]:
    """Displays under the lid stay inside its lip, off each other, and above what is below.

    The corner screw posts make way for them when they are placed (enclosure._place_posts)."""
    lay = enc.layout
    L, W = lay.board.size
    i = LID_MODULE_INSET - 1e-6  # a case grown to fit a display puts it exactly at the inset
    below = [("the board", (0.0, 0.0, L, W), lay.pcb_top + lay.top_height)]
    below += [(f"module {m.name}", m.rect(), m.top) for m in lay.modules]
    if lay.battery:
        below.append(("the battery", lay.battery, lay.floor_top + BATTERIES[lay.spec.battery].height))
    out = []
    seen: list[tuple[str, tuple[float, float, float, float]]] = []
    for m in lay.lid_modules:
        if m.x0 < lay.x0 + i or m.y0 < lay.y0 + i or m.x1 > lay.x1 - i or m.y1 > lay.y1 - i:
            out.append(_v("error", "lid module", "display_lip", f"display {m.name} reaches under the lid's lip; move it inwards", name=m.name))
        for what, rect, top in below:
            if _rects_overlap(m.rect(), rect) and m.lowest < top:
                out.append(_v("error", "lid module", "display_hangs",
                              f"display {m.name} hangs into {what} ({m.lowest:.1f} < {top:.1f}); raise top_clearance",
                              name=m.name, **_named(what)))
        for what, rect in seen:
            if _rects_overlap(m.rect(), rect):
                out.append(_v("error", "lid module", "display_overlap", f"display {m.name} overlaps {what}", name=m.name, **_named(what)))
        seen.append((f"display {m.name}", m.rect()))
    return out


def check_wall_modules(enc: Enclosure) -> list[Violation]:
    """Displays on the side walls: inside the wall with their cradles, above the floor, off each other, and not
    standing in front of another opening."""
    lay = enc.layout
    out = []
    for i, m in enumerate(lay.wall_modules):
        lo, hi = lay.side_range(m.side)
        s0, s1 = m.span()
        if s0 < lo - 1e-6 or s1 > hi + 1e-6:
            shift = lo - s0 if s0 < lo else hi - s1
            out.append(_v(
                "error", "wall module", "wall_display_corner",
                f"display {m.name} on the {m.side} wall runs past the inner corner with its cradle; move it {shift:+.1f} mm along the wall",
                name=m.name, side=m.side, shift=shift,
            ))
        if m.z0 < lay.floor_top + 0.5:
            out.append(_v("error", "wall module", "wall_display_low",
                          f"display {m.name} on the {m.side} wall reaches the floor (bottom {m.z0:.1f} < {lay.floor_top + 0.5:.1f}); raise its z",
                          name=m.name, side=m.side))
        for other in lay.wall_modules[:i]:
            o0, o1 = other.span()
            if other.side == m.side and s0 < o1 and o0 < s1 and m.z0 < other.z1 and other.z0 < m.z1:
                out.append(_v("error", "wall module", "wall_display_overlap", f"display {m.name} overlaps display {other.name}",
                              name=m.name, what_kind="display", what_name=other.name))
        for o in enc.openings:
            if o.side == m.side and o.name != m.name and o.along0 < m.a1 and m.a0 < o.along1 and o.z0 < m.z1 and m.z0 < o.z1:
                out.append(_v("error", "wall module", "wall_display_covers",
                              f"display {m.name} stands in front of {o.name} on the {m.side} wall; move one of them",
                              name=m.name, other=o.name, side=m.side))
    return out


ALL_CHECKS = (
    check_thickness, check_collisions, check_openings, check_top_extras, check_supports, check_modules, check_lid_modules,
    check_wall_modules, check_hatch, check_bed, check_overhangs,
)


def run_checks(enc: Enclosure) -> list[Violation]:
    out: list[Violation] = []
    for check in ALL_CHECKS:
        out.extend(check(enc))
    return out
