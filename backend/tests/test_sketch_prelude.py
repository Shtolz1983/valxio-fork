"""A core's prelude must survive a sketch that only TALKS about the include.

The XIAO nRF52840 core does not link `Serial` without the Adafruit TinyUSB
header, so the backend prepends it (register_extra_core). The "is it already
there?" guard was a plain substring match, and the gallery sketch carried a
comment naming the include, so the guard said yes, the line was never added,
and every example for that board failed to link with "undefined reference to
`Serial'" — in production, until 2026-09-17.
"""

from app.services.arduino_cli import _has_prelude, _strip_comments

PRELUDE = "#include <Adafruit_TinyUSB.h>\n"


def test_a_comment_naming_the_include_is_not_the_include():
    sketch = (
        "// On hardware this core also needs #include <Adafruit_TinyUSB.h>\n"
        "// before Serial will link.\n"
        "void setup() { Serial.begin(115200); }\n"
    )
    assert not _has_prelude(sketch, PRELUDE)


def test_a_block_comment_does_not_count_either():
    sketch = "/* #include <Adafruit_TinyUSB.h> */\nvoid setup() {}\n"
    assert not _has_prelude(sketch, PRELUDE)


def test_the_real_include_counts_and_is_not_duplicated():
    sketch = "#include <Adafruit_TinyUSB.h>\nvoid setup() {}\n"
    assert _has_prelude(sketch, PRELUDE)


def test_strip_comments_keeps_the_code():
    assert "void setup()" in _strip_comments("// note\nvoid setup() {}\n")
    assert "note" not in _strip_comments("// note\nvoid setup() {}\n")


def test_an_unterminated_comment_does_not_hang_or_eat_the_file():
    assert _strip_comments("/* open\nvoid setup() {}") == ""
    assert _strip_comments("void setup() {} // trailing") == "void setup() {} "
