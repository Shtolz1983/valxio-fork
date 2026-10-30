import asyncio
import base64
import io
import json
import re
import struct
import tempfile
import zipfile
from pathlib import Path

import pytest
from build123d import Vector, import_stl
from fastapi import HTTPException

from app.api.routes import enclosure as route
from app.services.enclosure import export as export_mod
from app.services.enclosure.batteries import CATALOG as BATTERIES
from app.services.enclosure.checks import check_collisions, run_checks
from app.services.enclosure.enclosure import build, build_board_parts, build_keepouts, make_layout
from app.services.enclosure.registry import get_board, load_boards, load_modules
from app.services.enclosure.render import render_png
from app.services.enclosure.spec import EnclosureSpec

BOARDS = sorted(load_boards())
MODULES = sorted(load_modules())
REPO = Path(__file__).resolve().parents[3]


def errors(enc):
    return [v for v in run_checks(enc) if v.severity == "error"]


def all_but_bridges(enc):
    """A window cut through a side wall prints its top edge as a bridge: that warning is expected."""
    return [v for v in run_checks(enc) if v.code != "overhang_bridge"]


@pytest.mark.parametrize("board", BOARDS)
@pytest.mark.parametrize("lid", ["screw", "snap"])
def test_default_enclosure_passes_all_checks(board, lid):
    enc = build(EnclosureSpec(board=board, lid=lid))
    assert enc.base.is_valid and enc.lid.is_valid
    assert run_checks(enc) == []


def test_every_connector_gets_a_window_inside_its_side():
    enc = build(EnclosureSpec(board="arduino_uno"))
    names = {(o.name, o.side) for o in enc.openings}
    assert names == {("usb", "left"), ("power", "left")}
    for o in enc.openings:
        conn = next(c for c in enc.layout.connectors if c.name == o.name)
        assert o.along0 < conn.center - conn.width / 2 and o.along1 > conn.center + conn.width / 2
        assert o.z0 < enc.layout.pcb_top + conn.z and o.z1 > enc.layout.pcb_top + conn.z + conn.height


def test_skipped_connector_has_no_window():
    enc = build(EnclosureSpec(board="arduino_uno", skip_connectors=["power"]))
    assert [o.name for o in enc.openings] == ["usb"]
    # the jack is still on the board: the cavity keeps room for it, so the closed wall sits in front of it
    assert check_collisions(enc) == []


def test_thin_wall_is_reported():
    enc = build(EnclosureSpec(board="arduino_uno", wall=0.8))
    assert any(v.check == "thickness" and "wall" in v.message for v in errors(enc))


def test_shifted_connector_collides_with_wall():
    """Board data says USB is 5 mm further back than where the window was cut."""
    spec = EnclosureSpec(board="arduino_uno")
    enc = build(spec)
    real = get_board("arduino_uno").model_copy(deep=True)
    real.connectors[0].center += 5
    real_layout = make_layout(spec, real)
    enc.keepouts = build_keepouts(real_layout, build_board_parts(real_layout))
    assert any("connector:usb" in v.message for v in check_collisions(enc))


def test_low_lid_hits_components_and_lip_blocks_windows():
    enc = build(EnclosureSpec(board="arduino_uno", top_clearance=0.5))
    msgs = [v.message for v in errors(enc)]
    assert any("components above board" in m for m in msgs)
    assert any("lid lip" in m for m in msgs)


def test_extras_outside_or_on_posts_are_reported():
    spec = EnclosureSpec(board="arduino_uno", extras=[
        {"name": "far", "face": "top", "shape": "circle", "diameter": 5, "center_x": 200, "center_y": 20},
        {"name": "post", "face": "top", "shape": "circle", "diameter": 5, "center_x": -5.5, "center_y": 1.8},
    ])
    msgs = [v.message for v in errors(build(spec))]
    assert any("far" in m and "outside" in m for m in msgs)
    assert any("post" in m and "screw post" in m for m in msgs)


MATRIX = {"name": "matrix", "face": "front", "shape": "rect", "width": 128, "height": 32, "z": 10}


