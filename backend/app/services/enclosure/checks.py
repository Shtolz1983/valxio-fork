"""Geometry and printability checks. Every problem comes back as a Violation with a human-readable hint."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from build123d import Axis, GeomType, Part, Vector

from .enclosure import LIP_HEIGHT, LIP_WIDTH, LID_FIT, Enclosure, Opening

COLLISION_VOLUME = 0.05  # mm3; below this a touching contact is not a collision
MAX_BRIDGE = 25.0  # longest horizontal bridge considered printable
MAX_ROUND_OVERHANG = 8.0  # horizontal holes up to this height print without supports
OVERHANG_NZ = -0.72  # face normal Z below this means steeper than ~45 deg from vertical


@dataclass
class Violation:
    severity: Literal["error", "warning"]
    check: str
    message: str

    def __str__(self) -> str:
        return f"[{self.severity}] {self.check}: {self.message}"


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
            out.append(Violation("error", "thickness", f"{label}={value} mm is below min_wall={spec.min_wall} mm"))
    return out


def check_collisions(enc: Enclosure) -> list[Violation]:
    out = []
    for part_name, part in (("base", enc.base), ("lid", enc.lid)):
        for ko_name, ko in enc.keepouts.items():
            v = _volume(part.intersect(ko))
            if v > COLLISION_VOLUME:
                out.append(Violation(
                    "error", "collision",
                    f"{part_name} intrudes {v:.1f} mm3 into {ko_name}; increase clearance/top_clearance or check board data",
                ))
    return out


def check_openings(enc: Enclosure) -> list[Violation]:
    lay, spec = enc.layout, enc.layout.spec
    lip_bottom = lay.z_top - LIP_HEIGHT
    out = []
    for o in enc.openings:
        lo, hi = lay.side_range(o.side)
        if o.along0 < lo or o.along1 > hi:
            out.append(Violation(
                "error", "opening", f"{o.name} on {o.side} runs past the inner corner (along {o.along0:.1f}..{o.along1:.1f}, cavity {lo:.1f}..{hi:.1f})",
            ))
        if o.z1 > lip_bottom:
            out.append(Violation(
                "error", "opening", f"{o.name} on {o.side} reaches the lid lip (top {o.z1:.1f} > {lip_bottom:.1f}); raise top_clearance",
            ))
        elif lay.z_top - o.z1 < spec.min_wall:
            out.append(Violation("error", "opening", f"{o.name} leaves under {spec.min_wall} mm of wall above it"))
        if o.z0 < lay.floor_top:
            out.append(Violation("warning", "opening", f"{o.name} on {o.side} cuts into the floor (bottom {o.z0:.1f} < {lay.floor_top:.1f})"))
    by_side: dict[str, list[Opening]] = {}
    for o in enc.openings:
        by_side.setdefault(o.side, []).append(o)
    for side, items in by_side.items():
        items.sort(key=lambda o: o.along0)
        for a, b in zip(items, items[1:]):
            overlap_z = a.z0 < b.z1 and b.z0 < a.z1
            if overlap_z and b.along0 - a.along1 < spec.min_wall:
                out.append(Violation("error", "opening", f"{a.name} and {b.name} on {side} are closer than {spec.min_wall} mm"))
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
            out.append(Violation("error", "opening", f"{e.name or e.shape} on {e.face} is outside the usable area"))
        for px, py in lay.posts:
            if abs(e.center_x - px) < hx + 3.5 and abs(e.center_y - py) < hy + 3.5:
                out.append(Violation("error", "opening", f"{e.name or e.shape} on {e.face} hits a lid screw post at ({px:.1f}, {py:.1f})"))
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
            out.append(Violation("error", "supports", f"no support under the board near ({x:.1f}, {y:.1f})"))
    return out


def flip_for_print(lid: Part) -> Part:
    """Lid upside down, top face on the bed at Z=0."""
    flipped = lid.rotate(Axis.X, 180)
    return flipped.translate((0, 0, -flipped.bounding_box().min.Z))


def check_bed(enc: Enclosure) -> list[Violation]:
    spec = enc.layout.spec
    bx, by, bz = spec.bed
    out = []
    for name, part in (("base", enc.base), ("lid", enc.lid)):
        size = part.bounding_box().size
        xy = sorted([size.X, size.Y])
        if xy[0] > min(bx, by) or xy[1] > max(bx, by) or size.Z > bz:
            out.append(Violation(
                "error", "bed", f"{name} {size.X:.0f}x{size.Y:.0f}x{size.Z:.0f} mm does not fit the bed {bx:.0f}x{by:.0f}x{bz:.0f}",
            ))
    return out


def _face_overhang(face, min_z: float) -> str | None:
    """Return a reason if this face needs supports in the given orientation, else None."""
    bb = face.bounding_box()
    if bb.max.Z - min_z < 0.05:
        return None  # on the bed
    if face.geom_type == GeomType.PLANE:
        nz = face.normal_at(face.center()).Z
        if nz > OVERHANG_NZ:
            return None
        if nz < -0.99:
            span = max(bb.size.X, bb.size.Y)
            return f"horizontal bridge {span:.1f} mm long" if span > MAX_BRIDGE else None
        return f"flat overhang at {bb.min.Z:.1f} mm"
    samples = [face.position_at(u, v) for u in (0.1, 0.3, 0.5, 0.7, 0.9) for v in (0.1, 0.5, 0.9)]
    if not any(face.normal_at(p).Z < OVERHANG_NZ for p in samples):
        return None
    if bb.size.Z <= MAX_ROUND_OVERHANG:
        return None
    return f"curved overhang {bb.size.Z:.1f} mm tall at {bb.min.Z:.1f} mm"


def check_overhangs(enc: Enclosure) -> list[Violation]:
    out = []
    for name, part in (("base", enc.base), ("lid", flip_for_print(enc.lid))):
        min_z = part.bounding_box().min.Z
        for face in part.faces():
            reason = _face_overhang(face, min_z)
            if reason:
                out.append(Violation("warning", "overhang", f"{name}: {reason} needs supports"))
    return out


ALL_CHECKS = (check_thickness, check_collisions, check_openings, check_top_extras, check_supports, check_bed, check_overhangs)


def run_checks(enc: Enclosure) -> list[Violation]:
    out: list[Violation] = []
    for check in ALL_CHECKS:
        out.extend(check(enc))
    return out
