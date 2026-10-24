#!/usr/bin/env python3
"""Create synthetic Git repositories and optional clean T3 projection fixtures.

Run with a NEW --root. For --state, stop the isolated server first. The schema
is read from --schema-from; only migration bookkeeping is copied. No user data
or credentials are copied. The original database must never be the destination.
Example: python3 seed.py --root /tmp/checkout-proof --schema-from /tmp/schema.sqlite \
    --state /tmp/isolated/userdata/statev2.sqlite
Reset captures with git -C <root>/regular switch main (and similarly linked).
"""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root', type=Path, required=True)
parser.add_argument('--schema-from', type=Path)
parser.add_argument('--state', type=Path)
args = parser.parse_args()
data = json.loads(Path(__file__).with_name('data.json').read_text())
root = args.root.resolve()
root.mkdir(parents=True, exist_ok=False)
env = dict(os.environ, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null',
           GIT_AUTHOR_NAME=data['author'], GIT_COMMITTER_NAME=data['author'],
           GIT_AUTHOR_EMAIL=data['email'], GIT_COMMITTER_EMAIL=data['email'],
           GIT_AUTHOR_DATE=data['timestamp'], GIT_COMMITTER_DATE=data['timestamp'])
for key in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'):
    env.pop(key, None)

def git(directory, *arguments):
    return subprocess.check_output(['git', '-C', str(directory), *arguments], env=env, stderr=subprocess.PIPE, text=True).strip()

def initialize(name):
    directory = root / name
    directory.mkdir()
    git(directory, 'init', '--initial-branch=main')
    for filename, contents in data['files'].items():
        (directory / filename).write_text(contents)
    git(directory, 'add', '.')
    git(directory, 'commit', '-m', 'Synthetic initial state')
    return directory

regular = initialize('regular')
git(regular, 'branch', data['featureBranch'])
remote_root = initialize('remote-root')
git(remote_root, 'branch', 'untracked')
git(remote_root, 'switch', '-c', 'tracked')
(remote_root / 'feature.txt').write_text(data['featureFile'])
git(remote_root, 'add', '.')
git(remote_root, 'commit', '-m', 'Synthetic tracked feature')
git(remote_root, 'switch', 'main')
git(root, 'clone', '--bare', str(remote_root), str(root / 'origin.git'))
git(remote_root, 'remote', 'add', 'origin', str(root / 'origin.git'))
git(remote_root, 'fetch', 'origin')
git(remote_root, 'branch', '--set-upstream-to=origin/tracked', 'tracked')
git(remote_root, 'worktree', 'add', str(root / 'linked'), 'untracked')
(root / 'nonrepo').mkdir()
manifest = {'root': str(root), 'data': data, 'commits': {
    'main': git(regular, 'rev-parse', 'main'),
    'tracked': git(remote_root, 'rev-parse', 'tracked')},
    'headPaths': {name: git(root / name, 'rev-parse', '--path-format=absolute', '--git-path', 'HEAD')
                  for name in ['regular', 'linked']}}
if args.state:
    if not args.schema_from or args.state.resolve() == args.schema_from.resolve():
        parser.error('--state requires a distinct --schema-from')
    if args.state.exists():
        parser.error('--state must not already exist; move the stopped isolated database aside first')
    source = sqlite3.connect(f'file:{args.schema_from.resolve()}?mode=ro', uri=True)
    args.state.parent.mkdir(parents=True, exist_ok=True)
    destination = sqlite3.connect(args.state)
    for sql, in source.execute("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END"):
        destination.execute(sql)
    migrations = source.execute('SELECT * FROM effect_sql_migrations').fetchall()
    for row in migrations:
        destination.execute('INSERT INTO effect_sql_migrations VALUES (' + ','.join('?' for _ in row) + ')', row)
    timestamp = data['timestamp']
    for index, project in enumerate(data['projects']):
        destination.execute('INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (?,?,?,?,?,?)',
                            (project['id'], project['title'], str(root / project['directory']), '[]', timestamp, timestamp))
        thread_id = f'74090000-0000-4000-8000-00000000001{index}'
        payload = dict(createdBy='user', creationSource='web', id=thread_id, projectId=project['id'],
                       title='Stopped synthetic thread', providerInstanceId='codex',
                       modelSelection=dict(instanceId='codex', model='gpt-5.4'), runtimeMode='full-access',
                       interactionMode='default', branch='main' if index == 0 else 'untracked' if index == 1 else None,
                       worktreePath=None, activeProviderThreadId=None, linkOrigin=None,
                       lineage=dict(parentThreadId=None, relationshipToParent=None, rootThreadId=thread_id),
                       forkedFrom=None, createdAt=timestamp, updatedAt=timestamp, archivedAt=None,
                       settledOverride=None, settledAt=None, unsettledAt=None, snoozedUntil=None,
                       snoozedAt=None, pinnedAt=None, pinOrderKey=None, activeOrderKey=None,
                       lastVisitedAt=None, deletedAt=None)
        destination.execute('INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json,provider_instance_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
                            (thread_id, project['id'], payload['title'], 'codex', 'full-access', 'default', timestamp, timestamp, json.dumps(payload), 'codex'))
    destination.commit()
    destination.close()
    source.close()
(root / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest, indent=2))