def test_long_side_opening_grows_the_case_away_from_the_connector_wall():
    """A 128 mm window on the front of a Nano: the case grows to the right, the USB stays at its window on the left."""
    plain = make_layout(EnclosureSpec(board="arduino_nano"))
    enc = build(EnclosureSpec(board="arduino_nano", extras=[{**MATRIX, "along": 66}]))
    lay = enc.layout
    assert lay.x0 == plain.x0 and lay.y0 == plain.y0
    assert lay.x1 >= 66 + 64 + 1.5
    assert lay.z_top - 2.0 >= lay.pcb_top + 10 + 16  # the window clears the lid's lip
    assert [v for v in run_checks(enc) if v.check == "opening"] == []


def test_side_opening_past_a_connector_wall_says_how_far_to_move_it():
    enc = build(EnclosureSpec(board="arduino_nano", extras=[{**MATRIX, "along": 30}]))
    corner = [v for v in errors(enc) if v.code == "opening_corner"]
    assert len(corner) == 1 and "move it +" in corner[0].message
    moved = {**MATRIX, "along": 30 + corner[0].params["shift"] + 0.1}
    assert [v for v in errors(build(EnclosureSpec(board="arduino_nano", extras=[moved]))) if v.check == "opening"] == []


def test_side_opening_longer_than_a_wall_held_by_connectors_at_both_ends():
    board = get_board("arduino_nano").model_copy(deep=True)
    board.connectors.append(board.connectors[0].model_copy(update={"name": "usb2", "side": "right"}))
    enc = build(EnclosureSpec(board="arduino_nano", extras=[{**MATRIX, "along": 20}]), board)
    assert [v.code for v in errors(enc) if v.check == "opening"] == ["opening_too_long"]


def test_side_clearance_makes_room_on_one_side_only():
    plain = make_layout(EnclosureSpec(board="arduino_nano"))
    lay = make_layout(EnclosureSpec(board="arduino_nano", side_clearance={"right": 40, "left": 0}))
    assert lay.x1 == pytest.approx(43.18 + 40)
    assert lay.x0 == plain.x0  # the USB still reaches its window
    assert (lay.y0, lay.y1) == (plain.y0, plain.y1)
    assert errors(build(EnclosureSpec(board="arduino_nano", side_clearance={"right": 40}))) == []


def test_large_round_side_hole_needs_supports():
    spec = EnclosureSpec(board="arduino_uno", top_clearance=6,
                         extras=[{"face": "front", "shape": "circle", "diameter": 12, "along": 34, "z": 6}])
    assert any(v.check == "overhang" for v in run_checks(build(spec)))


def test_bed_too_small():
    enc = build(EnclosureSpec(board="arduino_uno", bed=(60, 60, 60)))
    assert any(v.check == "bed" for v in errors(enc))


def test_unknown_skip_connector_rejected():
    with pytest.raises(ValueError, match="unknown names"):
        build(EnclosureSpec(board="arduino_uno", skip_connectors=["hdmi"]))


def test_canvas_kinds_are_real_board_kinds():
    """The AI picks the enclosure board by the canvas board's kind; a typo would leave a board without one."""
    src = (REPO / "frontend/src/types/board.ts").read_text()
    union = src[src.index("export type BoardKind"):src.index(";", src.index("export type BoardKind"))]
    kinds = set(re.findall(r"'([a-z0-9-]+)'", union))
    claimed = [k for b in load_boards().values() for k in b.canvas_kinds]
    assert claimed and set(claimed) <= kinds
    assert len(claimed) == len(set(claimed)), "a canvas kind maps to two enclosure boards"


@pytest.mark.parametrize("battery", sorted(BATTERIES))
def test_battery_compartment_passes_all_checks(battery):
    enc = build(EnclosureSpec(board="arduino_uno", battery=battery))
    assert run_checks(enc) == []
    lay, bat = enc.layout, BATTERIES[battery]
    px0, py0, px1, py1 = lay.battery
    # the pocket holds the battery either way round, on the side away from the USB and power jack
    assert sorted([px1 - px0, py1 - py0]) == pytest.approx(sorted([bat.length + 1, bat.width + 1]))
    assert px0 > get_board("arduino_uno").length and lay.board_x_range()[1] < px0
    assert lay.z_top >= lay.floor_top + bat.height + 2.0
    assert "battery" in enc.keepouts and "battery" in enc.board_parts


