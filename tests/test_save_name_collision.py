#!/usr/bin/env python3
"""Regression tests: same top-module name must not clobber a different source_path."""

import json
import os
import sys
import tempfile
import unittest

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src')
sys.path.insert(0, SRC)

from verilog_parser import (  # noqa: E402
    allocate_unique_save_name,
    analyze_and_save,
    peek_design_source_path,
    source_paths_are_same_design,
)
from app import analysis_source_path  # noqa: E402


def write_json(path, payload):
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle)


def write_module(path, name='CPU'):
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write(f'module {name}(input clk);\nendmodule\n')


class SaveNameCollisionTest(unittest.TestCase):
    def test_different_file_paths_do_not_clobber(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = os.path.join(tmp, 'data')
            os.makedirs(data_dir)
            old_src = os.path.join(tmp, 'old', 'CPU.sv')
            new_src = os.path.join(tmp, 'new', 'CPU.sv')
            os.makedirs(os.path.dirname(old_src))
            os.makedirs(os.path.dirname(new_src))
            write_module(old_src)
            write_module(new_src)
            write_json(os.path.join(data_dir, 'CPU.json'), {
                'source_path': old_src,
                'top_modules': ['CPU'],
                'modules': {},
                'layout': {'keep_me': {'x': 1, 'y': 2}},
            })

            result = analyze_and_save(new_src, data_dir)
            self.assertEqual(result['saved_as'], 'CPU_1')
            self.assertTrue(result['name_collision'])
            with open(os.path.join(data_dir, 'CPU.json'), encoding='utf-8') as handle:
                original = json.load(handle)
            self.assertEqual(original['source_path'], old_src)
            self.assertEqual(original['layout']['keep_me']['x'], 1)
            self.assertTrue(os.path.exists(os.path.join(data_dir, 'CPU_1.json')))

    def test_truncated_json_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = os.path.join(tmp, 'data')
            os.makedirs(data_dir)
            occupied = os.path.join(data_dir, 'CPU.json')
            with open(occupied, 'w', encoding='utf-8') as handle:
                handle.write('{"source_path": "/old/path"')
            incoming = os.path.join(tmp, 'CPU.sv')
            write_module(incoming)
            name, path, collided = allocate_unique_save_name(data_dir, 'CPU', incoming)
            self.assertEqual(name, 'CPU_1')
            self.assertTrue(collided)
            with open(occupied, encoding='utf-8') as handle:
                self.assertIn('/old/path', handle.read())

    def test_same_directory_and_inner_file_are_same_design(self):
        with tempfile.TemporaryDirectory() as tmp:
            rtl = os.path.join(tmp, 'rtl')
            os.makedirs(rtl)
            cpu = os.path.join(rtl, 'CPU.sv')
            write_module(cpu)
            self.assertTrue(source_paths_are_same_design(rtl, cpu))
            self.assertTrue(source_paths_are_same_design(cpu, rtl))
            self.assertFalse(source_paths_are_same_design(
                os.path.join(tmp, 'other', 'rtl'), cpu))

    def test_same_source_reanalyze_keeps_name_and_layout(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = os.path.join(tmp, 'data')
            rtl = os.path.join(tmp, 'rtl')
            os.makedirs(rtl)
            cpu = os.path.join(rtl, 'CPU.sv')
            write_module(cpu)
            first = analyze_and_save(rtl, data_dir)
            self.assertEqual(first['saved_as'], 'CPU')
            with open(os.path.join(data_dir, 'CPU.json'), encoding='utf-8') as handle:
                saved = json.load(handle)
            saved['server_sync_enabled'] = False
            saved['view_state'] = {'zoom': 1.5, 'module': 'CPU'}
            with open(os.path.join(data_dir, 'CPU.json'), 'w', encoding='utf-8') as handle:
                json.dump(saved, handle)

            again = analyze_and_save(cpu, data_dir)
            self.assertEqual(again['saved_as'], 'CPU')
            self.assertFalse(again['name_collision'])
            self.assertFalse(again['server_sync_enabled'])
            self.assertEqual(again['view_state']['zoom'], 1.5)

    def test_peek_reads_source_path_without_full_object(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'CPU.json')
            with open(path, 'w', encoding='utf-8') as handle:
                handle.write('{\n  "source_path": "/tmp/design/rtl",\n')
                handle.write('  "modules": {"huge": true}\n}\n')
            self.assertEqual(peek_design_source_path(path), '/tmp/design/rtl')

    def test_multiple_rtl_roots_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            for name in ('one', 'two'):
                rtl = os.path.join(tmp, name, 'rtl')
                os.makedirs(rtl)
                write_module(os.path.join(rtl, 'Top.sv'), 'Top')
            with self.assertRaises(ValueError) as ctx:
                analysis_source_path(tmp)
            self.assertIn('多个 RTL 目录', str(ctx.exception))

    def test_single_construction_root_resolves_rtl(self):
        with tempfile.TemporaryDirectory() as tmp:
            rtl = os.path.join(tmp, 'abi', 'rtl')
            os.makedirs(rtl)
            write_module(os.path.join(rtl, 'CPU.sv'))
            resolved, notice = analysis_source_path(tmp)
            self.assertEqual(os.path.realpath(resolved), os.path.realpath(rtl))
            self.assertIn('RTL', notice)


if __name__ == '__main__':
    unittest.main()
