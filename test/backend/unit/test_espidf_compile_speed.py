"""Compile-speed mechanics in espidf_compiler (2026-09).

Three things a warm ESP-IDF build depends on, none of which the toolchain is
needed to check:

  1. Generated configure inputs are written only when their bytes change, so
     ninja's RERUN_CMAKE rule does not fire for a file that is the same.
  2. Variant eviction never removes a directory whose lock is held, and
     replicas of a variant are named / keyed consistently in both directions.
  3. A failed ninja run on a warm dir is told apart as "configure trouble"
     (fall back to an explicit cmake) vs. an error in the user's code.

Run from the repo root:
    python -m pytest test/backend/unit/test_espidf_compile_speed.py -v
"""

import asyncio
import base64
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'backend'))

from app.services import espidf_compiler as ec  # noqa: E402


class WriteIfChangedTests(unittest.TestCase):
    def test_identical_bytes_keep_the_mtime(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'partitions.csv'
            p.write_text('a,b,c\n')
            old = time.time() - 3600
            os.utime(p, (old, old))
            self.assertFalse(ec._write_if_changed(p, 'a,b,c\n'))
            self.assertAlmostEqual(p.stat().st_mtime, old, delta=1)

    def test_different_bytes_are_written(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'partitions.csv'
            p.write_text('a,b,c\n')
            self.assertTrue(ec._write_if_changed(p, 'x\n'))
            self.assertEqual(p.read_text(), 'x\n')

    def test_missing_file_is_created(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'new.cmake'
            self.assertTrue(ec._write_if_changed(p, 'hi\n'))
            self.assertEqual(p.read_text(), 'hi\n')


class VariantNamingTests(unittest.TestCase):
    def test_dir_name_and_lock_key_round_trip(self):
        for replica in (0, 1, 3):
            name = ec._variant_dir_name('b6ef22a62ee4', replica)
            self.assertEqual(
                ec._lock_key_for_variant_dir('esp32', name),
                ec._variant_lock_key('esp32', 'b6ef22a62ee4', replica),
            )

    def test_replica_zero_keeps_the_legacy_name_and_key(self):
        self.assertEqual(ec._variant_dir_name('abc'), 'v_abc')
        self.assertEqual(ec._variant_lock_key('esp32s3', 'abc'), 'esp32s3/abc')
        self.assertEqual(ec._variant_dir_name('abc', 2), 'v_abc_r2')
        self.assertEqual(ec._variant_lock_key('esp32s3', 'abc', 2), 'esp32s3/abc/r2')

    def test_unrelated_dirs_have_no_key(self):
        self.assertIsNone(ec._lock_key_for_variant_dir('esp32', 'project'))


class EvictionTests(unittest.TestCase):
    def _make(self, root: Path, names: list[str]) -> None:
        for i, n in enumerate(names):
            d = root / n
            d.mkdir()
            stamp = time.time() - 1000 + i  # later names are warmer
            os.utime(d, (stamp, stamp))

    def test_locked_variant_is_never_evicted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'esp32'
            root.mkdir()
            # v_old is the coldest by mtime AND locked: eviction must skip it
            self._make(root, ['v_old', 'v_mid', 'v_new'])
            lock = ec._variant_lock(ec._variant_lock_key('esp32', 'old'))

            async def run() -> None:
                async with lock:
                    ec._evict_cold_variants(root, keep=2, idf_target='esp32')

            asyncio.run(run())
            self.assertTrue((root / 'v_old').exists(), 'evicted a variant under lock')
            self.assertFalse((root / 'v_mid').exists(), 'the next-coldest free one goes')
            self.assertTrue((root / 'v_new').exists())

    def test_replica_dirs_are_checked_against_their_own_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'esp32'
            root.mkdir()
            self._make(root, ['v_hot_r1', 'v_hot', 'v_other'])
            lock = ec._variant_lock(ec._variant_lock_key('esp32', 'hot', 1))

            async def run() -> None:
                async with lock:
                    ec._evict_cold_variants(root, keep=2, idf_target='esp32')

            asyncio.run(run())
            self.assertTrue((root / 'v_hot_r1').exists())
            self.assertFalse((root / 'v_hot').exists())

    def test_nothing_happens_under_the_cap(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'esp32'
            root.mkdir()
            self._make(root, ['v_a', 'v_b'])
            ec._evict_cold_variants(root, keep=6, idf_target='esp32')
            self.assertEqual(sorted(p.name for p in root.iterdir()), ['v_a', 'v_b'])

    def test_per_target_cap_from_env(self):
        with mock.patch.dict(os.environ, {'VELXIO_BUILD_VARIANTS_ESP32': '12'}):
            self.assertEqual(ec._max_build_variants('esp32'), 12)
            self.assertEqual(ec._max_build_variants('esp32s3'), ec._MAX_BUILD_VARIANTS)
        with mock.patch.dict(os.environ, {'VELXIO_BUILD_VARIANTS': '9'}):
            self.assertEqual(ec._max_build_variants('esp32c3'), 9)


class ReplicaPickTests(unittest.TestCase):
    def setUp(self) -> None:
        ec._VARIANT_COLLISIONS.clear()
        ec._WARMING_REPLICAS.clear()

    def test_free_base_replica_wins(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(ec, '_BUILD_ROOT', Path(tmp)), \
                mock.patch.dict(os.environ, {'VELXIO_BUILD_VARIANT_REPLICAS': '2'}):
            self.assertEqual(ec.ESPIDFCompiler._pick_replica('esp32', 'h1'), (0, None))

    def test_busy_base_goes_to_an_existing_free_replica(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(ec, '_BUILD_ROOT', Path(tmp)), \
                mock.patch.dict(os.environ, {'VELXIO_BUILD_VARIANT_REPLICAS': '2'}):
            (Path(tmp) / 'esp32' / 'v_h2_r1').mkdir(parents=True)
            lock = ec._variant_lock(ec._variant_lock_key('esp32', 'h2'))

            async def run() -> int:
                async with lock:
                    return ec.ESPIDFCompiler._pick_replica('esp32', 'h2')

            self.assertEqual(asyncio.run(run()), (1, None))

    def test_replica_is_warmed_only_after_a_collision_streak(self):
        """A busy variant queues on replica 0; the streak asks for r1 to be
        warmed in the background, and the job itself still builds in r0."""
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(ec, '_BUILD_ROOT', Path(tmp)), \
                mock.patch.dict(os.environ, {'VELXIO_BUILD_VARIANT_REPLICAS': '2'}):
            lock = ec._variant_lock(ec._variant_lock_key('esp32', 'h3'))

            async def run() -> list:
                picks = []
                async with lock:
                    for _ in range(ec._REPLICA_COLLISION_THRESHOLD):
                        picks.append(ec.ESPIDFCompiler._pick_replica('esp32', 'h3'))
                return picks

            picks = asyncio.run(run())
            self.assertEqual(picks[:-1], [(0, None)] * (ec._REPLICA_COLLISION_THRESHOLD - 1))
            self.assertEqual(picks[-1], (0, 1))

    def test_a_replica_being_warmed_is_neither_picked_nor_recreated(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(ec, '_BUILD_ROOT', Path(tmp)), \
                mock.patch.dict(os.environ, {'VELXIO_BUILD_VARIANT_REPLICAS': '2'}):
            (Path(tmp) / 'esp32' / 'v_h5_r1').mkdir(parents=True)
            ec._WARMING_REPLICAS.add(ec._variant_lock_key('esp32', 'h5', 1))
            lock = ec._variant_lock(ec._variant_lock_key('esp32', 'h5'))

            async def run() -> list:
                async with lock:
                    return [ec.ESPIDFCompiler._pick_replica('esp32', 'h5') for _ in range(5)]

            self.assertEqual(asyncio.run(run()), [(0, None)] * 5)

    def test_replicas_off_means_always_zero(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(ec, '_BUILD_ROOT', Path(tmp)), \
                mock.patch.dict(os.environ, {'VELXIO_BUILD_VARIANT_REPLICAS': '1'}):
            lock = ec._variant_lock(ec._variant_lock_key('esp32', 'h4'))

            async def run() -> list[int]:
                async with lock:
                    return [ec.ESPIDFCompiler._pick_replica('esp32', 'h4') for _ in range(5)]

            self.assertEqual(asyncio.run(run()), [(0, None)] * 5)


class NinjaArgsAndFallbackTests(unittest.TestCase):
    def test_no_env_means_ninjas_own_defaults(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('VELXIO_NINJA_JOBS', None)
            os.environ.pop('VELXIO_NINJA_LOAD_LIMIT', None)
            self.assertEqual(ec._ninja_parallelism_args(), [])

    def test_jobs_and_load_limit_from_env(self):
        with mock.patch.dict(os.environ, {'VELXIO_NINJA_JOBS': '4', 'VELXIO_NINJA_LOAD_LIMIT': '6'}):
            self.assertEqual(ec._ninja_parallelism_args(), ['-j', '4', '-l', '6.0'])

    def test_user_code_error_does_not_trigger_a_reconfigure(self):
        r = ec._RunResult(1, 'FAILED: esp-idf/main/sketch.ino.cpp.obj\n'
                             'sketch.ino.cpp:5:3: error: expected ; before }\n', '')
        self.assertFalse(ec._ninja_failure_wants_configure(r))

    def test_configure_trouble_triggers_a_reconfigure(self):
        for text in (
            'ninja: error: loading \'build.ninja\': No such file or directory',
            "ninja: error: 'sdkconfig', needed by 'build.ninja', missing and no known rule to make it",
            'CMake Error at /opt/esp-idf-v5/tools/cmake/build.cmake:123 (message):',
            'The downloaded component "espressif/mdns" is corrupted',
        ):
            r = ec._RunResult(1, text, '')
            self.assertTrue(ec._ninja_failure_wants_configure(r), text)


class NicePreexecTests(unittest.TestCase):
    def test_none_and_zero_inherit(self):
        self.assertIsNone(ec._nice_preexec(None))
        self.assertIsNone(ec._nice_preexec(0))

    def test_positive_nice_yields_a_callable(self):
        fn = ec._nice_preexec(10)
        self.assertTrue(callable(fn))



WRAPPER = '#include "Arduino.h"\nvoid setup();\nvoid loop();\nextern "C" void app_main(void) { setup(); }\n'


class UserMainNameTests(unittest.TestCase):
    def test_reserved_names_get_the_user_prefix_case_insensitively(self):
        self.assertEqual(ec._user_main_name('main.cpp'), 'user_main.cpp')
        self.assertEqual(ec._user_main_name('MAIN.CPP'), 'user_MAIN.CPP')
        self.assertEqual(ec._user_main_name('CMakeLists.txt'), 'user_CMakeLists.txt')

    def test_ordinary_names_are_untouched(self):
        for name in ('helper.cpp', 'config.h', 'main_menu.cpp'):
            self.assertEqual(ec._user_main_name(name), name)

    def test_names_never_leave_main(self):
        self.assertEqual(ec._user_main_name('../build/build.ninja'), 'build.ninja')
        self.assertEqual(ec._user_main_name('/tmp/escape.h'), 'escape.h')
        self.assertEqual(ec._user_main_name('src\\main.cpp'), 'user_main.cpp')
        self.assertEqual(ec._user_main_name('src/helper.cpp'), 'helper.cpp')
        for bad in ('', '.', '..', 'a/..'):
            self.assertIsNone(ec._user_main_name(bad), bad)


class ArduinoUserFilesTests(unittest.TestCase):
    """What lands in main/ in Arduino mode (2026-09-15: a helper named main.cpp
    overwrote the app_main wrapper and poisoned the shared variant dir)."""

    def _main(self, tmp: str) -> Path:
        main = Path(tmp) / 'main'
        main.mkdir()
        (main / 'main.cpp').write_text(WRAPPER)
        return main

    def test_a_helper_named_main_cpp_does_not_replace_the_wrapper(self):
        with tempfile.TemporaryDirectory() as tmp:
            main = self._main(tmp)
            files = [
                {'name': 'sketch.ino', 'content': 'void setup(){}\nvoid loop(){}\n'},
                {'name': 'main.cpp', 'content': 'int helperValue() { return 42; }\n'},
            ]
            self.assertIsNone(ec._write_arduino_user_files(main, files, None))
            self.assertEqual((main / 'main.cpp').read_text(), WRAPPER)
            self.assertIn('helperValue', (main / 'user_main.cpp').read_text())

    def test_a_user_app_main_replaces_the_wrapper(self):
        # Three saved projects: headers + a main.cpp with its own app_main and
        # no .ino. Keeping both entry points fails with "multiple definition".
        with tempfile.TemporaryDirectory() as tmp:
            main = self._main(tmp)
            files = [
                {'name': 'Card.h', 'content': '#pragma once\nint card();\n'},
                {'name': 'main.cpp', 'content': (
                    '#include "Arduino.h"\nvoid setup();\nvoid loop();\n'
                    'extern "C" void app_main() { initArduino(); setup(); for(;;) loop(); }\n'
                    'void setup() {}\nvoid loop() {}\n'
                )},
            ]
            self.assertIsNone(ec._write_arduino_user_files(main, files, files[0]))
            self.assertFalse((main / 'main.cpp').exists())
            self.assertTrue((main / 'user_main.cpp').is_file())
            # A header used as the entry is still written: others include it.
            self.assertTrue((main / 'Card.h').is_file())

    def test_a_commented_out_app_main_does_not_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            main = self._main(tmp)
            files = [{'name': 'helper.cpp', 'content': '// extern "C" void app_main(void) {}\nint x;\n'}]
            self.assertIsNone(ec._write_arduino_user_files(main, files, None))
            self.assertEqual((main / 'main.cpp').read_text(), WRAPPER)

    def test_the_entry_source_is_not_compiled_a_second_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            main = self._main(tmp)
            files = [{'name': 'main.c', 'content': 'void setup(){ Serial.begin(9600); }\nvoid loop(){}\n'}]
            self.assertIsNone(ec._write_arduino_user_files(main, files, files[0]))
            self.assertEqual(sorted(p.name for p in main.iterdir()), ['main.cpp'])

    def test_two_files_on_one_name_are_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            main = self._main(tmp)
            files = [
                {'name': 'main.cpp', 'content': 'int a;\n'},
                {'name': 'user_main.cpp', 'content': 'int b;\n'},
            ]
            err = ec._write_arduino_user_files(main, files, None)
            self.assertIsNotNone(err)
            self.assertIn('user_main.cpp', err)

    def test_escaping_names_land_inside_main(self):
        with tempfile.TemporaryDirectory() as tmp:
            main = self._main(tmp)
            (Path(tmp) / 'build').mkdir()
            files = [{'name': '../build/build.ninja', 'content': 'rule x\n'}]
            self.assertIsNone(ec._write_arduino_user_files(main, files, None))
            self.assertFalse((Path(tmp) / 'build' / 'build.ninja').exists())
            self.assertTrue((main / 'build.ninja').is_file())


class InputDigestTests(unittest.TestCase):
    """For a given path the mtime never goes backwards and moves forward when
    the content changes. copytree/copy2 restore OLD mtimes, which is how a
    stale main.cpp.obj survived for nine hours on 2026-09-15."""

    @staticmethod
    def _age(path: Path, seconds: float) -> None:
        t = time.time() - seconds
        os.utime(path, (t, t))

    def _template(self, root: Path) -> Path:
        tpl = root / 'template'
        (tpl / 'main').mkdir(parents=True)
        for name, text in (('main.cpp', WRAPPER), ('CMakeLists.txt', 'idf_component_register()\n')):
            f = tpl / 'main' / name
            f.write_text(text)
            self._age(f, 90 * 86400)
        (tpl / 'CMakeLists.txt').write_text('project(x)\n')
        return tpl

    def test_first_build_of_a_dir_marks_every_input_new(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            (project / 'main').mkdir()
            src = project / 'main' / 'a.cpp'
            src.write_text('int a;\n')
            self._age(src, 90 * 86400)
            self.assertEqual(ec._advance_changed_inputs(project), 1)
            self.assertGreater(src.stat().st_mtime, time.time() - 60)

    def test_unchanged_content_copied_back_in_time_gets_its_mtime_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            (project / 'user_libs').mkdir()
            lib = project / 'user_libs' / 'lib.cpp'
            lib.write_text('int v1;\n')
            ec._advance_changed_inputs(project)
            recorded = lib.stat().st_mtime_ns
            # The next build copies the same bytes with the cache's old mtime.
            lib.write_text('int v1;\n')
            self._age(lib, 90 * 86400)
            self.assertEqual(ec._advance_changed_inputs(project), 1)
            self.assertEqual(lib.stat().st_mtime_ns, recorded)
            # Nothing to do on a third, identical build.
            self.assertEqual(ec._advance_changed_inputs(project), 0)

    def test_changed_content_with_an_old_mtime_moves_forward(self):
        # The library-version-bump shape: new bytes, cache mtime in the past.
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            (project / 'user_libs').mkdir()
            lib = project / 'user_libs' / 'lib.cpp'
            lib.write_text('int v1;\n')
            ec._advance_changed_inputs(project)
            obj_time = time.time() - 5
            lib.write_text('int v2;\n')
            self._age(lib, 90 * 86400)
            self.assertEqual(ec._advance_changed_inputs(project), 1)
            self.assertGreater(lib.stat().st_mtime, obj_time)

    def test_the_outage_sequence_rebuilds_the_wrapper(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(ec, '_BUILD_ROOT', Path(tmp) / 'build'), \
                mock.patch.object(ec, '_TEMPLATE_DIR', self._template(Path(tmp))), \
                mock.patch.object(ec, '_idf_version_signature', lambda: 'sig'):
            project = ec._prepare_persistent_project_dir('esp32', 'abc')
            ec._advance_changed_inputs(project)
            # Build A: a user helper named main.cpp lands on the wrapper (the
            # pre-fix writer), and its object is compiled.
            (project / 'main' / 'main.cpp').write_text('int helperValue();\n')
            ec._advance_changed_inputs(project)
            obj = project / 'build' / 'main.cpp.obj'
            obj.parent.mkdir(parents=True, exist_ok=True)
            obj.write_bytes(b'\0')
            self._age(obj, 5)
            # Build B: main/ restored from the template with its 90-day mtime.
            project = ec._prepare_persistent_project_dir('esp32', 'abc')
            self.assertLess((project / 'main' / 'main.cpp').stat().st_mtime, obj.stat().st_mtime)
            ec._advance_changed_inputs(project)
            self.assertGreater((project / 'main' / 'main.cpp').stat().st_mtime, obj.stat().st_mtime)

    def test_a_dir_poisoned_before_the_record_existed_heals(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(ec, '_BUILD_ROOT', Path(tmp) / 'build'), \
                mock.patch.object(ec, '_TEMPLATE_DIR', self._template(Path(tmp))), \
                mock.patch.object(ec, '_idf_version_signature', lambda: 'sig'):
            project = ec._prepare_persistent_project_dir('esp32', 'abc')
            obj = project / 'build' / 'main.cpp.obj'
            obj.parent.mkdir(parents=True, exist_ok=True)
            obj.write_bytes(b'\0')
            self._age(obj, 5)
            project = ec._prepare_persistent_project_dir('esp32', 'abc')
            self.assertFalse((project / ec._INPUT_DIGESTS).exists())
            ec._advance_changed_inputs(project)
            self.assertGreater((project / 'main' / 'main.cpp').stat().st_mtime, obj.stat().st_mtime)

    def test_a_changed_top_level_template_cmakelists_reaches_a_warm_variant(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(ec, '_BUILD_ROOT', Path(tmp) / 'build'), \
                mock.patch.object(ec, '_idf_version_signature', lambda: 'sig'):
            tpl = self._template(Path(tmp))
            with mock.patch.object(ec, '_TEMPLATE_DIR', tpl):
                project = ec._prepare_persistent_project_dir('esp32', 'abc')
                (tpl / 'CMakeLists.txt').write_text('project(x)\n# v2\n')
                project = ec._prepare_persistent_project_dir('esp32', 'abc')
                self.assertIn('# v2', (project / 'CMakeLists.txt').read_text())


class LinkFailureClassificationTests(unittest.TestCase):
    LINK = (
        'FAILED: velxio-sketch.elf\n'
        ': && xtensa-esp32-elf-g++ -o velxio-sketch.elf esp-idf/main/libmain.a '
        'esp-idf/bootloader_support/libbootloader_support.a && :\n'
        "ld: sketch.ino.cpp.obj: undefined reference to `my_helper()'\n"
        'collect2: error: ld returned 1 exit status\n'
    )

    def test_a_user_link_error_is_not_transient(self):
        self.assertFalse(ec.espidf_compiler._is_transient_build_failure(
            {'success': False, 'stdout': self.LINK}))

    def test_a_failed_bootloader_sub_build_is_transient(self):
        out = ('[2/10] Performing build step for \'bootloader\'\n'
               'FAILED: bootloader-prefix/src/bootloader-stamp/bootloader-build\n')
        self.assertTrue(ec.espidf_compiler._is_transient_build_failure(
            {'success': False, 'stdout': out}))

    def test_a_normal_bootloader_step_line_alone_is_not_transient(self):
        out = "[2/10] Performing build step for 'bootloader'\nsketch.ino:3:1: error: 'x' was not declared\n"
        self.assertFalse(ec.espidf_compiler._is_transient_build_failure(
            {'success': False, 'stdout': out}))

    def test_a_missing_app_main_is_recognised(self):
        self.assertTrue(ec._missing_app_main("ld: undefined reference to `app_main'"))
        self.assertFalse(ec._missing_app_main(self.LINK))


class SpiffsNameTests(unittest.TestCase):
    def test_a_name_that_leaves_spiffs_data_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(ec.espidf_compiler, '_locate_mkspiffs', lambda: '/bin/true'):
            project = Path(tmp) / 'project'
            (project / 'build').mkdir(parents=True)
            payload = base64.b64encode(b'x').decode()
            with self.assertRaises(ValueError):
                ec.espidf_compiler._build_spiffs_image(
                    project, [{'name': '../build/x.bin', 'content_b64': payload}], 1 << 20)
            self.assertFalse((project / 'build' / 'x.bin').exists())


if __name__ == '__main__':
    unittest.main()
