"""Deterministic enclosure generator: EnclosureSpec -> base + lid.

World frame: board coordinates (see spec.py) with Z=0 at the bottom of the floor.
The base is printed as modelled (floor on the bed); the lid is exported flipped (top face on the bed).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from build123d import Box, Cylinder, Part, Pos, Rectangle, RectangleRounded, Rot, extrude

from .batteries import CATALOG as BATTERIES
from .connectors import ResolvedConnector, resolved_connectors
from .registry import get_board, get_module
from .spec import Board, EnclosureSpec, ExtraCutout, InsideModule, LidModule

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
EXTRA_CORNER_MARGIN = 1.5  # a side opening the case grows for keeps this far from the inner corner
BATTERY_FIT = 0.5  # air around a battery in its pocket
BATTERY_RIB = 1.6  # pocket wall thickness
BATTERY_RIB_MAX = 10.0  # pocket walls rise at most this high above the floor
# Battery hatch: the floor under the battery opens (tapered 45 degrees, so it prints without supports and the
# hatch cannot fall in); two M3 screws hold the hatch by its ears in bosses at both ends of the pocket.
HATCH_BOSS_ZONE = 8.0  # the pocket grows by this at both ends to stand the bosses
HATCH_BOSS_D = 7.0
HATCH_EAR_W = 10.0
HATCH_EAR_T = 1.2  # the ears sit in a recess this deep in the floor's underside
HATCH_FIT = 0.2
MODULE_GAP = 2.0  # air around a module inside the case: to the board, other modules, walls
GENERIC_MODULE_HEIGHT = 10.0  # a module given only by its size
LID_MODULE_INSET = LID_FIT + LIP_WIDTH + 0.5  # a display under the lid stays inside the lid's lip
LID_POST_WALL = 1.5  # plastic around a display's screw in its lid post: M2 holes get thinner posts than STANDOFF_D
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
class PlacedModule:
    """A module inside the case: its PCB footprint (x0, y0, x1, y1) and heights, in world coordinates."""

    name: str
    module: Board
    x0: float
    y0: float
    x1: float
    y1: float
    rotated: bool  # turned 90 degrees: its length runs along Y
    bottom: float  # PCB underside
    pcb_top: float
    top: float  # tallest part

    @property
    def lowest(self) -> float:
        """Underside of what hangs below the PCB (header, backpack)."""
        return self.bottom - self.module.bottom_clearance

    def window_rect(self) -> tuple[float, float, float, float]:
        """A display's visible area in world coordinates."""
        (cx, cy), (w, h) = self.module.window.center, self.module.window.size
        return self.x0 + cx - w / 2, self.y0 + cy - h / 2, self.x0 + cx + w / 2, self.y0 + cy + h / 2

    def holes(self) -> list[tuple[float, float]]:
        if not self.module.holes:
            return []
        w = self.module.size[1]
        if self.rotated:
            return [(self.x0 + w - hy, self.y0 + hx) for hx, hy in self.module.holes.positions]
        return [(self.x0 + hx, self.y0 + hy) for hx, hy in self.module.holes.positions]

    def rect(self) -> tuple[float, float, float, float]:
        return self.x0, self.y0, self.x1, self.y1


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
    modules: list[PlacedModule] = field(default_factory=list)
    # Displays hung under the lid: `top` is the lid's underside, `bottom` their PCB underside.
    lid_modules: list[PlacedModule] = field(default_factory=list)
    posts: list[tuple[float, float]] = field(default_factory=list)

    def outer(self) -> tuple[float, float, float, float]:
        w = self.spec.wall
        return self.x0 - w, self.y0 - w, self.x1 + w, self.y1 + w

    def battery_rect(self) -> tuple[float, float, float, float]:
        """The battery's footprint inside its pocket (the pocket less the fit and, with a hatch, the boss zones)."""
        px0, py0, px1, py1 = self.battery
        f, z = BATTERY_FIT, HATCH_BOSS_ZONE if self.spec.battery_hatch else 0.0
        return px0 + f + z, py0 + f, px1 - f - z, py1 - f

    def hatch_bosses(self) -> list[tuple[float, float]]:
        px0, py0, px1, py1 = self.battery
        cy = (py0 + py1) / 2
        return [(px0 + HATCH_BOSS_ZONE / 2, cy), (px1 - HATCH_BOSS_ZONE / 2, cy)]

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
    lid_parts: dict[str, Part] = field(default_factory=dict)  # what hangs under the lid, moves with it
    hatch: Part | None = None  # the battery hatch, a third printed part

    @property
    def weight_g(self) -> float:
        hatch = self.hatch.volume if self.hatch else 0.0
        return (self.base.volume + self.lid.volume + hatch) / 1000 * PLA_DENSITY

    def printed_parts(self) -> list[tuple[str, Part]]:
        """Every part that gets printed, in assembly position."""
        return [("base", self.base), ("lid", self.lid)] + ([("hatch", self.hatch)] if self.hatch else [])


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


