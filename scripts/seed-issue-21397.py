#!/usr/bin/env python3
"""python3 scripts/seed-issue-21397.py --home NEW_DIR [matching|absent|unrelated] [--now [ISO]] [--source DB].

Copies a migrated statev2.sqlite (default: this worktree's .t3, with dev stopped;
run dev once first to migrate it) into NEW_DIR/userdata, then replaces every
thread/project projection in that copy with a synthetic stopped usage-limit run.
The source is only read as bytes, never opened by SQLite, so it stays unchanged.
NEW_DIR must not exist and must not be under the live ~/.t3. Then run the printed
`vp run dev --home-dir NEW_DIR`.

Fixture times are frozen around the evidence clock, 2026-10-22T19:00:00Z (usage
limit hit; reset and matching snooze at 2026-10-23T08:50:00Z). By default they
are seeded unchanged, reproducing the PR captures. After that reset, pass --now
(current time) or --now ISO to shift every timestamp so the failure happens then.
"""
import argparse
import contextlib
import datetime
import json
import pathlib
import re
import shlex
import shutil
import sqlite3

EVIDENCE_CLOCK = datetime.datetime(2026, 10, 22, 19, tzinfo=datetime.timezone.utc)
ISO = re.compile(r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$')


def parse_iso(value):
    parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=datetime.timezone.utc)


def shift(value, delta):
    if isinstance(value, dict):
        return {k: shift(v, delta) for k, v in value.items()}
    if isinstance(value, str) and ISO.match(value):
        moved = parse_iso(value) + delta
        return moved.strftime('%Y-%m-%dT%H:%M:%S.') + f'{moved.microsecond // 1000:03d}Z'
    return value


root = pathlib.Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('mode', nargs='?', default='matching', choices=('matching', 'absent', 'unrelated'))
parser.add_argument('--home', required=True, type=pathlib.Path, help='new T3 home to create; must not exist')
parser.add_argument('--source', type=pathlib.Path, default=root / '.t3/userdata/statev2.sqlite')
parser.add_argument('--now', nargs='?', const='now', help='shift fixture times so the limit is hit at this ISO time')
args = parser.parse_args()
mode = args.mode
now = None if args.now is None else datetime.datetime.now(datetime.timezone.utc) if args.now == 'now' else parse_iso(args.now)
delta = datetime.timedelta() if now is None else now - EVIDENCE_CLOCK

source = args.source.absolute()
if source.is_symlink() or not source.is_file():
    raise SystemExit(f'Expected a migrated statev2.sqlite regular file at {source}')
# Resolve the parent, not the home itself, so a symlink at the home path is refused below.
home = args.home.absolute().parent.resolve() / args.home.name
live = (pathlib.Path.home() / '.t3').resolve()
if not args.home.name or home == live or live in home.parents:
    raise SystemExit(f'Refusing fixture home {home}: pick a new directory outside {live}')
home.parent.mkdir(parents=True, exist_ok=True)
try:
    home.mkdir()  # Atomic: fails on any existing file, directory, or symlink.
except FileExistsError:
    raise SystemExit(f'Refusing existing fixture home {home}: pick a new directory')

try:
    userdata = home / 'userdata'
    userdata.mkdir()
    path = userdata / 'statev2.sqlite'
    shutil.copyfile(source, path)
    wal = source.with_name(source.name + '-wal')
    if wal.is_file() and not wal.is_symlink():
        shutil.copyfile(wal, path.with_name(path.name + '-wal'))
    fixture = json.loads((root / 'scripts/fixtures/issue-21397.json').read_text())
    # closing() outlives the transaction so cleanup below never deletes an open database.
    with contextlib.closing(sqlite3.connect(path)) as db, db:
        # Drop copied conversations, including V1 tables the server could re-import.
        tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        for table in tables:
            if table.startswith('orchestration_v2_projection_') and table != 'orchestration_v2_projection_metadata':
                db.execute(f'DELETE FROM "{table}"')
            elif table.startswith('projection_thread') or table == 'projection_projects':
                db.execute(f'DELETE FROM "{table}"')
        db.execute("UPDATE orchestration_v2_effect_outbox SET status='cancelled' WHERE status IN ('pending','running')")
        for table, rows in fixture.items():
            for row in rows:
                row = shift(dict(row), delta)
                if table == 'projection_projects':
                    row['workspace_root'] = str(root)
                if table == 'orchestration_v2_projection_threads':
                    payload = json.loads(row['payload_json'])
                    if mode == 'absent':
                        payload['snoozedUntil'] = None
                    elif mode == 'unrelated':
                        payload['snoozedUntil'] = '2026-10-24T08:50:00.000Z'
                    row['payload_json'] = json.dumps(shift(payload, delta))
                elif delta and 'payload_json' in row:
                    row['payload_json'] = json.dumps(shift(json.loads(row['payload_json']), delta))
                columns = ','.join(f'"{k}"' for k in row)
                placeholders = ','.join('?' for _ in row)
                db.execute(f'INSERT INTO "{table}" ({columns}) VALUES ({placeholders})', list(row.values()))
    settings = dict(snoozeLimitedThreads=False, autoResumeLimitedThreads=False)
    (userdata / 'settings.json').write_text(json.dumps(settings, indent=2) + '\n')
except BaseException:
    shutil.rmtree(home)  # Created above by this run, so it holds nothing else.
    raise
hit = (now or EVIDENCE_CLOCK).astimezone(datetime.timezone.utc)
print(f'Seeded synthetic {mode} fixture in {path} (limit hit at {hit:%Y-%m-%dT%H:%M:%SZ})')
print(f'Run: vp run dev --home-dir {shlex.quote(str(home))}')
