"""Data models for boards and enclosure specifications.

Coordinate convention (shared by board data, the generator and the AI assistant):
  * Origin is the lower-left corner of the PCB seen from above.
  * X runs along the board's long edge, Y along the short edge, Z points up.
  * Sides: left (X=0), right (X=length), front (Y=0), back (Y=width), top, bottom.
  * Side positions are given as `center` along the side axis (Y for left/right,
    X for front/back) and `z` measured from the PCB top surface.
All dimensions are millimetres.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from .batteries import CATALOG as BATTERIES

Side = Literal["left", "right", "front", "back"]
Face = Literal["left", "right", "front", "back", "top", "bottom"]


class Connector(BaseModel):
    name: str
    type: str = Field(description="Catalog type, e.g. usb_b, usb_c, micro_usb, dc_jack")
    side: Side
    center: float = Field(description="Center along the side axis (Y for left/right, X for front/back)")
    z: float = Field(0.0, description="Bottom of the connector above the PCB top")
    width: float | None = Field(None, description="Size along the side; default from catalog")
    height: float | None = Field(None, description="Size along Z; default from catalog")
    overhang: float = Field(0.0, description="How far the connector sticks out past the PCB edge")
    depth: float | None = Field(None, description="Length from the face back into the board; default from catalog")


class Holes(BaseModel):
    diameter: float
    positions: list[tuple[float, float]]


class Board(BaseModel):
    id: str
    name: str
    canvas_kinds: list[str] = Field([], description="Velxio canvas board kinds this enclosure board fits")
    part_types: list[str] = Field([], description="Modules only: canvas part types this module is")
    source: str = ""
    verified: bool = Field(False, description="True once dimensions were checked against a real board")
    notes: str = ""
    size: tuple[float, float] = Field(description="Length (X), width (Y)")
    pcb_thickness: float = 1.6
    top_height: float = Field(description="Tallest component above the PCB top")
    bottom_clearance: float = Field(description="Free space needed under the PCB (solder joints, pins)")
    mount: Literal["standoffs", "end_supports"] = "standoffs"
    support_depth: float = Field(2.0, description="end_supports: how far the supports reach under each short end")
    holes: Holes | None = None
    connectors: list[Connector] = []

    @model_validator(mode="after")
    def _check(self) -> Board:
        if self.mount == "standoffs" and not (self.holes and self.holes.positions):
            raise ValueError("mount=standoffs requires mounting holes")
        names = [c.name for c in self.connectors]
        if len(names) != len(set(names)):
            raise ValueError("connector names must be unique")
        return self

    @property
    def length(self) -> float:
        return self.size[0]

    @property
    def width(self) -> float:
        return self.size[1]


class ExtraCutout(BaseModel):
    """A user-requested opening: LED hole, button, vents, cable port.

    top/bottom faces use center_x/center_y (board coordinates).
    Side faces use along (center along the side axis) and z (center above the PCB top).
    rect: width is along X (top/bottom) or along the side; height is along Y (top/bottom) or Z.
    slots: a row of vent slots, each width x height, slot_count of them spaced slot_pitch apart along X/along.
    """

    name: str = ""
    face: Face
    shape: Literal["circle", "rect", "slots"] = "circle"
    center_x: float | None = None
    center_y: float | None = None
    along: float | None = None
    z: float | None = None
    diameter: float | None = None
    width: float | None = None
    height: float | None = None
    slot_count: int = 5
    slot_pitch: float = 4.0

    @model_validator(mode="after")
    def _check(self) -> ExtraCutout:
        if self.face in ("top", "bottom"):
            if self.center_x is None or self.center_y is None:
                raise ValueError(f"{self.face} cutout needs center_x and center_y")
        elif self.along is None or self.z is None:
            raise ValueError(f"side cutout on {self.face} needs along and z")
        if self.shape == "circle" and not self.diameter:
            raise ValueError("circle cutout needs diameter")
        if self.shape in ("rect", "slots") and not (self.width and self.height):
            raise ValueError(f"{self.shape} cutout needs width and height")
        return self


class InsideModule(BaseModel):
    """A module that goes inside the case next to the board: from the module table (`type`) or by its size."""

    name: str = Field(description="The part id on the canvas; labels the render")
    type: str | None = Field(None, description="Module table id, e.g. ds3231; omit to give size and height")
    size: tuple[float, float] | None = Field(None, description="PCB length, width when there is no table entry")
    height: float | None = Field(None, description="Tallest part above its PCB; overrides the table")
    position: tuple[float, float] | None = Field(None, description="PCB lower-left corner in board coordinates; automatic when omitted")

    @model_validator(mode="after")
    def _check(self) -> InsideModule:
        if self.type is None and self.size is None:
            raise ValueError(f"module {self.name!r} needs a type from the module table or a size")
        return self


class EnclosureSpec(BaseModel):
    board: str = Field(description="Board id from list_boards")
    wall: float = Field(2.0, description="Side wall thickness")
    floor: float = Field(2.0, description="Floor thickness")
    lid_thickness: float = 2.0
    clearance: float = Field(1.0, description="Gap between PCB edge and inner wall")
    bottom_clearance: float | None = Field(None, description="Override the board's space under the PCB")
    top_clearance: float = Field(2.5, description="Gap between the tallest component and the lid")
    top_height: float | None = Field(None, description="Override the board's tallest component (perfboards: what is soldered on)")
    corner_radius: float = 3.0
    lid: Literal["screw", "snap"] = "screw"
    connector_tolerance: float = Field(0.5, description="Extra gap around each connector window")
    skip_connectors: list[str] = Field([], description="Connector names that get no window")
    extras: list[ExtraCutout] = []
    battery: str | None = Field(None, description="Battery compartment beside the board: a key of batteries.CATALOG")
    battery_side: Literal["left", "right"] = Field("right", description="End of the case the compartment sits at")
    modules: list[InsideModule] = Field([], description="Modules inside the case, placed beside the board")
    min_wall: float = Field(1.2, description="Thinnest printable wall (3 perimeters of a 0.4 nozzle)")
    bed: tuple[float, float, float] = Field((220.0, 220.0, 250.0), description="Printer build volume X, Y, Z")

    @field_validator("battery")
    @classmethod
    def _known_battery(cls, v: str | None) -> str | None:
        if v is not None and v not in BATTERIES:
            raise ValueError(f"unknown battery {v!r}; available: {', '.join(BATTERIES)}")
        return v