def _rects_overlap(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


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
        return max([spec.side_clearance.get(side, spec.clearance)] + [o + CONNECTOR_GAP for o in overhangs])

    cl = {s: side_clearance(s) for s in ("left", "right", "front", "back")}
    bottom = spec.bottom_clearance if spec.bottom_clearance is not None else board.bottom_clearance
    floor_top = spec.floor
    board_bottom = floor_top + bottom
    pcb_top = board_bottom + board.pcb_thickness
    top_height = spec.top_height if spec.top_height is not None else board.top_height
    z_top = pcb_top + top_height + spec.top_clearance
    windowed = [c for c in conns if c.name not in skip]
    y0 = -cl["front"]
    bx0, bx1 = -cl["left"], L + cl["right"]  # the board's compartment along X, before a battery pocket joins it

    def arrange(battery_along_x: bool | None):
        """Battery, modules, displays; returns them with the grown cavity (x0, x1, y1) and the lid's seat."""
        x0, x1, y1, z = bx0, bx1, W + cl["back"], z_top
        battery = None
        if spec.battery:
            battery, x0, x1, y1 = _place_battery(spec, windowed, x0, y0, x1, y1, battery_along_x)
            # the lid lip hangs LIP_HEIGHT into the cavity along the walls the pocket touches
            z = max(z, floor_top + BATTERIES[spec.battery].height + max(spec.top_clearance, LIP_HEIGHT + BATTERY_FIT))
        modules: list[PlacedModule] = []
        if spec.modules:
            modules, x0, x1, y1 = _place_modules(spec, board, windowed, battery, bx0, bx1, x0, x1, y1, floor_top)
            z = max(z, max(m.top for m in modules) + spec.top_clearance)
        lid_modules: list[PlacedModule] = []
        if spec.lid_modules:
            lid_modules, x0, x1, y1 = _place_lid_modules(spec, windowed, x0, y0, x1, y1)
            # what hangs from the lid clears the parts right under it
            below = [((0.0, 0.0, L, W), pcb_top + top_height)] + [(m.rect(), m.top) for m in modules]
            if battery:
                below.append((battery, floor_top + BATTERIES[spec.battery].height))
            for m in lid_modules:
                hang = m.module.top_height + m.module.pcb_thickness + m.module.bottom_clearance
                under = [top for rect, top in below if _rects_overlap(rect, m.rect())]
                z = max(z, max(under, default=floor_top) + spec.top_clearance + hang)
        return battery, modules, lid_modules, x0, x1, y1, z

    if spec.battery and (spec.modules or spec.lid_modules):
        # the battery turned either way: which one leaves the smaller case once the modules are in
        arranged, first_error = [], None
        for along_x in (True, False):
            try:
                arranged.append(arrange(along_x))
            except ValueError as e:
                first_error = first_error or e
        if not arranged:
            raise first_error
        battery, modules, lid_modules, x0, x1, y1, z_top = min(arranged, key=lambda a: (a[4] - a[3]) * (a[5] - y0))
    else:
        battery, modules, lid_modules, x0, x1, y1, z_top = arrange(None)
    x0, x1, y0, y1, z_top = _grow_for_extras(spec, windowed, x0, x1, y0, y1, z_top, pcb_top)
    for m in lid_modules:  # the displays hang from the lid's final height
        m.top = z_top
        m.pcb_top = z_top - m.module.top_height
        m.bottom = m.pcb_top - m.module.pcb_thickness

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
        modules=modules,
        lid_modules=lid_modules,
    )
    if spec.lid == "screw":
        _place_posts(layout)
    return layout


def _resolve_module(m: InsideModule) -> Board:
    if m.type:
        try:
            module = get_module(m.type)
        except KeyError as e:
            raise ValueError(str(e.args[0])) from None
    else:
        module = Board(
            id=m.name, name=m.name, size=m.size, top_height=GENERIC_MODULE_HEIGHT, bottom_clearance=3.0,
            mount="end_supports", support_depth=MODULE_GAP,
        )
    return module.model_copy(update={"top_height": m.height}) if m.height is not None else module


