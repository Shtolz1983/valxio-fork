"""Deterministic enclosure generator: EnclosureSpec -> base + lid.

World frame: board coordinates (see spec.py) with Z=0 at the bottom of the floor.
The base is printed as modelled (floor on the bed); the lid is exported flipped (top face on the bed).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from build123d import Box, Cylinder, Part, Pos, RectangleRounded, Rot, extrude

from .batteries import CATALOG as BATTERIES
from .connectors import ResolvedConnector, resolved_connectors
from .registry import get_board
from .spec import Board, EnclosureSpec, ExtraCutout

CONNECTOR_GAP = 0.5  # air between a connector face and the inner wall
POST_D = 6.5  # lid screw post
POST_PILOT_D = 2.5  # M3 self-tapping into plastic
POST_EMBED = 0.5  # how far a post sinks into the walls
LID_HOLE_D = 3.4  # M3 clearance
STANDOFF_D = 6.0
STANDOFF_PILOT_RATIO = 0.78  # self-tapping pilot / mounting hole: 2.5 for M3 (3.2 hole), 1.6 for M2
LIP_HEIGHT = 2.0
LIP_WIDTH = 1.6
LID_FIT = 0.2  # gap between lid lip and inner wall
SNAP_BUMP_R = 0.6
SNAP_GROOVE_R = 0.8
KEEPOUT_GAP = 0.5  # clearance kept around board and connectors when placing posts
BATTERY_FIT = 0.5  # air around a battery in its pocket
BATTERY_RIB = 1.6  # pocket wall thickness
BATTERY_RIB_MAX = 10.0  # pocket walls rise at most this high above the floor
PLA_DENSITY = 1.24  # g/cm3


@dataclass
class Opening:
    """A rectangular opening in a side wall, in side coordinates (along, z), used by checks and render."""

    name: str
    side: str
    along0: float
    along1: float
    z0: float
    z1: float


@dataclass
class Layout:
    board: Board
    spec: EnclosureSpec
    connectors: list[ResolvedConnector]
    windowed: list[ResolvedConnector]
    x0: float
    y0: float
    x1: float
    y1: float
    floor_top: float
    board_bottom: float
    pcb_top: float
    z_top: float
    lid_top: float
    top_height: float
    # Battery pocket (x0, y0, x1, y1): the battery plus BATTERY_FIT on every side, on the floor at one end.
    battery: tuple[float, float, float, float] | None = None
    posts: list[tuple[float, float]] = field(default_factory=list)

    def outer(self) -> tuple[float, float, float, float]:
        w = self.spec.wall
        return self.x0 - w, self.y0 - w, self.x1 + w, self.y1 + w

    def board_x_range(self) -> tuple[float, float]:
        """Cavity extent along X on the board's side of the battery divider."""
        x0, x1 = self.x0, self.x1
        if self.battery and self.spec.battery_side == "right":
            x1 = self.battery[0] - BATTERY_RIB
        elif self.battery:
            x0 = self.battery[2] + BATTERY_RIB
        return x0, x1

    def side_range(self, side: str) -> tuple[float, float]:
        """Cavity extent along a side's axis."""
        return (self.y0, self.y1) if side in ("left", "right") else (self.x0, self.x1)


@dataclass
class Enclosure:
    layout: Layout
    base: Part
    lid: Part
    openings: list[Opening]
    keepouts: dict[str, Part]
    board_parts: dict[str, Part]

    @property
    def weight_g(self) -> float:
        return (self.base.volume + self.lid.volume) / 1000 * PLA_DENSITY