@pytest.mark.parametrize("battery", sorted(BATTERIES))
def test_battery_hatch_opens_the_floor_and_fits_it(battery):
    enc = build(EnclosureSpec(board="arduino_uno", battery=battery, battery_hatch=True))
    assert run_checks(enc) == []
    lay = enc.layout
    bb = enc.hatch.bounding_box()
    assert bb.min.Z == pytest.approx(0) and bb.max.Z == pytest.approx(lay.floor_top)  # flush with the floor
    x0, y0, x1, y1 = lay.battery_rect()
    under_battery = Vector((x0 + x1) / 2, (y0 + y1) / 2, lay.floor_top / 2)
    assert not enc.base.is_inside(under_battery) and enc.hatch.is_inside(under_battery)
    # the opening is the battery's whole footprint at the top of the floor: cells come out through it
    assert not enc.base.is_inside(Vector(x0 + 0.3, (y0 + y1) / 2, lay.floor_top - 0.05))


def test_battery_hatch_is_a_printed_part():
    enc = build(EnclosureSpec(board="arduino_nano", battery="1x18650", battery_hatch=True))
    assert [name for name, _ in enc.printed_parts()] == ["base", "lid", "hatch"]
    without = build(EnclosureSpec(board="arduino_nano", battery="1x18650"))
    assert enc.weight_g > without.weight_g - 1  # the hatch counts; the floor it replaces does not
    with pytest.raises(ValueError, match="needs a battery"):
        EnclosureSpec(board="arduino_uno", battery_hatch=True)


def test_battery_on_the_left_end_with_end_supports():
    enc = build(EnclosureSpec(board="esp32_devkitc", battery="1x18650", battery_side="right"))
    assert run_checks(enc) == []
    # supports stay under the board, the floor under the battery is free
    assert enc.layout.board_x_range()[1] < enc.layout.battery[0]


def test_battery_cannot_cover_a_connector_window():
    with pytest.raises(ValueError, match="battery_side=right"):
        build(EnclosureSpec(board="arduino_uno", battery="2xAA", battery_side="left"))
    # closing both left windows frees that end
    enc = build(EnclosureSpec(board="arduino_uno", battery="2xAA", battery_side="left", skip_connectors=["usb", "power"]))
    assert enc.layout.battery[2] < 0 and errors(enc) == []


def test_unknown_battery_rejected():
    with pytest.raises(ValueError, match="unknown battery"):
        EnclosureSpec(board="arduino_uno", battery="AAA")


def test_top_height_override_raises_the_lid():
    low = build(EnclosureSpec(board="perfboard_50x70"))
    high = build(EnclosureSpec(board="perfboard_50x70", top_height=17))
    assert high.layout.lid_top - low.layout.lid_top == pytest.approx(5)
    assert run_checks(high) == []


DISPLAYS = sorted(k for k, m in load_modules().items() if m.window)
LID_DISPLAYS = sorted(k for k, m in load_modules().items() if m.window and m.holes)  # screwed to posts under the lid
INSIDE_MODULES = sorted(k for k, m in load_modules().items() if not m.window)


@pytest.mark.parametrize("display", LID_DISPLAYS)
def test_each_display_hangs_under_the_lid_behind_its_window(display):
    enc = build(EnclosureSpec(board="arduino_uno", lid_modules=[{"name": "d1", "type": display}]))
    assert run_checks(enc) == []
    lay = enc.layout
    [m] = lay.lid_modules
    assert m.top == lay.z_top and m.lowest >= lay.pcb_top + lay.top_height + lay.spec.top_clearance - 1e-6
    # the window is open: a point in its middle is not lid material, a point beside the display is
    wx0, wy0, wx1, wy1 = m.window_rect()
    zmid = (lay.z_top + lay.lid_top) / 2
    assert not enc.lid.is_inside(Vector((wx0 + wx1) / 2, (wy0 + wy1) / 2, zmid))
    assert enc.lid.is_inside(Vector(lay.x0 + 1, lay.y0 + 1, zmid))
    assert set(enc.lid_parts) == {"lid module:d1", "display:d1"}


