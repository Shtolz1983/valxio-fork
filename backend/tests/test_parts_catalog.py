"""parts-catalog cards API: list, save, delete, and the id / field guards."""
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import parts_catalog


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PARTS_CATALOG_DIR", str(tmp_path))
    app = FastAPI()
    app.include_router(parts_catalog.router, prefix="/api/parts-catalog")
    return TestClient(app), tmp_path


CARD = {"id": "bme280", "name": "BME280", "group": "climate", "status": "draft", "pins": []}


def test_save_list_delete(client):
    c, folder = client
    assert c.put("/api/parts-catalog/bme280", json=CARD).status_code == 200
    assert json.loads((folder / "bme280.json").read_text())["name"] == "BME280"
    body = c.get("/api/parts-catalog/").json()
    assert [card["id"] for card in body["cards"]] == ["bme280"]
    assert c.delete("/api/parts-catalog/bme280").status_code == 200
    assert not (folder / "bme280.json").exists()
    assert c.delete("/api/parts-catalog/bme280").status_code == 404


def test_rejects_bad_ids_and_fields(client):
    c, folder = client
    assert c.put("/api/parts-catalog/..%2Fx", json={**CARD, "id": "../x"}).status_code in (400, 404)
    assert c.put("/api/parts-catalog/Bad_Id", json={**CARD, "id": "Bad_Id"}).status_code == 400
    assert c.put("/api/parts-catalog/bme280", json={**CARD, "id": "other"}).status_code == 400
    assert c.put("/api/parts-catalog/bme280", json={**CARD, "status": "final"}).status_code == 400
    assert c.put("/api/parts-catalog/bme280", json={k: v for k, v in CARD.items() if k != "name"}).status_code == 400
    assert list(folder.iterdir()) == []


def test_list_reports_broken_files(client):
    c, folder = client
    (folder / "good.json").write_text(json.dumps({**CARD, "id": "good"}))
    (folder / "broken.json").write_text("{nope")
    (folder / "renamed.json").write_text(json.dumps({**CARD, "id": "other"}))
    body = c.get("/api/parts-catalog/").json()
    assert [card["id"] for card in body["cards"]] == ["good"]
    assert len(body["errors"]) == 2
