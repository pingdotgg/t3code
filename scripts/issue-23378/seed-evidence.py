#!/usr/bin/env python3
"""Reset an OFFLINE, isolated dev database to public issue-23378 proof data.

The evidence home must be a private directory you own that holds a marker file
declaring it disposable. Every table in its database is deleted.
  (umask 077; mkdir /absolute/evidence-home
   touch /absolute/evidence-home/ISSUE_23378_DISPOSABLE_FIXTURE)
Run (umask 077; vp run dev:desktop --home-dir /absolute/evidence-home --no-seed)
once to initialize migrations, stop it, then run:
  python3 scripts/issue-23378/seed-evidence.py /absolute/evidence-home
Never pass the live T3 home. This fixture uses real local authentication.
"""
import json
import os
import pathlib
import sqlite3
import stat
import sys
import tempfile

MARKER = 'ISSUE_23378_DISPOSABLE_FIXTURE'


def private_entry(path, kind):
    # lstat so a planted symlink is refused instead of followed. Group write is
    # refused too: a group member could swap a checked entry before it is opened.
    info = os.lstat(path)
    if not kind(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise SystemExit(f'Refusing {path}: expected your own non-symlink entry, not group or world writable')


if len(sys.argv) != 2:
    raise SystemExit(__doc__)
home = pathlib.Path(sys.argv[1]).resolve(strict=True)
live = (pathlib.Path.home() / '.t3').resolve()
if home == live or live.is_relative_to(home) or home.is_relative_to(live):
    raise SystemExit('Expected an isolated evidence home, never the live install')
private_entry(home, stat.S_ISDIR)
if not (home / MARKER).exists():
    raise SystemExit(f'Refusing {home}: create {home / MARKER} to mark it as a disposable fixture')
private_entry(home / MARKER, stat.S_ISREG)
userdata = home / 'userdata'
db = userdata / 'statev2.sqlite'
if not db.exists():
    raise SystemExit('Initialize the isolated dev database first')
private_entry(userdata, stat.S_ISDIR)
private_entry(db, stat.S_ISREG)
for sidecar in ('-wal', '-shm', '-journal'):
    if os.path.lexists(f'{db}{sidecar}'):
        private_entry(f'{db}{sidecar}', stat.S_ISREG)


def write_private(name, text):
    fd = os.open(userdata / name, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as file:
        file.write(text)


connection = sqlite3.connect(db.as_uri() + '?mode=rw', uri=True)
connection.execute('PRAGMA foreign_keys=OFF')
for (table,) in connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall():
    if table not in ('effect_sql_migrations', 'sqlite_sequence'):
        connection.execute('DELETE FROM "' + table.replace('"', '""') + '"')
now = '2026-10-22T12:00:00.000Z'
workspace = pathlib.Path(tempfile.mkdtemp(prefix='demo-project-', dir=home))
(workspace / 'README.md').write_text('# Launch recovery demo\n\nSynthetic public fixture. No provider is started.\n')
connection.execute('INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (?,?,?,?,?,?)', ('proof-project', 'Launch recovery demo', str(workspace), '[]', now, now))
thread = dict(createdBy='user', creationSource='web', id='proof-thread', projectId='proof-project', title='Verify desktop startup recovery', providerInstanceId='codex', modelSelection=dict(instanceId='codex', model='gpt-5.4'), runtimeMode='full-access', interactionMode='default', branch=None, worktreePath=None, pullRequests=[], activeProviderThreadId=None, lineage=dict(parentThreadId=None, relationshipToParent=None, rootThreadId='proof-thread'), forkedFrom=None, createdAt=now, updatedAt=now, archivedAt=None, settledOverride=None, settledAt=None, snoozedUntil=None, snoozedAt=None, lastVisitedAt=now, deletedAt=None)
connection.execute('INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json,provider_instance_id) VALUES (?,?,?,?,?,?,?,?,?,?)', ('proof-thread','proof-project',thread['title'],'codex','full-access','default',now,now,json.dumps(thread),'codex'))
connection.commit()
connection.execute('VACUUM')
connection.close()
write_private('client-settings.json', json.dumps({'onboardingCompletedAt': now, 'notificationMode': 'off', 'inAppNotificationsEnabled': False, 'panelAnimationDurationMs': 0}))
write_private('desktop-settings.json', json.dumps({'mainWindowBounds': {'x': 0, 'y': 0, 'width': 1920, 'height': 1080}}))
write_private('environment-id', '23378000-0000-4000-8000-000000000001')
write_private('anonymous-id', '23378000-0000-4000-8000-000000000002')
print('Seeded one synthetic project and one stopped thread:', db)