def test_a_display_bigger_than_the_case_grows_it():
    enc = build(EnclosureSpec(board="arduino_nano", lid_modules=[{"name": "lcd", "type": "lcd2004"}]))
    assert run_checks(enc) == []
    assert enc.layout.x1 - enc.layout.x0 > 98 and enc.layout.y1 - enc.layout.y0 > 60


def test_two_displays_side_by_side_and_bad_ones():
    enc = build(EnclosureSpec(board="arduino_uno", lid_modules=[{"name": "oled", "type": "oled_096"}, {"name": "seg", "type": "tm1637"}]))
    assert run_checks(enc) == []
    oled, seg = enc.layout.lid_modules
    assert seg.x0 > oled.x1
    with pytest.raises(ValueError, match="no display window"):
        build(EnclosureSpec(board="arduino_uno", lid_modules=[{"name": "r", "type": "relay"}]))
    # pinned by hand into the corner: under the lip; the corner screw posts move away from it
    enc = build(EnclosureSpec(board="arduino_uno", lid_modules=[{"name": "oled", "type": "oled_096", "position": (-5, -2)}]))
    assert any("lid's lip" in v.message for v in errors(enc))
    # over the board the lid rises with the display; only a negative top_clearance lets it hang into the parts
    spec = EnclosureSpec(board="arduino_uno", lid_modules=[{"name": "oled", "type": "oled_096", "position": (20, 15)}])
    assert run_checks(build(spec)) == []
    assert any("hangs into the board" in v.message for v in errors(build(spec.model_copy(update={"top_clearance": -3}))))


@pytest.mark.parametrize("display", DISPLAYS)
def test_each_display_stands_against_a_side_wall_behind_its_window(display):
    plain = make_layout(EnclosureSpec(board="arduino_uno"))
    enc = build(EnclosureSpec(board="arduino_uno", wall_modules=[{"name": "d1", "type": display, "face": "front"}]))
    assert all_but_bridges(enc) == []
    lay = enc.layout
    [m] = lay.wall_modules
    assert lay.y0 == pytest.approx(plain.y0 - m.depth - 2.0)  # the front wall moved out by the display's depth
    # the connectors on the left stay at their windows (no screw posts: they move the side walls out for themselves)
    assert lay.x0 == pytest.approx(make_layout(EnclosureSpec(board="arduino_uno", lid="snap")).x0)
    assert lay.z_top - 2.0 >= m.z1 and m.z0 > lay.floor_top
    # the window is open: a point in the wall at its middle is not base material, a point in the wall beside it is
    wa0, wa1, wz0, wz1 = m.window()
    y_wall = lay.y0 - lay.spec.wall / 2
    assert not enc.base.is_inside(Vector((wa0 + wa1) / 2, y_wall, (wz0 + wz1) / 2))
    assert enc.base.is_inside(Vector(m.a0 - 2, y_wall, (wz0 + wz1) / 2))
    # the cradle's columns stand beside both ends of the PCB
    zc = (m.z0 + m.z1) / 2
    assert enc.base.is_inside(Vector(m.a0 - 1.5, lay.y0 + 1, zc)) and enc.base.is_inside(Vector(m.a1 + 1.5, lay.y0 + 1, zc))
    assert "module:d1" in enc.board_parts


