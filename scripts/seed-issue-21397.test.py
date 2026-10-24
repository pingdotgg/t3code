#!/usr/bin/env python3
"""python3 scripts/seed-issue-21397.test.py — runs the seeder against synthetic SQLite files only."""
import datetime
import hashlib
import json
import os
import pathlib
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().with_name('seed-issue-21397.py')
FIXTURE = json.loads(SCRIPT.with_name('fixtures').joinpath('issue-21397.json').read_text())
# Windows cannot delete a file SQLite still holds open, so cleanup must close connections first.
OPEN_DB_PROBE = '''
import runpy, shutil, sqlite3, sys
opened, connect, rmtree = [], sqlite3.connect, shutil.rmtree
def tracked(*args, **kwargs):
    opened.append(connect(*args, **kwargs))
    return opened[-1]
def checked(*args, **kwargs):
    for db in opened:
        try:
            db.total_changes
        except sqlite3.ProgrammingError:
            continue
        sys.exit('rmtree ran while a SQLite connection was open')
    return rmtree(*args, **kwargs)
sqlite3.connect, shutil.rmtree = tracked, checked
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name='__main__')
'''


def snapshot(directory):
    return {
        str(p.relative_to(directory)): hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else 'dir'
        for p in sorted(directory.rglob('*'))
    }


class SeederTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.tmp = pathlib.Path(temp.name)
        self.fake_home = self.tmp / 'user'
        (self.fake_home / '.t3/userdata').mkdir(parents=True)
        self.source_home = self.tmp / 'worktree/.t3/userdata'
        self.source_home.mkdir(parents=True)
        self.source = self.source_home / 'statev2.sqlite'
        db = sqlite3.connect(self.source)
        db.execute('PRAGMA journal_mode=WAL')
        for table, rows in FIXTURE.items():
            db.execute(f'CREATE TABLE "{table}" ({",".join(sorted({k for r in rows for k in r}))})')
            db.execute(f'INSERT INTO "{table}" (thread_id) VALUES (?)' if table != 'projection_projects'
                       else f'INSERT INTO "{table}" (project_id) VALUES (?)', ['sentinel'])
        db.execute('CREATE TABLE orchestration_v2_projection_metadata (key)')
        db.execute("INSERT INTO orchestration_v2_projection_metadata VALUES ('kept')")
        db.execute('CREATE TABLE projection_thread_messages (id)')
        db.execute("INSERT INTO projection_thread_messages VALUES ('sentinel')")
        db.execute('CREATE TABLE orchestration_v2_effect_outbox (status)')
        db.executemany('INSERT INTO orchestration_v2_effect_outbox VALUES (?)', [('pending',), ('done',)])
        db.commit()
        db.close()
        (self.source_home / 'settings.json').write_text('{"sentinel": true}\n')
        self.before = snapshot(self.source_home)

    def run_seeder(self, *args, probe=()):
        env = {**os.environ, 'HOME': str(self.fake_home)}
        return subprocess.run([sys.executable, '-I', *probe, str(SCRIPT), '--source', str(self.source), *args],
                              env=env, capture_output=True, text=True)

    def assertSourceUnchanged(self):
        self.assertEqual(snapshot(self.source_home), self.before)

    def thread_payload(self, home):
        with sqlite3.connect(home / 'userdata/statev2.sqlite') as db:
            self.assertEqual(db.execute('SELECT count(*) FROM projection_thread_messages').fetchone(), (0,))
            self.assertEqual(db.execute('SELECT key FROM orchestration_v2_projection_metadata').fetchall(), [('kept',)])
            self.assertEqual(db.execute('SELECT status FROM orchestration_v2_effect_outbox ORDER BY 1').fetchall(),
                             [('cancelled',), ('done',)])
            rows = db.execute('SELECT thread_id, payload_json FROM orchestration_v2_projection_threads').fetchall()
        self.assertEqual(len(rows), 1)
        self.assertNotEqual(rows[0][0], 'sentinel')
        return json.loads(rows[0][1])

    def test_seeds_a_fresh_copy_for_every_mode_and_clock(self):
        snooze = json.loads(FIXTURE['orchestration_v2_projection_threads'][0]['payload_json'])['snoozedUntil']
        clocks = [([], datetime.timedelta(), '2026-10-22T19:00:00Z'),
                  (['--now', '2026-11-01T12:30:00+02:00'], datetime.timedelta(days=9, hours=15, minutes=30),
                   '2026-11-01T10:30:00Z'),
                  (['--now'], None, None)]
        for mode in ('matching', 'absent', 'unrelated'):
            for clock_args, delta, logged in clocks:
                with self.subTest(mode=mode, clock=clock_args):
                    home = self.tmp / 'fixtures' / f'{mode}-{len(clock_args)}'
                    started = datetime.datetime.now(datetime.timezone.utc)
                    result = self.run_seeder('--home', str(home), mode, *clock_args)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertSourceUnchanged()
                    if delta is None:
                        delta = started.replace(microsecond=0) - datetime.datetime(
                            2026, 10, 22, 19, tzinfo=datetime.timezone.utc)
                        logged = None
                    if logged:
                        self.assertIn(f'(limit hit at {logged})', result.stdout)
                    self.assertIn(f'Run: vp run dev --home-dir {home}', result.stdout)
                    expected = {'matching': snooze, 'absent': None, 'unrelated': '2026-10-24T08:50:00.000Z'}[mode]
                    actual = self.thread_payload(home)['snoozedUntil']
                    if expected is None:
                        self.assertIsNone(actual)
                    else:
                        moved = datetime.datetime.fromisoformat(actual.replace('Z', '+00:00')) - delta
                        original = datetime.datetime.fromisoformat(expected.replace('Z', '+00:00'))
                        self.assertLess(abs(moved - original), datetime.timedelta(seconds=2))
                    self.assertEqual(json.loads((home / 'userdata/settings.json').read_text()),
                                     {'snoozeLimitedThreads': False, 'autoResumeLimitedThreads': False})

    def test_refuses_unsafe_destinations_without_touching_anything(self):
        existing_dir = self.tmp / 'existing'
        existing_dir.mkdir()
        (existing_dir / 'keep').write_text('keep')
        existing_file = self.tmp / 'file'
        existing_file.write_text('keep')
        link_to_dir = self.tmp / 'link-dir'
        link_to_dir.symlink_to(existing_dir)
        dangling = self.tmp / 'dangling'
        dangling.symlink_to(self.tmp / 'missing')
        live_link = self.tmp / 'live-link'
        live_link.symlink_to(self.fake_home / '.t3')
        cases = {
            'existing directory': existing_dir,
            'existing file': existing_file,
            'symlink to directory': link_to_dir,
            'dangling symlink': dangling,
            'source home': self.source_home.parent,
            'live home': self.fake_home / '.t3',
            'inside live home': self.fake_home / '.t3/fixture',
            'through symlink into live home': live_link / 'fixture',
        }
        for name, home in cases.items():
            with self.subTest(name):
                listing = sorted(str(p) for p in self.tmp.rglob('*'))
                result = self.run_seeder('--home', str(home))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Refusing', result.stderr)
                self.assertSourceUnchanged()
                self.assertEqual(sorted(str(p) for p in self.tmp.rglob('*')), listing)
        self.assertEqual((existing_dir / 'keep').read_text(), 'keep')
        self.assertFalse((self.tmp / 'missing').exists())

    def test_refuses_missing_or_symlinked_source(self):
        link = self.tmp / 'linked.sqlite'
        link.symlink_to(self.source)
        for source in (self.tmp / 'absent.sqlite', link):
            with self.subTest(str(source)):
                env = {**os.environ, 'HOME': str(self.fake_home)}
                result = subprocess.run([sys.executable, '-I', str(SCRIPT), '--source', str(source),
                                         '--home', str(self.tmp / 'new')], env=env, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.tmp / 'new').exists())
                self.assertSourceUnchanged()

    def test_failed_seed_removes_only_its_new_home(self):
        with sqlite3.connect(self.source) as db:
            db.execute('DROP TABLE orchestration_v2_effect_outbox')
        db.close()
        self.before = snapshot(self.source_home)
        home = self.tmp / 'broken'
        result = self.run_seeder('--home', str(home), probe=('-c', OPEN_DB_PROBE))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('orchestration_v2_effect_outbox', result.stderr)
        self.assertFalse(home.exists(), result.stderr)
        self.assertSourceUnchanged()


if __name__ == '__main__':
    unittest.main()
