import asyncio
import base64
import io
import re
import struct
import tempfile
import zipfile
from pathlib import Path

import pytest
from build123d import import_stl
from fastapi import HTTPException

from app.api.routes import enclosure as route
from app.services.enclosure import export as export_mod
from app.services.enclosure.batteries import CATALOG as BATTERIES
from app.services.enclosure.checks import check_collisions, run_checks
from app.services.enclosure.enclosure import build, build_board_parts, build_keepouts, make_layout
from app.services.enclosure.registry import get_board, load_boards
from app.services.enclosure.render import render_png
from app.services.enclosure.spec import EnclosureSpec

BOARDS = sorted(load_boards())
REPO = Path(__file__).resolve().parents[3]


def errors(enc):
    return [v for v in run_checks(enc) if v.severity == "error"]


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


def test_render_png():
    png = render_png(build(EnclosureSpec(board="arduino_nano", lid="snap")))
    assert png[:8] == b"\x89PNG\r\n\x1a\n" and len(png) > 20_000


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
    assert res["battery_stl"] is None
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
