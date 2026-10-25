"""Sensor/module knowledge cards, one JSON file per part in the parts-catalog
directory (the repo's `parts-catalog/`, bind-mounted into the container so
cards the AI adds land in the working tree and can be reviewed and committed).

The editor reads every card at startup (catalogue, canvas art, validator and
AI facts); the AI bridge writes drafts; the catalogue dialog confirms or
deletes them. The card format is documented in parts-catalog/README.md — this
route checks only what it needs to store a card safely.
"""
import json
import os
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException

router = APIRouter()

CARD_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,48}$")
MAX_CARD_BYTES = 64 * 1024


def catalog_dir() -> Path:
    configured = os.environ.get("PARTS_CATALOG_DIR")
    if configured:
        return Path(configured)
    # Local (non-Docker) runs: <repo>/parts-catalog next to backend/.
    return Path(__file__).resolve().parents[4] / "parts-catalog"


def _card_path(card_id: str) -> Path:
    if not CARD_ID_RE.match(card_id):
        raise HTTPException(status_code=400, detail=f"Invalid card id {card_id!r}: use a-z, 0-9 and '-'")
    return catalog_dir() / f"{card_id}.json"


@router.get("/")
async def list_cards():
    folder = catalog_dir()
    cards = []
    errors = []
    if folder.is_dir():
        for path in sorted(folder.glob("*.json")):
            try:
                card = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as e:
                errors.append(f"{path.name}: {e}")
                continue
            if isinstance(card, dict) and card.get("id") == path.stem:
                cards.append(card)
            else:
                errors.append(f"{path.name}: \"id\" must equal the file name")
    return {"cards": cards, "errors": errors}


@router.put("/{card_id}")
async def save_card(card_id: str, card: dict):
    path = _card_path(card_id)
    if card.get("id") != card_id:
        raise HTTPException(status_code=400, detail="\"id\" in the body must equal the id in the URL")
    for field in ("name", "group", "status"):
        if not isinstance(card.get(field), str) or not card[field].strip():
            raise HTTPException(status_code=400, detail=f"\"{field}\" is required")
    if card["status"] not in ("verified", "draft"):
        raise HTTPException(status_code=400, detail="\"status\" must be \"verified\" or \"draft\"")
    text = json.dumps(card, ensure_ascii=False, indent=2) + "\n"
    if len(text.encode("utf-8")) > MAX_CARD_BYTES:
        raise HTTPException(status_code=413, detail="Card is too large")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)
    return {"saved": card_id}


@router.delete("/{card_id}")
async def delete_card(card_id: str):
    path = _card_path(card_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"No card {card_id!r}")
    path.unlink()
    return {"deleted": card_id}
