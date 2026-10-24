#!/usr/bin/env python3
"""Seed ephemeral projections in a stopped sandbox initialized with one stopped thread."""
import argparse
import copy
import json
from pathlib import Path
import sqlite3

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('worktree', type=Path)
parser.add_argument('--servers-stopped', action='store_true', required=True)
args = parser.parse_args()
root = args.worktree.resolve()
db = root / '.t3/userdata/statev2.sqlite'
if not (root / '.git').exists() or not db.is_file():
    parser.error('Expected an existing isolated git worktree .t3 database')
if db.resolve().is_relative_to(Path.home() / '.t3/userdata'):
    parser.error('Refusing the live T3 home')
fixture = json.loads(Path(__file__).with_name('fixture.json').read_text())
settled = copy.deepcopy(fixture)
settled['id'] = fixture['id'] + ':settled-fixture'
settled['title'] = 'Mixed PR badge settled — 3 open, 3 closed'
settled['lineage']['rootThreadId'] = settled['id']
settled['settledOverride'] = 'settled'
settled['settledAt'] = fixture['updatedAt']
con = sqlite3.connect(db)
con.row_factory = sqlite3.Row
with con:
    projection = con.execute('SELECT * FROM orchestration_v2_projection_threads LIMIT 1').fetchone()
    if projection is None:
        raise SystemExit('Initialize the sandbox once and create a stopped thread before seeding')
    stamp = fixture['updatedAt']
    con.execute("INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET title=excluded.title,workspace_root=excluded.workspace_root,updated_at=excluded.updated_at", (fixture['projectId'], 'server', str(root / 'apps/server'), '[]', stamp, stamp))
    for thread in (fixture, settled):
        encoded = json.dumps(thread, separators=(',', ':'))
        row = dict(projection)
        row.update(project_id=thread['projectId'], default_provider='codex', provider_instance_id='codex', runtime_mode=thread['runtimeMode'], interaction_mode=thread['interactionMode'], active_provider_thread_id=None, thread_id=thread['id'],title=thread['title'],created_at=thread['createdAt'],updated_at=thread['updatedAt'],archived_at=None,deleted_at=None,payload_json=encoded)
        columns = ','.join(row)
        con.execute(f'INSERT OR REPLACE INTO orchestration_v2_projection_threads ({columns}) VALUES ({",".join("?" for _ in row)})', tuple(row.values()))
print(f'Seeded F and F-settled in {db}')