def _place_modules(
    spec: EnclosureSpec, board: Board, windowed: list[ResolvedConnector], battery: tuple[float, float, float, float] | None,
    bx0: float, bx1: float, x0: float, x1: float, y1: float, floor_top: float,
) -> tuple[list[PlacedModule], float, float, float]:
    """Modules in rows behind the board; returns them and the grown cavity.

    A row stays inside the board's compartment along X, unless it lies behind the battery pocket too: then it
    runs the whole length of the case. A module longer than its row is turned 90 degrees; if it is still too long
    the case grows towards an end with neither connector windows nor the battery. A module with a `position`
    stays where it is put.
    """
    def free_end() -> str | None:
        for side in ("right", "left"):
            if not (spec.battery and spec.battery_side == side) and not any(c.side == side for c in windowed):
                return side
        return None

    def span(y: float) -> tuple[float, float]:
        clear_of_battery = battery is None or y >= battery[3] + BATTERY_RIB + MODULE_GAP
        return (x0, x1) if battery and clear_of_battery else (bx0, bx1)

    placed: list[PlacedModule] = []
    row_y, row_depth, in_row = board.width + MODULE_GAP, 0.0, 0
    lo, hi = span(row_y)
    cursor = lo + MODULE_GAP
    grown_y1 = y1
    for m in spec.modules:
        module = _resolve_module(m)
        length, width = module.size
        rotated = False
        if m.position:
            px, py = m.position
        else:
            room = hi - lo - 2 * MODULE_GAP
            if length > room and width <= room:
                length, width, rotated = width, length, True
            if length > room:
                end = free_end()
                if end is None:
                    raise ValueError(
                        f"module {m.name} ({length:.0f} mm) is longer than the board's compartment ({room:.0f} mm) and both "
                        "ends of the case are taken by connector windows or the battery"
                    )
                grow = length - room
                if end == "right":
                    bx1, x1 = bx1 + grow, x1 + grow
                else:
                    bx0, x0 = bx0 - grow, x0 - grow
                lo, hi = span(row_y)
                if not in_row:
                    cursor = lo + MODULE_GAP
            if in_row and cursor + length > hi - MODULE_GAP:
                row_y, row_depth, in_row = row_y + row_depth + MODULE_GAP, 0.0, 0
                lo, hi = span(row_y)
                cursor = lo + MODULE_GAP
            px, py = cursor, row_y
            cursor, row_depth, in_row = cursor + length + MODULE_GAP, max(row_depth, width), in_row + 1
            grown_y1 = max(grown_y1, py + width + MODULE_GAP)
        bottom = floor_top + module.bottom_clearance
        pcb_top = bottom + module.pcb_thickness
        placed.append(PlacedModule(m.name, module, px, py, px + length, py + width, rotated, bottom, pcb_top, pcb_top + module.top_height))
    if grown_y1 > y1 and any(c.side == "back" for c in windowed):
        raise ValueError("the modules make the case deeper than the board: the back connector windows would not reach the wall")
    return placed, x0, x1, grown_y1


def _place_lid_modules(
    spec: EnclosureSpec, windowed: list[ResolvedConnector], x0: float, y0: float, x1: float, y1: float,
) -> tuple[list[PlacedModule], float, float, float]:
    """Displays in a row across the middle of the lid; the case grows when they do not fit inside its lip.

    Heights are set once the lid's height is known. A module with a `position` stays where it is put.
    """
    resolved: list[tuple[LidModule, Board]] = []
    for m in spec.lid_modules:
        try:
            module = get_module(m.type)
        except KeyError as e:
            raise ValueError(str(e.args[0])) from None
        if not module.window:
            raise ValueError(f"module {m.type} has no display window: it cannot hang under the lid")
        resolved.append((m, module))
    auto = [(m, mod) for m, mod in resolved if not m.position]
    row = sum(mod.length for _, mod in auto) + MODULE_GAP * max(len(auto) - 1, 0)
    depth = max((mod.width for _, mod in auto), default=0.0)
    need_x = row + 2 * LID_MODULE_INSET - (x1 - x0)
    if need_x > 0:
        ends = [s for s in ("right", "left") if not (spec.battery and spec.battery_side == s) and not any(c.side == s for c in windowed)]
        if not ends:
            raise ValueError("the displays are wider than the case and both ends are taken by connector windows or the battery")
        if ends[0] == "right":
            x1 += need_x
        else:
            x0 -= need_x
    need_y = depth + 2 * LID_MODULE_INSET - (y1 - y0)
    if need_y > 0:
        if any(c.side == "back" for c in windowed):
            raise ValueError("the displays make the case deeper than the board: the back connector windows would not reach the wall")
        y1 += need_y
    placed = []
    cursor = (x0 + x1) / 2 - row / 2
    for m, module in resolved:
        if m.position:
            px, py = m.position
        else:
            px, py = cursor, (y0 + y1) / 2 - module.width / 2
            cursor += module.length + MODULE_GAP
        placed.append(PlacedModule(m.name, module, px, py, px + module.length, py + module.width, False, 0.0, 0.0, 0.0))
    return placed, x0, x1, y1