def test_long_matrix_on_the_front_of_a_nano_and_its_mistakes():
    """The 4-in-1 matrix (128 mm) on a Nano: the case grows to the right, the USB keeps its window on the left."""
    matrix = {"name": "matrix", "type": "max7219_4in1", "face": "front"}
    enc = build(EnclosureSpec(board="arduino_nano", wall_modules=[matrix]))
    assert all_but_bridges(enc) == []
    lay, [m] = enc.layout, enc.layout.wall_modules
    assert lay.x0 == make_layout(EnclosureSpec(board="arduino_nano")).x0
    assert lay.x1 >= m.a1 + 3.3 and m.a0 - 3.3 >= lay.x0
    # its window centre where asked, 20 mm above the PCB top
    enc = build(EnclosureSpec(board="arduino_nano", wall_modules=[{**matrix, "along": 80, "z": 20}]))
    wa0, wa1, wz0, wz1 = enc.layout.wall_modules[0].window()
    assert ((wa0 + wa1) / 2, (wz0 + wz1) / 2 - enc.layout.pcb_top) == pytest.approx((80, 20))
    assert errors(enc) == []
    # pushed into the left corner, where the USB holds the wall; and down through the floor
    codes = {v.code: v for v in errors(build(EnclosureSpec(board="arduino_nano", wall_modules=[{**matrix, "along": 30, "z": -10}])))}
    assert codes["wall_display_corner"].params["shift"] > 0 and "wall_display_low" in codes
    # a cable hole behind the display
    hole = {"name": "cable", "face": "front", "shape": "circle", "diameter": 6, "along": 70, "z": 5}
    codes = {v.code for v in errors(build(EnclosureSpec(board="arduino_nano", wall_modules=[matrix], extras=[hole])))}
    assert "wall_display_covers" in codes
    # not on the wall with the USB window, and not under the lid: its holes are under the matrices
    with pytest.raises(ValueError, match="usb"):
        build(EnclosureSpec(board="arduino_nano", wall_modules=[{**matrix, "face": "left"}]))
    with pytest.raises(ValueError, match="no mounting holes"):
        build(EnclosureSpec(board="arduino_nano", lid_modules=[{"name": "matrix", "type": "max7219_4in1"}]))


def test_two_displays_on_one_wall_stand_side_by_side():
    enc = build(EnclosureSpec(board="arduino_uno", wall_modules=[
        {"name": "oled", "type": "oled_096", "face": "back"}, {"name": "seg", "type": "tm1637", "face": "back"},
    ]))
    assert all_but_bridges(enc) == []
    oled, seg = enc.layout.wall_modules
    assert oled.span()[1] < seg.span()[0] or seg.span()[1] < oled.span()[0]
    pinned = [{"name": "a", "type": "oled_096", "face": "back", "along": 30}, {"name": "b", "type": "oled_096", "face": "back", "along": 40}]
    assert "wall_display_overlap" in {v.code for v in errors(build(EnclosureSpec(board="arduino_uno", wall_modules=pinned)))}


@pytest.mark.parametrize("module", INSIDE_MODULES)
def test_each_module_fits_inside_behind_the_board(module):
    enc = build(EnclosureSpec(board="arduino_uno", modules=[{"name": "m1", "type": module}]))
    assert run_checks(enc) == []
    [m] = enc.layout.modules
    assert m.y0 > get_board("arduino_uno").width  # behind the board
    assert enc.layout.z_top >= m.top


def test_module_part_types_are_real_part_types():
    """The assistant matches a canvas part to a module by its type; a typo would leave the part without one."""
    meta = json.loads((REPO / "frontend/public/components-metadata.json").read_text())
    types = {c["id"] for c in (meta["components"] if isinstance(meta, dict) else meta)}
    types |= {p.stem for p in (REPO / "parts-catalog").glob("*.json")}
    claimed = [t for m in load_modules().values() for t in m.part_types]
    assert claimed and set(claimed) <= types


def test_modules_fill_rows_and_a_long_one_turns():
    spec = EnclosureSpec(board="arduino_nano", modules=[
        {"name": "rtc", "type": "ds3231"}, {"name": "imu", "type": "mpu6050"}, {"name": "relay1", "type": "relay"},
    ])
    enc = build(spec)
    assert run_checks(enc) == []
    rtc, imu, relay = enc.layout.modules
    assert imu.y0 > rtc.y0  # 38 + 20 mm do not fit the Nano's 46 mm in one row
    assert relay.rotated and relay.x1 - relay.x0 == pytest.approx(26)  # 50 mm long, turned


def test_a_module_longer_than_the_compartment_grows_the_free_end():
    spec = EnclosureSpec(board="arduino_nano", modules=[{"name": "big", "size": (90, 60)}])
    enc = build(spec)
    assert run_checks(enc) == []
    assert enc.layout.x1 > 90  # grew to the right, away from the USB on the left
    with pytest.raises(ValueError, match="both ends of the case are taken"):
        build(spec.model_copy(update={"battery": "2xAA"}))


