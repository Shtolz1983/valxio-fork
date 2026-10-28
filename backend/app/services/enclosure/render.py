"""Headless PNG render: own orthographic projection + painter's algorithm drawn with matplotlib.

Axis-aligned views keep board coordinates on the axes, so positions can be read straight off the picture.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import matplotlib.ticker  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.collections import PolyCollection  # noqa: E402

from .enclosure import Enclosure  # noqa: E402

COLORS = {
    "base": (0.55, 0.62, 0.72, 1.0),
    "lid": (0.72, 0.68, 0.58, 1.0),
    "pcb": (0.15, 0.55, 0.30, 1.0),
    "connector": (0.95, 0.55, 0.10, 1.0),
    "battery": (0.30, 0.36, 0.55, 1.0),
}
EXPLODE = 12.0  # mm the lid is lifted in the isometric view


@dataclass(frozen=True)
class View:
    title: str
    right: tuple[float, float, float]
    up: tuple[float, float, float]
    axis_labels: tuple[str, str] | None = None  # set for axis-aligned views


def _unit(v) -> np.ndarray:
    v = np.asarray(v, dtype=float)
    return v / np.linalg.norm(v)


ISO = View("ISO (front-left, lid lifted)", tuple(_unit((1, -1, 0))), tuple(_unit((1, 1, 2))))
VIEWS = {
    "top": View("TOP (no lid)", (1, 0, 0), (0, 1, 0), ("X", "Y")),
    "lid": View("LID from above", (1, 0, 0), (0, 1, 0), ("X", "Y")),
    "left": View("LEFT side (X=0)", (0, -1, 0), (0, 0, 1), ("Y", "Z")),
    "right": View("RIGHT side", (0, 1, 0), (0, 0, 1), ("Y", "Z")),
    "front": View("FRONT side (Y=0)", (1, 0, 0), (0, 0, 1), ("X", "Z")),
    "back": View("BACK side", (-1, 0, 0), (0, 0, 1), ("X", "Z")),
}


def _mesh(part, tolerance: float = 0.15) -> tuple[np.ndarray, np.ndarray]:
    verts, tris = part.tessellate(tolerance, 0.3)
    v = np.array([[p.X, p.Y, p.Z] for p in verts])
    return v, np.array(tris, dtype=int)


def _parts_for(enc: Enclosure, view_key: str) -> list[tuple[str, np.ndarray, np.ndarray]]:
    meshes = []
    if view_key == "lid":
        v, t = _mesh(enc.lid)
        return [("lid", v, t)]
    base_v, base_t = _mesh(enc.base)
    meshes.append(("base", base_v, base_t))
    for name, part in enc.board_parts.items():
        v, t = _mesh(part, 0.3)
        meshes.append((name if name in ("pcb", "battery") else "connector", v, t))
    if view_key == "iso":
        v, t = _mesh(enc.lid)
        meshes.append(("lid", v + np.array([0, 0, EXPLODE]), t))
    return meshes


def _subdivide(tri: np.ndarray, normals: np.ndarray, max_edge: float) -> tuple[np.ndarray, np.ndarray]:
    """Split triangles along their longest edge until every edge is short; keeps painter's sorting honest.

    The original normal rides along as a 4th row so slivers keep a clean shading normal.
    """
    tri = np.concatenate([tri, normals[:, None, :]], axis=1)
    done = []
    for _ in range(12):
        edges = np.stack([
            np.linalg.norm(tri[:, 1] - tri[:, 0], axis=1),
            np.linalg.norm(tri[:, 2] - tri[:, 1], axis=1),
            np.linalg.norm(tri[:, 0] - tri[:, 2], axis=1),
        ], axis=1)
        big = edges.max(axis=1) > max_edge
        done.append(tri[~big])
        tri = tri[big]
        if not len(tri):
            break
        k = edges[big].argmax(axis=1)  # longest edge i -> (i, i+1)
        idx = np.arange(len(tri))
        a, b, c, n = tri[idx, k], tri[idx, (k + 1) % 3], tri[idx, (k + 2) % 3], tri[:, 3]
        m = (a + b) / 2
        tri = np.concatenate([np.stack([a, m, c, n], axis=1), np.stack([m, b, c, n], axis=1)])
    done.append(tri)
    out = np.concatenate(done)
    return out[:, :3], out[:, 3]


def _draw(ax, meshes, view: View) -> None:
    right, up = _unit(view.right), _unit(view.up)
    toward = np.cross(right, up)  # points at the viewer
    light = _unit(toward + 0.6 * up + 0.4 * right)
    polys, colors, depths = [], [], []
    for kind, v, t in meshes:
        tri = v[t]  # (n, 3, 3)
        normals = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        lengths = np.linalg.norm(normals, axis=1)
        keep = lengths > 1e-12
        tri, normals = tri[keep], normals[keep] / lengths[keep, None]
        facing = normals @ toward > 1e-6
        tri, normals = _subdivide(tri[facing], normals[facing], 3.0)
        shade = 0.35 + 0.65 * np.clip(normals @ light, 0, 1)
        base = np.array(COLORS[kind][:3])
        polys.append(np.stack([tri @ right, tri @ up], axis=-1))
        colors.append(shade[:, None] * base)
        depths.append((tri @ toward).mean(axis=1))
    if not polys:
        return
    polys, colors, depths = np.concatenate(polys), np.concatenate(colors), np.concatenate(depths)
    # depth cue: far surfaces darker, so openings stand out against the opposite inner wall
    near = (depths - depths.min()) / max(np.ptp(depths), 1e-9)
    colors = np.clip(colors * (0.55 + 0.45 * near[:, None]), 0, 1)
    order = np.argsort(depths)  # far first
    ax.add_collection(PolyCollection(polys[order], facecolors=colors[order], edgecolors=colors[order], linewidths=0.5, antialiased=False))
    pts = polys.reshape(-1, 2)
    pad = 3
    ax.set_xlim(pts[:, 0].min() - pad, pts[:, 0].max() + pad)
    ax.set_ylim(pts[:, 1].min() - pad, pts[:, 1].max() + pad)
    ax.set_aspect("equal")
    ax.set_title(view.title, fontsize=10)


def _finish_axes(ax, view: View) -> None:
    if view.axis_labels is None:
        ax.set_axis_off()
        return
    if sum(view.right) < 0:
        # projected u is the negated board coordinate; label ticks with the real board value
        ax.xaxis.set_major_formatter(matplotlib.ticker.FuncFormatter(lambda x, _: f"{-x:g}"))
    ax.set_xlabel(f"{view.axis_labels[0]} (mm)", fontsize=8)
    ax.set_ylabel(f"{view.axis_labels[1]} (mm)", fontsize=8)
    ax.tick_params(labelsize=7)
    ax.grid(True, linewidth=0.3, alpha=0.5)


def _label_openings(ax, enc: Enclosure, view_key: str) -> None:
    for o in enc.openings:
        if o.side != view_key:
            continue
        a = (o.along0 + o.along1) / 2
        # 'left' and 'back' views have right = -Y / -X, projected coordinate is the negated board coordinate
        u = -a if view_key in ("left", "back") else a
        ax.annotate(o.name, (u, o.z1), xytext=(0, 6), textcoords="offset points", ha="center", fontsize=7, color="crimson")


def _label_top(ax, enc: Enclosure, view_key: str) -> None:
    for e in enc.layout.spec.extras:
        if e.face == "top" and view_key == "lid":
            ax.annotate(e.name or e.shape, (e.center_x, e.center_y), xytext=(0, 8), textcoords="offset points",
                        ha="center", fontsize=7, color="crimson")


def render_png(enc: Enclosure, dpi: int = 90) -> bytes:
    fig, axes = plt.subplots(2, 4, figsize=(18, 8.5))
    keys = ["iso", "top", "lid", None, "left", "right", "front", "back"]
    for ax, key in zip(axes.flat, keys):
        if key is None:
            _summary_panel(ax, enc)
            continue
        view = ISO if key == "iso" else VIEWS[key]
        _draw(ax, _parts_for(enc, key), view)
        _finish_axes(ax, view)
        _label_openings(ax, enc, key)
        _label_top(ax, enc, key)
    fig.suptitle(f"{enc.layout.board.name} — {enc.layout.spec.lid} lid", fontsize=12)
    fig.tight_layout()
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=dpi)
    plt.close(fig)
    return buf.getvalue()


def _summary_panel(ax, enc: Enclosure) -> None:
    lay = enc.layout
    ox0, oy0, ox1, oy1 = lay.outer()
    lines = [
        f"outer: {ox1 - ox0:.1f} x {oy1 - oy0:.1f} x {lay.lid_top:.1f} mm",
        f"cavity X {lay.x0:.1f}..{lay.x1:.1f}, Y {lay.y0:.1f}..{lay.y1:.1f}",
        f"floor top Z {lay.floor_top:.1f}, PCB {lay.board_bottom:.1f}..{lay.pcb_top:.1f}",
        f"lid seat Z {lay.z_top:.1f}",
        f"plastic ~{enc.weight_g:.0f} g PLA",
        f"battery: {lay.spec.battery} ({lay.spec.battery_side} end)" if lay.battery else "battery: none",
        "",
        "orange = connectors, green = PCB, blue = battery",
        "origin = PCB lower-left corner",
    ]
    ax.text(0.02, 0.95, "\n".join(lines), va="top", family="monospace", fontsize=9, transform=ax.transAxes)
    ax.set_axis_off()
