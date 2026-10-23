"""The chip-nets fixture models, compiled on demand.

The `.wasm` for `frontend/src/components/customChips/examples/<name>.c` is not checked in:
velxio compiles chips itself, so the tests ask the same service the
`POST /api/compile-chip/` route uses (clang from the wasi-sdk the image
ships). Compiled once per session and cached. Where no wasi-sdk is
installed the callers skip rather than fail, exactly as they did when the
binary was missing.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

# The models live with the gallery examples (the designer lists them); the
# fixture directory keeps their README, licence and the standalone self test.
EXAMPLES = (Path(__file__).parent.parent.parent.parent / 'frontend' / 'src'
            / 'components' / 'customChips' / 'examples')

_cache: dict[str, bytes] = {}


def chips_available() -> bool:
    try:
        from app.services.chip_compile import chip_compile_service
    except Exception:
        return False
    return bool(chip_compile_service.available)


def compiled_chip(name: str) -> bytes:
    """WASM bytes for fixture model `name` ('sx1262', 'kq130f')."""
    if name in _cache:
        return _cache[name]
    if not chips_available():
        pytest.skip('wasi-sdk not available to compile the chip fixtures')
    from app.services.chip_compile import chip_compile_service
    import base64
    source = (EXAMPLES / f'{name}.c').read_text(encoding='utf-8')
    result = asyncio.run(chip_compile_service.compile(source))
    if not result['success']:
        raise RuntimeError(f'{name}/chip.c did not compile: {result["error"]}\n{result["stderr"]}')
    wasm = base64.b64decode(result['wasm_base64'])
    _cache[name] = wasm
    return wasm