def _place_battery(
    spec: EnclosureSpec, windowed: list[ResolvedConnector], x0: float, y0: float, x1: float, y1: float,
    along_x: bool | None = None,
) -> tuple[tuple[float, float, float, float], float, float, float]:
    """Battery pocket at one end of the case, behind a divider rib; returns the pocket and the grown cavity.

    `along_x` lays the pack's long edge along X (True) or Y (False); None picks whichever keeps the case smaller.
    """
    bat = BATTERIES[spec.battery]
    side = spec.battery_side
    blocked = [c.name for c in windowed if c.side == side]
    if blocked:
        other = "left" if side == "right" else "right"
        raise ValueError(f"a battery on the {side} would cover the {', '.join(blocked)} window; use battery_side={other}")

    ends = 2 * HATCH_BOSS_ZONE if spec.battery_hatch else 0.0  # room for the hatch's screw bosses along X
    # the hatch opening leans out by the floor's thickness at the bottom: keep it off the front and back walls
    side_gap = spec.floor if spec.battery_hatch else 0.0

    def footprint(length: float, width: float) -> float:
        return (x1 - x0 + BATTERY_RIB + length + 2 * BATTERY_FIT + ends) * (max(y1, y0 + width + 2 * BATTERY_FIT + 2 * side_gap) - y0)

    if along_x is None:
        # long edge along X or along Y, whichever keeps the case smaller
        length, width = min((bat.length, bat.width), (bat.width, bat.length), key=lambda lw: footprint(*lw))
    else:
        length, width = (bat.length, bat.width) if along_x else (bat.width, bat.length)
    pl, pw = length + 2 * BATTERY_FIT + ends, width + 2 * BATTERY_FIT
    grown_y1 = max(y1, y0 + pw + 2 * side_gap)
    py0 = y0 + side_gap
    if grown_y1 > y1 and any(c.side == "back" for c in windowed):
        raise ValueError(f"battery {spec.battery} makes the case deeper than the board: the back connector windows would not reach the wall")
    if side == "right":
        px0 = x1 + BATTERY_RIB
        return (px0, py0, px0 + pl, py0 + pw), x0, px0 + pl, grown_y1
    px1 = x0 - BATTERY_RIB
    return (px1 - pl, py0, px1, py0 + pw), px1 - pl, x1, grown_y1


def _place_posts(layout: Layout) -> None:
    """Put lid screw posts in the cavity corners, widening the box along X until they clear the board."""
    board = layout.board
    L, W = board.size
    keepouts = [(-KEEPOUT_GAP, -KEEPOUT_GAP, L + KEEPOUT_GAP, W + KEEPOUT_GAP)]
    if layout.battery:
        keepouts.append(layout.battery)
    for m in layout.modules + layout.lid_modules:
        keepouts.append((m.x0 - KEEPOUT_GAP, m.y0 - KEEPOUT_GAP, m.x1 + KEEPOUT_GAP, m.y1 + KEEPOUT_GAP))
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


def _side_extra_halves(e: ExtraCutout) -> tuple[float, float]:
    """Half the size of a side opening's bounding rectangle: along the wall, and in height."""
    if e.shape == "circle":
        return e.diameter / 2, e.diameter / 2
    if e.shape == "rect":
        return e.width / 2, e.height / 2
    return (e.slot_count - 1) * e.slot_pitch / 2 + e.width / 2, e.height / 2