def test_module_given_by_size_and_height():
    enc = build(EnclosureSpec(board="arduino_uno", modules=[{"name": "dfplayer", "size": (21, 21), "height": 8}]))
    [m] = enc.layout.modules
    assert m.top - m.pcb_top == 8 and m.module.mount == "end_supports"
    assert run_checks(enc) == []


def test_bad_modules_are_refused_or_reported():
    with pytest.raises(ValueError, match="needs a type"):
        EnclosureSpec(board="arduino_uno", modules=[{"name": "x"}])
    with pytest.raises(ValueError, match="unknown module"):
        build(EnclosureSpec(board="arduino_uno", modules=[{"name": "x", "type": "flux_capacitor"}]))
    # a module put by hand on top of the board
    enc = build(EnclosureSpec(board="arduino_uno", modules=[{"name": "rtc", "type": "ds3231", "position": (10, 10)}]))
    assert any("rtc overlaps the board" in v.message for v in errors(enc))


def test_modules_use_the_room_behind_a_shallow_battery():
    """A 2x18650 pack lies along the case at the front: the row of modules behind the board runs on behind it."""
    mods = [{"name": "relay1", "type": "relay"}, {"name": "rtc1", "type": "ds3231"}, {"name": "sd", "type": "microsd"}]
    with_battery = build(EnclosureSpec(board="arduino_uno", battery="2x18650", modules=mods))
    assert run_checks(with_battery) == []
    lay = with_battery.layout
    assert lay.battery[3] < get_board("arduino_uno").width  # the pocket is shallower than the board
    assert max(m.x1 for m in lay.modules) > lay.battery[0]  # a module sits behind the pocket
    assert len({m.y0 for m in lay.modules}) == 1  # one row, where the board's compartment alone needs two


def test_battery_turns_to_leave_room_for_the_modules():
    """Alone, 2xAA stands across the Uno's case; with two modules it lies along the front and they go behind it."""
    def lies_along_x(lay):
        x0, y0, x1, y1 = lay.battery
        return x1 - x0 > y1 - y0

    alone = make_layout(EnclosureSpec(board="arduino_uno", battery="2xAA"))
    mods = [{"name": "sd", "type": "microsd"}, {"name": "rtc1", "type": "ds3231"}]
    enc = build(EnclosureSpec(board="arduino_uno", battery="2xAA", modules=mods))
    assert run_checks(enc) == []
    assert not lies_along_x(alone) and lies_along_x(enc.layout)
    # the turn is worth it: the modules' row runs on behind the pocket instead of making the case deeper
    assert max(m.x1 for m in enc.layout.modules) > enc.layout.battery[0]


def test_modules_and_battery_together():
    enc = build(EnclosureSpec(board="arduino_uno", battery="1x18650", modules=[{"name": "rtc", "type": "ds3231"}, {"name": "bme", "type": "bme280"}]))
    assert run_checks(enc) == []
    rtc = enc.layout.modules[0]
    assert rtc.x1 < enc.layout.battery[0]  # stays in the board's compartment


def test_every_violation_has_a_code_the_editor_translates():
    """The editor shows checks in the user's language by `code`: each code needs an English and a Russian text."""
    source = (REPO / "backend/app/services/enclosure/checks.py").read_text()
    codes = set(re.findall(r'_v\(\s*"(?:error|warning)", "[^"]+", "([a-z_]+)"', source))
    codes |= set(re.findall(r'"(overhang_[a-z]+)"', source))
    assert len(codes) >= 20
    for lang in ("en", "ru"):
        texts = json.loads((REPO / f"frontend/src/i18n/locales/{lang}/common.json").read_text())["enclosure"]["violation"]
        assert codes <= set(texts), (lang, sorted(codes - set(texts)))
    # and the checks fill it in: a few broken cases, every violation coded
    found = [v for spec in (
        EnclosureSpec(board="arduino_uno", wall=0.8, bed=(60, 60, 60)),
        EnclosureSpec(board="arduino_uno", top_clearance=0.5),
        EnclosureSpec(board="arduino_uno", modules=[{"name": "rtc", "type": "ds3231", "position": (10, 10)}]),
    ) for v in run_checks(build(spec))]
    assert found and all(v.code in codes for v in found)
    overlap = next(v for v in found if v.code == "module_overlap")
    assert overlap.params == {"name": "rtc", "what_kind": "board", "what_name": ""}


