"""File names a client sends must stay inside the build dir (2026-09-15).

The ESP-IDF Arduino-mode writer and the SPIFFS writer joined the raw name
under a shared build dir as root; the API now refuses '..', absolute paths and
NUL bytes for every lane, while folder prefixes keep working.

Run from the repo root:
    python -m pytest test/backend/unit/test_compile_file_names.py -v
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'backend'))

from pydantic import ValidationError  # noqa: E402

from app.api.routes.compile import SketchFile, SpiffsFileBody  # noqa: E402


class FileNameValidationTests(unittest.TestCase):
    def test_plain_names_and_folder_prefixes_are_accepted(self):
        for name in ('sketch.ino', 'main.cpp', 'src/helper.cpp', 'data/config.json'):
            self.assertEqual(SketchFile(name=name, content='').name, name)
            self.assertEqual(SpiffsFileBody(name=name, content_b64='').name, name)

    def test_names_that_leave_the_build_dir_are_refused(self):
        for bad in ('../x.cpp', 'a/../../x.h', '/etc/passwd', '\\\\server\\x', 'C:\\x.cpp', 'a\x00b', '..\\x.h'):
            with self.assertRaises(ValidationError, msg=bad):
                SketchFile(name=bad, content='')
            with self.assertRaises(ValidationError, msg=bad):
                SpiffsFileBody(name=bad, content_b64='')


if __name__ == '__main__':
    unittest.main()