def _grow_for_extras(
    spec: EnclosureSpec, windowed: list[ResolvedConnector], x0: float, x1: float, y0: float, y1: float,
    z_top: float, pcb_top: float,
) -> tuple[float, float, float, float, float]:
    """Grow the cavity so every side opening fits its wall: along the wall, towards sides without connector windows
    (moving such a wall would take the connector away from its window), and upwards for a tall opening.

    An opening that runs past a wall with a connector window is left to the opening check, which says how far to
    move it.
    """
    blocked = {c.side for c in windowed}
    g = EXTRA_CORNER_MARGIN
    for e in spec.extras:
        if e.face in ("top", "bottom"):
            continue
        half_a, half_z = _side_extra_halves(e)
        a0, a1 = e.along - half_a, e.along + half_a
        if e.face in ("front", "back"):  # along X
            if a0 < x0 + g and "left" not in blocked:
                x0 = a0 - g
            if a1 > x1 - g and "right" not in blocked:
                x1 = a1 + g
        else:  # along Y
            if a0 < y0 + g and "front" not in blocked:
                y0 = a0 - g
            if a1 > y1 - g and "back" not in blocked:
                y1 = a1 + g
        z_top = max(z_top, pcb_top + e.z + half_z + LIP_HEIGHT + 0.01)  # under the lid's lip
    return x0, x1, y0, y1, z_top


def _extra_side_openings(layout: Layout) -> list[Opening]:
    """Bounding rectangles of side extras (circles included) so checks can treat them like windows."""
    out = []
    for e in layout.spec.extras:
        if e.face in ("top", "bottom"):
            continue
        zc = layout.pcb_top + e.z
        half_a, half_z = _side_extra_halves(e)
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
        if spec.battery_hatch:
            base += _hatch_bosses(layout)
            base -= _hatch_cuts(layout)
    for m in layout.modules:
        base += _module_supports(layout, m)

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


def _module_supports(layout: Layout, m: PlacedModule) -> Part:
    """Standoffs under a module's holes, or blocks under both ends of its length when it has none."""
    z0 = layout.floor_top - 0.5
    if m.module.mount == "standoffs":
        pilot_d = m.module.holes.diameter * STANDOFF_PILOT_RATIO
        pilot_bottom = max(layout.spec.min_wall, m.bottom - 6.0)
        supports = None
        for hx, hy in m.holes():
            post = cylinder_z(hx, hy, z0, m.bottom, STANDOFF_D) - cylinder_z(hx, hy, pilot_bottom, m.bottom + 0.1, pilot_d)
            supports = post if supports is None else supports + post
        return supports
    d = m.module.support_depth
    if m.rotated:
        return box(m.x0, m.y0, z0, m.x1, m.y0 + d, m.bottom) + box(m.x0, m.y1 - d, z0, m.x1, m.y1, m.bottom)
    return box(m.x0, m.y0, z0, m.x0 + d, m.y1, m.bottom) + box(m.x1 - d, m.y0, z0, m.x1, m.y1, m.bottom)


def module_body(m: PlacedModule) -> Part:
    """A module's envelope: its PCB and everything on it."""
    return box(m.x0, m.y0, m.bottom, m.x1, m.y1, m.top)


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
    bx0, by0, bx1, by1 = layout.battery_rect()
    return box(bx0, by0, layout.floor_top, bx1, by1, layout.floor_top + BATTERIES[layout.spec.battery].height)


def _frustum(x0: float, y0: float, x1: float, y1: float, z0: float, height: float) -> Part:
    """A block whose sides lean in at 45 degrees: (x0, y0, x1, y1) at z0, `height` smaller on every side at the top."""
    return extrude(Pos((x0 + x1) / 2, (y0 + y1) / 2, z0) * Rectangle(x1 - x0, y1 - y0), amount=height, taper=45)


def _hatch_ears(layout: Layout, grow: float) -> list[tuple[float, float, float, float]]:
    """The ears' footprints, from the pocket's ends (not under its walls) to the opening, grown by `grow`."""
    px0, _, px1, _ = layout.battery
    ox0, _, ox1, _ = layout.battery_rect()
    cy = (layout.battery[1] + layout.battery[3]) / 2
    h = HATCH_EAR_W / 2 + grow
    inset = 0.5 - grow
    return [(px0 + inset, cy - h, ox0, cy + h), (ox1, cy - h, px1 - inset, cy + h)]


def _hatch_cuts(layout: Layout) -> Part:
    """The floor's opening under the battery, the recesses for the hatch's ears, the bosses' pilot holes."""
    f = layout.floor_top
    ox0, oy0, ox1, oy1 = layout.battery_rect()
    cut = _frustum(ox0 - f - 1, oy0 - f - 1, ox1 + f + 1, oy1 + f + 1, -1, f + 1.01)
    for x0, y0, x1, y1 in _hatch_ears(layout, 0.0):
        cut += box(x0, y0, -1, x1, y1, HATCH_EAR_T)
    top = f + min(BATTERY_RIB_MAX, BATTERIES[layout.spec.battery].height * 0.6)
    for bx, by in layout.hatch_bosses():
        cut += cylinder_z(bx, by, HATCH_EAR_T - 0.1, top - 1.0, POST_PILOT_D)
    return cut