def test_render_png():
    png = render_png(build(EnclosureSpec(board="arduino_nano", lid="snap")))
    assert png[:8] == b"\x89PNG\r\n\x1a\n" and len(png) > 20_000


def test_export_includes_the_hatch(tmp_path):
    enc = build(EnclosureSpec(board="arduino_uno", battery="2xAA", battery_hatch=True))
    names = {p.name for p in export_mod.export(enc, tmp_path / "h", ["stl", "step"])}
    assert {"hatch.stl", "hatch.step"} <= names


def test_export_lid_is_flipped_onto_bed(tmp_path):
    enc = build(EnclosureSpec(board="esp32_devkitc"))
    paths = export_mod.export(enc, tmp_path / "t", ["stl", "step"])
    assert {p.name for p in paths} == {"base.stl", "lid.stl", "base.step", "lid.step", "spec.json"}
    lid = import_stl(str(tmp_path / "t" / "lid.stl"))
    bb = lid.bounding_box()
    assert abs(bb.min.Z) < 1e-6
    # flat top of the lid is on the bed: the lip points up
    assert bb.size.Z == pytest.approx(enc.layout.spec.lid_thickness + 2.0, abs=0.05)


# ── /api/enclosure route (called directly, like the other route tests) ──────


def stl_triangles(data: bytes) -> int:
    """Binary STL: 80-byte header, uint32 count, 50 bytes per triangle."""
    (count,) = struct.unpack_from("<I", data, 80)
    assert len(data) == 84 + 50 * count
    return count


def test_route_lists_boards():
    res = asyncio.run(route.list_boards())
    boards = res["boards"]
    assert [b["id"] for b in boards] == BOARDS
    assert {b["id"] for b in res["batteries"]} == set(BATTERIES)
    assert [m["id"] for m in res["modules"]] == MODULES
    assert next(b for b in res["batteries"] if b["id"] == "9V")["height"] == 18
    uno = next(b for b in boards if b["id"] == "arduino_uno")
    assert {c["name"] for c in uno["connectors"]} == {"usb", "power"}


def test_route_build_returns_checks_render_and_meshes():
    res = asyncio.run(route.build_enclosure(route.BuildRequest(spec=EnclosureSpec(board="arduino_uno"))))
    assert res["ok"] and res["violations"] == []
    assert res["board"]["id"] == "arduino_uno" and res["weight_g"] > 0
    assert base64.b64decode(res["render_png"])[:4] == b"\x89PNG"
    base, lid = base64.b64decode(res["base_stl"]), base64.b64decode(res["lid_stl"])
    assert stl_triangles(base) > 100 and stl_triangles(lid) > 10
    assert stl_triangles(base64.b64decode(res["pcb_stl"])) >= 12
    assert stl_triangles(base64.b64decode(res["connectors_stl"])) >= 24  # usb + power boxes
    assert res["battery_stl"] is None and res["modules"] == [] and res["modules_stl"] is None
    with_module = asyncio.run(route.build_enclosure(route.BuildRequest(
        spec=EnclosureSpec(board="arduino_uno", modules=[{"name": "rtc", "type": "ds3231"}]), render=False)))
    assert with_module["modules"][0]["name"] == "rtc" and with_module["modules"][0]["type"] == "ds3231"
    assert stl_triangles(base64.b64decode(with_module["modules_stl"])) == 12
    with_display = asyncio.run(route.build_enclosure(route.BuildRequest(
        spec=EnclosureSpec(board="arduino_uno", lid_modules=[{"name": "lcd", "type": "lcd1602"}]), render=False)))
    [lcd] = with_display["lid_modules"]
    assert lcd["type"] == "lcd1602" and len(lcd["window"]) == 4
    assert stl_triangles(base64.b64decode(with_display["lid_modules_stl"])) == 24  # PCB block + display block
    with_hatch = asyncio.run(route.build_enclosure(route.BuildRequest(
        spec=EnclosureSpec(board="arduino_uno", battery="2xAA", battery_hatch=True), render=False)))
    assert with_hatch["ok"] and stl_triangles(base64.b64decode(with_hatch["hatch_stl"])) > 12
    with_battery = asyncio.run(route.build_enclosure(route.BuildRequest(spec=EnclosureSpec(board="arduino_nano", battery="9V"), render=False)))
    assert with_battery["ok"] and stl_triangles(base64.b64decode(with_battery["battery_stl"])) == 12
    # meshes are in assembly position: the lid's top is the top of the outer box
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "lid.stl"
        path.write_bytes(lid)
        assert import_stl(str(path)).bounding_box().max.Z == pytest.approx(res["outer"]["z1"], abs=0.01)


