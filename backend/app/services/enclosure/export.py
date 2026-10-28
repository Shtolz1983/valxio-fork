"""Write print files: STL in print orientation, STEP in assembly position, plus the spec and a render."""

from __future__ import annotations

from pathlib import Path

from build123d import export_step, export_stl

from .checks import flip_for_print
from .enclosure import Enclosure

FORMATS = ("stl", "step")


def export(enc: Enclosure, out: Path, formats: list[str], png: bytes | None = None) -> list[Path]:
    unknown = set(formats) - set(FORMATS)
    if unknown:
        raise ValueError(f"unknown formats {sorted(unknown)}; supported: {FORMATS}")
    out.mkdir(parents=True, exist_ok=True)
    written = []
    if "stl" in formats:
        for part_name, part in enc.printed_parts():
            part = flip_for_print(part) if part_name == "lid" else part  # the hatch prints as fitted, outside down
            path = out / f"{part_name}.stl"
            export_stl(part, str(path), tolerance=0.01, angular_tolerance=0.1)
            written.append(path)
    if "step" in formats:
        for part_name, part in enc.printed_parts():
            path = out / f"{part_name}.step"
            export_step(part, str(path))
            written.append(path)
    spec_path = out / "spec.json"
    spec_path.write_text(enc.layout.spec.model_dump_json(indent=2))
    written.append(spec_path)
    if png:
        png_path = out / "render.png"
        png_path.write_bytes(png)
        written.append(png_path)
    return written
