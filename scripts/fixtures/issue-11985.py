#!/usr/bin/env python3
"""Seed synthetic toolbar evidence in an initialized, stopped /tmp T3 home.

Usage: python3 scripts/fixtures/issue-11985.py /tmp/issue-11985-proof-home
Start the dev server once to migrate this home, then stop it before running.
No auth, provider sessions, historical conversations, or discovery overrides.
"""

import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys

home = Path(sys.argv[1]).resolve()
if not str(home).startswith('/tmp/issue-11985-'):
    raise SystemExit('Use a dedicated /tmp/issue-11985-* home')
db_path = home / 'userdata/statev2.sqlite'
if not db_path.is_file():
    raise SystemExit('Initialize migrations, then stop the server first')
repo = home / 'toolbar-fixture'
if repo.exists() and not (repo / '.git/issue-11985-fixture').is_file():
    raise SystemExit('Refusing an existing non-fixture repository')
repo.mkdir(exist_ok=True)

def git(*args):
    return subprocess.run(['git', '-C', str(repo), *args], check=True,
                          capture_output=True, text=True).stdout.strip()

if not (repo / '.git').exists():
    git('init', '--initial-branch=main')
    git('config', 'user.name', 'Toolbar Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    git('config', 'commit.gpgsign', 'false')
    (repo / '.git/issue-11985-fixture').touch()
    (repo / 'preview.txt').write_text('Synthetic toolbar preview.\n')
    (repo / 'folder').mkdir(exist_ok=True)
    (repo / 'folder/nested.txt').write_text('Synthetic nested file.\n')
    git('add', '.')
    env = dict(os.environ, GIT_AUTHOR_DATE='2026-01-01T00:00:00Z',
               GIT_COMMITTER_DATE='2026-01-01T00:00:00Z')
    subprocess.run(['git', '-C', str(repo), 'commit', '-m', 'Synthetic fixture'],
                   env=env, check=True, capture_output=True)
try:
    git('rev-parse', '--verify', 'HEAD^{commit}')
except subprocess.CalledProcessError:
    raise SystemExit('Refusing an interrupted fixture repository without a valid HEAD')
(repo / 'preview.txt').write_text('Synthetic toolbar preview.\nOne deterministic dirty line.\n')

stamp = '2026-01-01T00:00:00.000Z'
project_id = '11985000-0000-4000-8000-000000000001'
thread_id = '11985000-0000-4000-8000-000000000002'
script = dict(id='toolbar-proof', name='Harmless toolbar fixture with a deliberately long script name',
              command='printf "toolbar fixture\\n"', icon='play', runOnWorktreeCreate=False,
              runOnSettle=False)
thread = dict(createdBy='system', creationSource='server', id=thread_id,
              projectId=project_id, title='Toolbar evidence fixture',
              providerInstanceId='codex', modelSelection=dict(instanceId='codex', model='gpt-5.4'),
              runtimeMode='full-access', interactionMode='default', branch='main',
              worktreePath=str(repo), pullRequests=[], activeProviderThreadId=None,
              lineage=dict(parentThreadId=None, relationshipToParent=None, rootThreadId=thread_id),
              forkedFrom=None, createdAt=stamp, updatedAt=stamp, archivedAt=None,
              settledOverride=None, settledAt=None, snoozedUntil=None, snoozedAt=None,
              lastVisitedAt=stamp, deletedAt=None)
with sqlite3.connect(db_path) as db:
    if db.execute('SELECT count(*) FROM projection_projects WHERE project_id != ?',
                  (project_id,)).fetchone()[0]:
        raise SystemExit('Refusing a home containing other projects')
    db.execute('INSERT OR REPLACE INTO projection_projects '
               '(project_id,title,workspace_root,scripts_json,created_at,updated_at) '
               'VALUES (?,?,?,?,?,?)',
               (project_id, 'Toolbar fixture', str(repo), json.dumps([script]), stamp, stamp))
    db.execute('INSERT OR REPLACE INTO orchestration_v2_projection_threads '
               '(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,'
               'created_at,updated_at,payload_json,provider_instance_id) '
               'VALUES (?,?,?,?,?,?,?,?,?,?)',
               (thread_id,project_id,thread['title'],'codex','full-access','default',
                stamp,stamp,json.dumps(thread),'codex'))
print(json.dumps(dict(projectId=project_id, threadId=thread_id, repository=str(repo))))