def test_route_build_lists_connector_windows():
    req = route.BuildRequest(spec=EnclosureSpec(board="arduino_uno", skip_connectors=["power"]), render=False, meshes=False)
    res = asyncio.run(route.build_enclosure(req))
    by_name = {c["name"]: c for c in res["connectors"]}
    assert by_name["power"]["window"] is None
    # USB-B 12.08 x 10.9 plus 0.5 tolerance on every edge
    assert by_name["usb"] == {"name": "usb", "type": "usb_b", "side": "left", "window": {"width": 13.08, "height": 11.9}}


def test_route_build_says_where_openings_can_go():
    req = route.BuildRequest(spec=EnclosureSpec(board="arduino_uno"), render=False, meshes=False)
    faces = asyncio.run(route.build_enclosure(req))["faces"]
    lay = build(EnclosureSpec(board="arduino_uno")).layout
    assert faces["left"]["along"] == pytest.approx([lay.y0, lay.y1], abs=0.01)
    assert faces["front"]["along"] == pytest.approx([lay.x0, lay.x1], abs=0.01)
    assert faces["top"] == {"x": pytest.approx([lay.x0, lay.x1], abs=0.01), "y": pytest.approx([lay.y0, lay.y1], abs=0.01)}
    zmin, zmax = faces["left"]["z"]
    assert zmin < 0 < zmax  # from the floor, below the PCB top, up to under the lid lip
    # a hole in the middle of the left wall, as the faces describe it, passes every check
    mid = {"face": "left", "diameter": 6, "along": sum(faces["left"]["along"]) / 2, "z": (0 + zmax) / 2}
    assert errors(build(EnclosureSpec(board="arduino_uno", skip_connectors=["usb", "power"], extras=[mid]))) == []


def test_route_build_without_render_and_meshes():
    req = route.BuildRequest(spec=EnclosureSpec(board="arduino_nano", wall=0.8), render=False, meshes=False)
    res = asyncio.run(route.build_enclosure(req))
    assert all(res[k] is None for k in ("render_png", "base_stl", "lid_stl", "pcb_stl", "connectors_stl", "battery_stl"))
    assert not res["ok"] and any(v["check"] == "thickness" for v in res["violations"])


@pytest.mark.parametrize("spec, status", [
    (EnclosureSpec(board="no_such_board"), 404),
    (EnclosureSpec(board="arduino_uno", skip_connectors=["hdmi"]), 422),
    (EnclosureSpec(board="arduino_uno", extras=[
        {"face": "top", "diameter": 3, "center_x": 10, "center_y": 10}] * (route.MAX_EXTRAS + 1)), 422),
])
def test_route_build_rejects_bad_spec(spec, status):
    with pytest.raises(HTTPException) as exc:
        asyncio.run(route.build_enclosure(route.BuildRequest(spec=spec, render=False, meshes=False)))
    assert exc.value.status_code == status


def test_route_export_zips_print_files():
    resp = asyncio.run(route.export_enclosure(route.ExportRequest(spec=EnclosureSpec(board="esp32_devkitc"))))
    assert resp.media_type == "application/zip"
    with zipfile.ZipFile(io.BytesIO(resp.body)) as zf:
        assert set(zf.namelist()) == {"base.stl", "lid.stl", "base.step", "lid.step", "spec.json"}
        assert EnclosureSpec.model_validate_json(zf.read("spec.json")).board == "esp32_devkitc"


def test_route_export_refuses_failing_enclosure():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(route.export_enclosure(route.ExportRequest(spec=EnclosureSpec(board="arduino_uno", bed=(60, 60, 60)))))
    assert exc.value.status_code == 422
    assert any("bed" in e for e in exc.value.detail["errors"])
