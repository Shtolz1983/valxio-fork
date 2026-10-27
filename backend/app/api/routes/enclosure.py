"""3D-printable enclosures for the board on the canvas (app/services/enclosure).

The AI assistant picks an EnclosureSpec; this route builds the geometry, runs
the printability checks and hands back what the editor and the model need:
the violations, a PNG render the model can look at, and binary STL meshes in
assembly position for the three.js viewer (base64, like compile's binaries).
/export returns the print files: STL with the lid flipped onto the bed, STEP
and the spec, zipped.

OpenCascade and matplotlib (pyplot) are not safe to drive from several threads
at once, so every job runs off the event loop behind one lock. A build takes
~0.1 s and a render ~2 s, so the queue never gets long.
"""
from __future__ import annotations

import asyncio
import base64
import io
import tempfile
import threading
import zipfile
from pathlib import Path

from build123d import export_stl
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from app.services.enclosure.checks import run_checks
from app.services.enclosure.enclosure import Enclosure, build
from app.services.enclosure.export import export
from app.services.enclosure.registry import get_board, load_boards
from app.services.enclosure.render import render_png
from app.services.enclosure.spec import EnclosureSpec

router = APIRouter()

MAX_EXTRAS = 64  # each extra is a boolean cut; keeps one request from tying up the lock
_lock = threading.Lock()


class BuildRequest(BaseModel):
    spec: EnclosureSpec
    render: bool = True  # PNG with eight views, for the model; ~2 s
    meshes: bool = True  # base + lid STL for the viewer


class ExportRequest(BaseModel):
    spec: EnclosureSpec
    step: bool = True


def _build(spec: EnclosureSpec) -> Enclosure:
    """Blocking; call under _lock. Bad input becomes an HTTP error the model can act on."""
    if len(spec.extras) > MAX_EXTRAS:
        raise HTTPException(status_code=422, detail=f"at most {MAX_EXTRAS} extras")
    try:
        board = get_board(spec.board)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e.args[0]))
    try:
        return build(spec, board)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


def _stl_b64(part) -> str:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "part.stl"
        export_stl(part, str(path), tolerance=0.01, angular_tolerance=0.1)
        return base64.b64encode(path.read_bytes()).decode()


def _build_job(req: BuildRequest) -> dict:
    with _lock:
        enc = _build(req.spec)
        violations = run_checks(enc)
        lay = enc.layout
        ox0, oy0, ox1, oy1 = lay.outer()
        result = {
            "ok": not any(v.severity == "error" for v in violations),
            "violations": [{"severity": v.severity, "check": v.check, "message": v.message} for v in violations],
            "board": {"id": lay.board.id, "name": lay.board.name, "verified": lay.board.verified},
            # Outer box in board coordinates: the viewer centres on it, the model quotes it.
            "outer": {"x0": ox0, "y0": oy0, "x1": ox1, "y1": oy1, "z0": 0.0, "z1": lay.lid_top},
            "weight_g": round(enc.weight_g, 1),
            "spec": req.spec.model_dump(),
            "render_png": None,
            "base_stl": None,
            "lid_stl": None,
        }
        if req.render:
            result["render_png"] = base64.b64encode(render_png(enc)).decode()
        if req.meshes:
            result["base_stl"] = _stl_b64(enc.base)
            result["lid_stl"] = _stl_b64(enc.lid)
        return result


def _export_job(req: ExportRequest) -> bytes:
    with _lock:
        enc = _build(req.spec)
        errors = [str(v) for v in run_checks(enc) if v.severity == "error"]
        if errors:
            # A case that collides with the board or misses the bed wastes a print.
            raise HTTPException(status_code=422, detail={"message": "the enclosure fails its checks", "errors": errors})
        with tempfile.TemporaryDirectory() as tmp:
            paths = export(enc, Path(tmp), ["stl", "step"] if req.step else ["stl"])
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                for path in paths:
                    zf.write(path, path.name)
        return buf.getvalue()


@router.get("/boards")
async def list_boards():
    boards = await asyncio.to_thread(load_boards)
    return {"boards": [b.model_dump() for b in sorted(boards.values(), key=lambda b: b.id)]}


@router.post("/build")
async def build_enclosure(req: BuildRequest):
    return await asyncio.to_thread(_build_job, req)


@router.post("/export")
async def export_enclosure(req: ExportRequest):
    data = await asyncio.to_thread(_export_job, req)
    filename = f"enclosure-{req.spec.board}.zip"
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
