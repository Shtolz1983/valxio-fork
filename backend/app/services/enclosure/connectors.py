"""Catalog of connector body sizes used when a board omits width/height/depth."""

from __future__ import annotations

from dataclasses import dataclass

from .spec import Board, Connector


@dataclass(frozen=True)
class ConnectorType:
    width: float
    height: float
    depth: float
    description: str


CATALOG: dict[str, ConnectorType] = {
    "usb_b": ConnectorType(12.0, 10.9, 16.0, "USB Type-B receptacle"),
    "usb_mini": ConnectorType(7.7, 4.0, 9.2, "Mini-USB receptacle"),
    "micro_usb": ConnectorType(7.5, 2.8, 5.5, "Micro-USB receptacle"),
    "usb_c": ConnectorType(8.9, 3.2, 7.4, "USB Type-C receptacle"),
    "dc_jack": ConnectorType(9.0, 11.0, 13.5, "5.5/2.1 mm barrel jack"),
    "pin_header": ConnectorType(2.54, 8.5, 2.54, "2.54 mm pin header, per pin"),
}


@dataclass(frozen=True)
class ResolvedConnector:
    """Connector with every size filled in."""

    name: str
    type: str
    side: str
    center: float
    z: float
    width: float
    height: float
    overhang: float
    depth: float


def resolve(c: Connector) -> ResolvedConnector:
    base = CATALOG.get(c.type)
    if base is None and None in (c.width, c.height, c.depth):
        raise ValueError(f"connector {c.name}: unknown type {c.type!r}, give width/height/depth explicitly")
    return ResolvedConnector(
        name=c.name,
        type=c.type,
        side=c.side,
        center=c.center,
        z=c.z,
        width=c.width if c.width is not None else base.width,
        height=c.height if c.height is not None else base.height,
        overhang=c.overhang,
        depth=c.depth if c.depth is not None else base.depth,
    )


def resolved_connectors(board: Board) -> list[ResolvedConnector]:
    return [resolve(c) for c in board.connectors]
