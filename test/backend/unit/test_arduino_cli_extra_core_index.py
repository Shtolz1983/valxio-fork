"""Regression test - an overlay-registered core gets its index URL before install.

Reported on velxio.dev for every XIAO display example:

    Invalid argument passed: Platform 'Seeeduino:nrf52' not found
    Failed to install required core: Seeeduino:nrf52

Root cause: ``compile.py`` builds its ``ArduinoCLIService`` at import time, and
``__init__`` registers the board-manager URLs it knows about right then. The
overlay's ``register_extra_core()`` runs later (``register_pro`` is called at
the end of ``main.py``), so the extra core's index URL never reached the
arduino-cli config and the on-demand ``core install`` could not resolve the
platform.

Pure Python: ``subprocess.run`` is replaced, nothing shells out.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

_REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_REPO / "backend"))

from app.services import arduino_cli  # noqa: E402

SEEED_INDEX = "https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json"
FQBN = "Seeeduino:nrf52:xiaonRF52840Plus"


@pytest.fixture
def calls(monkeypatch):
    seen: list[list[str]] = []

    def _run(cmd, *args, **kwargs):
        seen.append(list(cmd))
        return SimpleNamespace(returncode=0, stdout="{}", stderr="")

    monkeypatch.setattr(arduino_cli.subprocess, "run", _run)
    monkeypatch.setattr(arduino_cli, "_EXTRA_CORES", {})
    return seen


def _service_built_before_the_overlay():
    # What compile.py does at import: construct with no extra core registered.
    return arduino_cli.ArduinoCLIService()


def _index(calls, *cmd_tail):
    for i, cmd in enumerate(calls):
        if cmd[1:1 + len(cmd_tail)] == list(cmd_tail):
            return i
    return -1


def test_the_index_is_registered_before_the_install(calls):
    svc = _service_built_before_the_overlay()
    arduino_cli.register_extra_core("Seeeduino:nrf52", SEEED_INDEX)
    svc._installed_cores = ""  # core list says nothing is installed
    calls.clear()

    status = asyncio.run(svc.ensure_core_for_board(FQBN))

    assert status["installed"] is True
    add = _index(calls, "config", "add", "board_manager.additional_urls", SEEED_INDEX)
    update = _index(calls, "core", "update-index")
    install = _index(calls, "core", "install", "Seeeduino:nrf52")
    assert add != -1, "the Seeed index URL was never added to the config"
    assert install != -1
    assert add < update < install


def test_a_registered_index_is_not_added_again(calls):
    arduino_cli.register_extra_core("Seeeduino:nrf52", SEEED_INDEX)
    svc = arduino_cli.ArduinoCLIService()  # built after: __init__ saw the URL
    svc._installed_cores = ""
    calls.clear()

    asyncio.run(svc.ensure_core_for_board(FQBN))

    assert _index(calls, "config", "add") == -1
    assert _index(calls, "core", "install", "Seeeduino:nrf52") != -1


def test_builtin_boards_are_untouched(calls):
    svc = _service_built_before_the_overlay()
    calls.clear()

    status = asyncio.run(svc.ensure_core_for_board("arduino:avr:uno"))

    assert status["needed"] is False
    assert calls == []
