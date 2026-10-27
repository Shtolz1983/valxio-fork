"""Board registry: built-in boards next to this module plus user boards from $ENCLOSURE_BOARDS_DIR."""

from __future__ import annotations

import os
from pathlib import Path

import yaml

from .spec import Board


BUILTIN_DIR = Path(__file__).parent / "boards"


def user_boards_dir() -> Path | None:
    """User boards are opt-in: without ENCLOSURE_BOARDS_DIR only the built-in boards load."""
    value = os.environ.get("ENCLOSURE_BOARDS_DIR")
    return Path(value) if value else None


def _builtin_files() -> list[Path]:
    return sorted(BUILTIN_DIR.glob("*.yaml"))


def _user_files() -> list[Path]:
    d = user_boards_dir()
    return sorted(d.glob("*.yaml")) if d and d.is_dir() else []


def load_boards() -> dict[str, Board]:
    """User boards override built-in boards with the same id."""
    boards: dict[str, Board] = {}
    for path in _builtin_files() + _user_files():
        board = Board.model_validate(yaml.safe_load(path.read_text()))
        boards[board.id] = board
    return boards


def get_board(board_id: str) -> Board:
    boards = load_boards()
    if board_id not in boards:
        raise KeyError(f"unknown board {board_id!r}; available: {', '.join(sorted(boards))}")
    return boards[board_id]


def save_user_board(yaml_text: str) -> Board:
    board = Board.model_validate(yaml.safe_load(yaml_text))
    d = user_boards_dir()
    if d is None:
        raise RuntimeError("ENCLOSURE_BOARDS_DIR is not set; nowhere to save user boards")
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{board.id}.yaml").write_text(yaml_text)
    return board