def _hatch_bosses(layout: Layout) -> Part:
    top = layout.floor_top + min(BATTERY_RIB_MAX, BATTERIES[layout.spec.battery].height * 0.6)
    (lx, ly), (rx, ry) = layout.hatch_bosses()
    return cylinder_z(lx, ly, layout.floor_top - 0.5, top, HATCH_BOSS_D) + cylinder_z(rx, ry, layout.floor_top - 0.5, top, HATCH_BOSS_D)


def build_hatch(layout: Layout) -> Part:
    """The battery hatch, as printed and as fitted: flush with the floor's underside, ears screwed into the bosses."""
    f = layout.floor_top
    ox0, oy0, ox1, oy1 = layout.battery_rect()
    g = HATCH_FIT
    hatch = _frustum(ox0 - f + g, oy0 - f + g, ox1 + f - g, oy1 + f - g, 0, f)
    for x0, y0, x1, y1 in _hatch_ears(layout, -g):
        hatch += box(x0, y0, 0, x1, y1, HATCH_EAR_T)
    for bx, by in layout.hatch_bosses():
        hatch -= cylinder_z(bx, by, -1, HATCH_EAR_T + 1, LID_HOLE_D)
    return hatch


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
    for m in layout.lid_modules:
        lid += _lid_standoffs(layout, m)
        wx0, wy0, wx1, wy1 = m.window_rect()
        lid -= box(wx0, wy0, layout.z_top - 0.5, wx1, wy1, layout.lid_top + 1)
    return lid


def _lid_standoffs(layout: Layout, m: PlacedModule) -> Part:
    """Posts from the lid's underside down to a display's PCB, with a pilot hole for its screws."""
    hole_d = m.module.holes.diameter
    post_d = min(STANDOFF_D, hole_d + 2 * LID_POST_WALL)
    pilot_d = hole_d * STANDOFF_PILOT_RATIO
    pilot_top = min(m.pcb_top + 6.0, layout.lid_top - layout.spec.min_wall)
    posts = None
    for hx, hy in m.holes():
        post = cylinder_z(hx, hy, m.pcb_top, layout.z_top + 0.01, post_d) - cylinder_z(hx, hy, m.pcb_top - 0.1, pilot_top, pilot_d)
        posts = post if posts is None else posts + post
    return posts


def lid_module_bodies(m: PlacedModule) -> dict[str, Part]:
    """What hangs under the lid: the PCB with its back parts, and the display over its visible area."""
    wx0, wy0, wx1, wy1 = m.window_rect()
    return {
        f"lid module:{m.name}": box(m.x0, m.y0, m.lowest, m.x1, m.y1, m.pcb_top),
        f"display:{m.name}": box(wx0, wy0, m.pcb_top, wx1, wy1, m.top),
    }


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
    for m in layout.modules:
        parts[f"module:{m.name}"] = module_body(m)
    return parts


def build_keepouts(layout: Layout, board_parts: dict[str, Part]) -> dict[str, Part]:
    """Volumes the enclosure must not intrude into: PCB, connectors, component envelope above the board, battery."""
    L, W = layout.board.size
    keepouts = {"pcb": box(0, 0, layout.board_bottom, L, W, layout.pcb_top)}
    keepouts["components above board"] = box(0, 0, layout.pcb_top, L, W, layout.pcb_top + layout.top_height)
    keepouts.update({k: v for k, v in board_parts.items() if k.startswith(("connector:", "module:")) or k == "battery"})
    return keepouts


def build(spec: EnclosureSpec, board: Board | None = None) -> Enclosure:
    layout = make_layout(spec, board)
    board_parts = build_board_parts(layout)
    lid_parts = {k: v for m in layout.lid_modules for k, v in lid_module_bodies(m).items()}
    return Enclosure(
        layout=layout,
        base=build_base(layout),
        lid=build_lid(layout),
        openings=_connector_openings(layout) + _extra_side_openings(layout),
        keepouts={**build_keepouts(layout, board_parts), **lid_parts},
        board_parts=board_parts,
        lid_parts=lid_parts,
        hatch=build_hatch(layout) if spec.battery_hatch else None,
    )