def box(x0: float, y0: float, z0: float, x1: float, y1: float, z1: float) -> Part:
    return Pos((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2) * Box(x1 - x0, y1 - y0, z1 - z0)


def rounded_box(x0: float, y0: float, z0: float, x1: float, y1: float, z1: float, r: float) -> Part:
    r = min(r, (x1 - x0) / 2 - 0.01, (y1 - y0) / 2 - 0.01)
    if r <= 0.05:
        return box(x0, y0, z0, x1, y1, z1)
    sketch = Pos((x0 + x1) / 2, (y0 + y1) / 2, z0) * RectangleRounded(x1 - x0, y1 - y0, r)
    return extrude(sketch, amount=z1 - z0)


def cylinder_z(x: float, y: float, z0: float, z1: float, d: float) -> Part:
    return Pos(x, y, (z0 + z1) / 2) * Cylinder(d / 2, z1 - z0)


def _connector_rect(c: ResolvedConnector, board: Board) -> tuple[float, float, float, float]:
    """2D footprint (x0, y0, x1, y1) of a connector body in board coordinates."""
    L, W = board.size
    a0, a1 = c.center - c.width / 2, c.center + c.width / 2
    if c.side == "left":
        return -c.overhang, a0, c.depth - c.overhang, a1
    if c.side == "right":
        return L - c.depth + c.overhang, a0, L + c.overhang, a1
    if c.side == "front":
        return a0, -c.overhang, a1, c.depth - c.overhang
    return a0, W - c.depth + c.overhang, a1, W + c.overhang


def _circle_hits_rect(cx: float, cy: float, r: float, rect: tuple[float, float, float, float]) -> bool:
    x0, y0, x1, y1 = rect
    dx = max(x0 - cx, 0, cx - x1)
    dy = max(y0 - cy, 0, cy - y1)
    return dx * dx + dy * dy < r * r


def make_layout(spec: EnclosureSpec, board: Board | None = None) -> Layout:
    board = board or get_board(spec.board)
    L, W = board.size
    conns = resolved_connectors(board)
    skip = set(spec.skip_connectors)
    unknown = skip - {c.name for c in conns}
    if unknown:
        raise ValueError(f"skip_connectors: unknown names {sorted(unknown)}")

    def side_clearance(side: str) -> float:
        overhangs = [c.overhang for c in conns if c.side == side]
        return max([spec.clearance] + [o + CONNECTOR_GAP for o in overhangs])

    cl = {s: side_clearance(s) for s in ("left", "right", "front", "back")}
    bottom = spec.bottom_clearance if spec.bottom_clearance is not None else board.bottom_clearance
    floor_top = spec.floor
    board_bottom = floor_top + bottom
    pcb_top = board_bottom + board.pcb_thickness
    top_height = spec.top_height if spec.top_height is not None else board.top_height
    z_top = pcb_top + top_height + spec.top_clearance
    windowed = [c for c in conns if c.name not in skip]
    x0, y0, x1, y1 = -cl["left"], -cl["front"], L + cl["right"], W + cl["back"]
    battery = None
    if spec.battery:
        battery, x0, x1, y1 = _place_battery(spec, windowed, x0, y0, x1, y1)
        # the lid lip hangs LIP_HEIGHT into the cavity along the walls the pocket touches
        z_top = max(z_top, floor_top + BATTERIES[spec.battery].height + max(spec.top_clearance, LIP_HEIGHT + BATTERY_FIT))

    layout = Layout(
        board=board,
        spec=spec,
        connectors=conns,
        windowed=windowed,
        x0=x0,
        y0=y0,
        x1=x1,
        y1=y1,
        floor_top=floor_top,
        board_bottom=board_bottom,
        pcb_top=pcb_top,
        z_top=z_top,
        lid_top=z_top + spec.lid_thickness,
        top_height=top_height,
        battery=battery,
    )
    if spec.lid == "screw":
        _place_posts(layout)
    return layout


def _place_battery(
    spec: EnclosureSpec, windowed: list[ResolvedConnector], x0: float, y0: float, x1: float, y1: float,
) -> tuple[tuple[float, float, float, float], float, float, float]:
    """Battery pocket at one end of the case, behind a divider rib; returns the pocket and the grown cavity."""
    bat = BATTERIES[spec.battery]
    side = spec.battery_side
    blocked = [c.name for c in windowed if c.side == side]
    if blocked:
        other = "left" if side == "right" else "right"
        raise ValueError(f"a battery on the {side} would cover the {', '.join(blocked)} window; use battery_side={other}")

    def footprint(length: float, width: float) -> float:
        return (x1 - x0 + BATTERY_RIB + length + 2 * BATTERY_FIT) * (max(y1, y0 + width + 2 * BATTERY_FIT) - y0)

    # long edge along X or along Y, whichever keeps the case smaller
    length, width = min((bat.length, bat.width), (bat.width, bat.length), key=lambda lw: footprint(*lw))
    pl, pw = length + 2 * BATTERY_FIT, width + 2 * BATTERY_FIT
    grown_y1 = max(y1, y0 + pw)
    if grown_y1 > y1 and any(c.side == "back" for c in windowed):
        raise ValueError(f"battery {spec.battery} makes the case deeper than the board: the back connector windows would not reach the wall")
    if side == "right":
        px0 = x1 + BATTERY_RIB
        return (px0, y0, px0 + pl, y0 + pw), x0, px0 + pl, grown_y1
    px1 = x0 - BATTERY_RIB
    return (px1 - pl, y0, px1, y0 + pw), px1 - pl, x1, grown_y1


def _place_posts(layout: Layout) -> None:
    """Put lid screw posts in the cavity corners, widening the box along X until they clear the board."""
    board = layout.board
    L, W = board.size
    keepouts = [(-KEEPOUT_GAP, -KEEPOUT_GAP, L + KEEPOUT_GAP, W + KEEPOUT_GAP)]
    if layout.battery:
        keepouts.append(layout.battery)
    for c in layout.connectors:
        x0, y0, x1, y1 = _connector_rect(c, board)
        keepouts.append((x0 - KEEPOUT_GAP, y0 - KEEPOUT_GAP, x1 + KEEPOUT_GAP, y1 + KEEPOUT_GAP))
    r = POST_D / 2
    off = r - POST_EMBED
    for _ in range(200):
        corners = {
            "left": [(layout.x0 + off, layout.y0 + off), (layout.x0 + off, layout.y1 - off)],
            "right": [(layout.x1 - off, layout.y0 + off), (layout.x1 - off, layout.y1 - off)],
        }
        grow = [s for s, pts in corners.items() if any(_circle_hits_rect(x, y, r, k) for x, y in pts for k in keepouts)]
        if not grow:
            layout.posts = corners["left"] + corners["right"]
            return
        if "left" in grow:
            layout.x0 -= 0.5
        if "right" in grow:
            layout.x1 += 0.5
    raise RuntimeError("could not place lid screw posts")


def _side_cutter(layout: Layout, side: str, a0: float, a1: float, z0: float, z1: float) -> Part:
    """Box that cuts a rectangular opening through one side wall."""
    w = layout.spec.wall
    if side == "left":
        return box(layout.x0 - w - 1, a0, z0, layout.x0 + 0.2, a1, z1)
    if side == "right":
        return box(layout.x1 - 0.2, a0, z0, layout.x1 + w + 1, a1, z1)
    if side == "front":
        return box(a0, layout.y0 - w - 1, z0, a1, layout.y0 + 0.2, z1)
    return box(a0, layout.y1 - 0.2, z0, a1, layout.y1 + w + 1, z1)


def _side_circle_cutter(layout: Layout, side: str, along: float, z: float, d: float) -> Part:
    w = layout.spec.wall
    length = w + 2.4
    if side in ("left", "right"):
        x = layout.x0 - w / 2 if side == "left" else layout.x1 + w / 2
        return Pos(x, along, z) * Rot(0, 90, 0) * Cylinder(d / 2, length)
    y = layout.y0 - w / 2 if side == "front" else layout.y1 + w / 2
    return Pos(along, y, z) * Rot(90, 0, 0) * Cylinder(d / 2, length)


def _slot_centers(e: ExtraCutout, center: float) -> list[float]:
    start = center - (e.slot_count - 1) * e.slot_pitch / 2
    return [start + i * e.slot_pitch for i in range(e.slot_count)]


def _connector_openings(layout: Layout) -> list[Opening]:
    tol = layout.spec.connector_tolerance
    return [
        Opening(
            name=c.name,
            side=c.side,
            along0=c.center - c.width / 2 - tol,
            along1=c.center + c.width / 2 + tol,
            z0=layout.pcb_top + c.z - tol,
            z1=layout.pcb_top + c.z + c.height + tol,
        )
        for c in layout.windowed
    ]


def _extra_side_openings(layout: Layout) -> list[Opening]:
    """Bounding rectangles of side extras (circles included) so checks can treat them like windows."""
    out = []
    for e in layout.spec.extras:
        if e.face in ("top", "bottom"):
            continue
        zc = layout.pcb_top + e.z
        if e.shape == "circle":
            half_a = half_z = e.diameter / 2
        elif e.shape == "rect":
            half_a, half_z = e.width / 2, e.height / 2
        else:
            half_a = (e.slot_count - 1) * e.slot_pitch / 2 + e.width / 2
            half_z = e.height / 2
        out.append(Opening(e.name or f"{e.shape}@{e.face}", e.face, e.along - half_a, e.along + half_a, zc - half_z, zc + half_z))
    return out


def _flat_cutter(layout: Layout, e: ExtraCutout, z0: float, z1: float) -> Part:
    """Vertical cutter for top/bottom extras."""
    if e.shape == "circle":
        return cylinder_z(e.center_x, e.center_y, z0, z1, e.diameter)
    if e.shape == "rect":
        return box(e.center_x - e.width / 2, e.center_y - e.height / 2, z0, e.center_x + e.width / 2, e.center_y + e.height / 2, z1)
    cut = None
    for x in _slot_centers(e, e.center_x):
        slot = box(x - e.width / 2, e.center_y - e.height / 2, z0, x + e.width / 2, e.center_y + e.height / 2, z1)
        cut = slot if cut is None else cut + slot
    return cut


def _side_extra_cutter(layout: Layout, e: ExtraCutout) -> Part:
    zc = layout.pcb_top + e.z
    if e.shape == "circle":
        return _side_circle_cutter(layout, e.face, e.along, zc, e.diameter)
    if e.shape == "rect":
        return _side_cutter(layout, e.face, e.along - e.width / 2, e.along + e.width / 2, zc - e.height / 2, zc + e.height / 2)
    cut = None
    for a in _slot_centers(e, e.along):
        slot = _side_cutter(layout, e.face, a - e.width / 2, a + e.width / 2, zc - e.height / 2, zc + e.height / 2)
        cut = slot if cut is None else cut + slot
    return cut


def _snap_features(layout: Layout, r: float, y_offset: float) -> Part:
    """Horizontal cylinders along X on the front and back walls: bumps on the lid lip or grooves in the base."""
    length = min(12.0, (layout.x1 - layout.x0) / 3)
    xc = (layout.x0 + layout.x1) / 2
    z = layout.z_top - LIP_HEIGHT / 2
    front = Pos(xc, layout.y0 + y_offset, z) * Rot(0, 90, 0) * Cylinder(r, length)
    back = Pos(xc, layout.y1 - y_offset, z) * Rot(0, 90, 0) * Cylinder(r, length)
    return front + back


def build_base(layout: Layout) -> Part:
    spec, board = layout.spec, layout.board
    ox0, oy0, ox1, oy1 = layout.outer()
    base = rounded_box(ox0, oy0, 0, ox1, oy1, layout.z_top, spec.corner_radius)
    base -= rounded_box(layout.x0, layout.y0, layout.floor_top, layout.x1, layout.y1, layout.z_top + 1, spec.corner_radius - spec.wall)

    # board supports
    if board.mount == "standoffs":
        pilot_bottom = max(spec.min_wall, layout.board_bottom - 6.0)
        pilot_d = board.holes.diameter * STANDOFF_PILOT_RATIO
        for hx, hy in board.holes.positions:
            base += cylinder_z(hx, hy, layout.floor_top - 0.5, layout.board_bottom, STANDOFF_D)
            base -= cylinder_z(hx, hy, pilot_bottom, layout.board_bottom + 0.1, pilot_d)
    else:
        L, W = board.size
        d = board.support_depth
        bx0, bx1 = layout.board_x_range()
        base += box(bx0 - 0.1, 0, layout.floor_top - 0.5, d, W, layout.board_bottom)
        base += box(L - d, 0, layout.floor_top - 0.5, bx1 + 0.1, W, layout.board_bottom)

    if layout.battery:
        base += _battery_ribs(layout)

    # lid screw posts
    for px, py in layout.posts:
        base += cylinder_z(px, py, layout.floor_top - 0.5, layout.z_top, POST_D)
        base -= cylinder_z(px, py, max(layout.floor_top, layout.z_top - 10), layout.z_top + 0.1, POST_PILOT_D)

    if spec.lid == "snap":
        base -= _snap_features(layout, SNAP_GROOVE_R, 0)

    for o in _connector_openings(layout):
        base -= _side_cutter(layout, o.side, o.along0, o.along1, o.z0, o.z1)
    for e in spec.extras:
        if e.face == "bottom":
            base -= _flat_cutter(layout, e, -1, layout.floor_top + 0.01)
        elif e.face != "top":
            base -= _side_extra_cutter(layout, e)
    return base


def _battery_ribs(layout: Layout) -> Part:
    """Low walls around the battery pocket on every side that is not an outer wall."""
    px0, py0, px1, py1 = layout.battery
    t = BATTERY_RIB
    top = layout.floor_top + min(BATTERY_RIB_MAX, BATTERIES[layout.spec.battery].height * 0.6)
    ax0, ax1 = max(px0 - t, layout.x0 - 0.1), min(px1 + t, layout.x1 + 0.1)
    rects = []
    if px0 > layout.x0 + 0.01:
        rects.append((px0 - t, py0, px0, py1))
    if px1 < layout.x1 - 0.01:
        rects.append((px1, py0, px1 + t, py1))
    if py1 < layout.y1 - 0.01:
        rects.append((ax0, py1, ax1, py1 + t))
    if py0 > layout.y0 + 0.01:
        rects.append((ax0, py0 - t, ax1, py0))
    ribs = None
    for x0, y0, x1, y1 in rects:
        rib = box(x0, y0, layout.floor_top - 0.5, x1, y1, top)
        ribs = rib if ribs is None else ribs + rib
    return ribs


def battery_body(layout: Layout) -> Part:
    px0, py0, px1, py1 = layout.battery
    f = BATTERY_FIT
    return box(px0 + f, py0 + f, layout.floor_top, px1 - f, py1 - f, layout.floor_top + BATTERIES[layout.spec.battery].height)


def build_lid(layout: Layout) -> Part:
    spec = layout.spec
    ox0, oy0, ox1, oy1 = layout.outer()
    lid = rounded_box(ox0, oy0, layout.z_top, ox1, oy1, layout.lid_top, spec.corner_radius)

    r_in = spec.corner_radius - spec.wall - LID_FIT
    lip = rounded_box(
        layout.x0 + LID_FIT, layout.y0 + LID_FIT, layout.z_top - LIP_HEIGHT,
        layout.x1 - LID_FIT, layout.y1 - LID_FIT, layout.z_top + 0.01, r_in,
    )
    lip -= rounded_box(
        layout.x0 + LID_FIT + LIP_WIDTH, layout.y0 + LID_FIT + LIP_WIDTH, layout.z_top - LIP_HEIGHT - 1,
        layout.x1 - LID_FIT - LIP_WIDTH, layout.y1 - LID_FIT - LIP_WIDTH, layout.z_top + 0.02, r_in - LIP_WIDTH,
    )
    for px, py in layout.posts:
        lip -= cylinder_z(px, py, layout.z_top - LIP_HEIGHT - 1, layout.z_top + 0.02, POST_D + 0.6)
    lid += lip

    if spec.lid == "snap":
        lid += _snap_features(layout, SNAP_BUMP_R, LID_FIT)
    for px, py in layout.posts:
        lid -= cylinder_z(px, py, layout.z_top - LIP_HEIGHT - 1, layout.lid_top + 1, LID_HOLE_D)
    for e in spec.extras:
        if e.face == "top":
            lid -= _flat_cutter(layout, e, layout.z_top - LIP_HEIGHT - 1, layout.lid_top + 1)
    return lid


def build_board_parts(layout: Layout) -> dict[str, Part]:
    """Board ghost for rendering: PCB plus connector bodies, in world coordinates."""
    board = layout.board
    L, W = board.size
    pcb = box(0, 0, layout.board_bottom, L, W, layout.pcb_top)
    if board.holes:
        for hx, hy in board.holes.positions:
            pcb -= cylinder_z(hx, hy, layout.board_bottom - 1, layout.pcb_top + 1, board.holes.diameter)
    parts = {"pcb": pcb}
    for c in layout.connectors:
        x0, y0, x1, y1 = _connector_rect(c, board)
        parts[f"connector:{c.name}"] = box(x0, y0, layout.pcb_top + c.z, x1, y1, layout.pcb_top + c.z + c.height)
    if layout.battery:
        parts["battery"] = battery_body(layout)
    return parts


def build_keepouts(layout: Layout, board_parts: dict[str, Part]) -> dict[str, Part]:
    """Volumes the enclosure must not intrude into: PCB, connectors, component envelope above the board, battery."""
    L, W = layout.board.size
    keepouts = {"pcb": box(0, 0, layout.board_bottom, L, W, layout.pcb_top)}
    keepouts["components above board"] = box(0, 0, layout.pcb_top, L, W, layout.pcb_top + layout.top_height)
    keepouts.update({k: v for k, v in board_parts.items() if k.startswith("connector:") or k == "battery"})
    return keepouts


def build(spec: EnclosureSpec, board: Board | None = None) -> Enclosure:
    layout = make_layout(spec, board)
    board_parts = build_board_parts(layout)
    return Enclosure(
        layout=layout,
        base=build_base(layout),
        lid=build_lid(layout),
        openings=_connector_openings(layout) + _extra_side_openings(layout),
        keepouts=build_keepouts(layout, board_parts),
        board_parts=board_parts,
    )
