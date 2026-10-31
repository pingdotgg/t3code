#!/usr/bin/env python3
"""Seed UI-only projections in this worktree's .t3, with its dev server STOPPED.

Run from the repository root: python3 scripts/fixtures/issue-16447.py
Requires an already migrated .t3/userdata/statev2.sqlite. Removes copied project
and conversation projections so no private sidebar/history appears in evidence.
Does not change events or claim backend behavior. Never targets live T3 home.

Deletes every projection table, so it refuses to touch the database until you
mark it disposable yourself, after copying in data you can lose:
  echo issue-16447-disposable > .t3/userdata/statev2.sqlite.issue-16447-disposable
"""
import datetime
import json
from pathlib import Path
import sqlite3

root = Path.cwd().resolve()
db = root / '.t3/userdata/statev2.sqlite'
if not (root / '.git').exists() or not db.exists() or db.resolve() == Path.home() / '.t3/userdata/statev2.sqlite':
    raise SystemExit('Run in the isolated, migrated worktree only')
marker = db.with_name(db.name + '.issue-16447-disposable')
if not marker.is_file() or marker.read_text().strip() != 'issue-16447-disposable':
    raise SystemExit(f'Refusing to delete projections: create {marker} as described in this script\'s docstring')
fixture = json.loads(Path(__file__).with_suffix('.json').read_text())
c = sqlite3.connect(db)
c.execute('PRAGMA foreign_keys=OFF')

def insert(table, row):
    keys = list(row)
    c.execute(f'INSERT INTO {table} ({",".join(keys)}) VALUES ({",".join("?" for _ in keys)})', list(row.values()))

def stamp(n=0):
    return (datetime.datetime(2026, 3, 17, 12, tzinfo=datetime.timezone.utc) + datetime.timedelta(seconds=n)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')

def payload(table, obj, **columns):
    insert('orchestration_v2_projection_' + table, dict(columns, payload_json=json.dumps(obj)))

with c:
    tables = [r[0] for r in c.execute("SELECT name FROM sqlite_schema WHERE type='table'")]
    for table in tables:
        if (table.startswith('orchestration_v2_projection_') and table != 'orchestration_v2_projection_metadata') or table.startswith('projection_'):
            c.execute(f'DELETE FROM {table}')
    insert('projection_projects', dict(project_id='synthetic-minimap', title=fixture['projectTitle'], workspace_root=str(root), scripts_json='[]', created_at=stamp(), updated_at=stamp()))
    model = dict(instanceId='codex', model='gpt-5.4')
    for label, count in [('long', 80), ('two', 2), ('one', 1), ('empty', 0)]:
        tid = 'synthetic-minimap-' + label
        title = f'Minimap {label} — synthetic fixture'
        thread = dict(createdBy='user', creationSource='web', id=tid, projectId='synthetic-minimap', title=title, providerInstanceId='codex', modelSelection=model, runtimeMode='full-access', interactionMode='default', branch=None, worktreePath=None, linkedPullRequest=None, pullRequests=[], activeProviderThreadId=None, lineage=dict(parentThreadId=None, relationshipToParent=None, rootThreadId=tid), forkedFrom=None, createdAt=stamp(), updatedAt=stamp(), archivedAt=None, settledOverride='active', settledAt=None, lastVisitedAt=None, deletedAt=None)
        payload('threads', thread, thread_id=tid, project_id='synthetic-minimap', title=title, default_provider='codex', provider_instance_id='codex', runtime_mode='full-access', interaction_mode='default', created_at=stamp(), updated_at=stamp())
        for i in range(1, count+1):
            rid = f'{tid}-run-{i:03}'
            uid = f'{rid}-user'
            ts = stamp(i*10)
            run = dict(id=rid, threadId=tid, ordinal=i, providerInstanceId='codex', modelSelection=model, providerThreadId=None, userMessageId=uid, rootNodeId=None, activeAttemptId=None, status='completed', queuePosition=None, requestedAt=ts, startedAt=ts, completedAt=stamp(i*10+2), checkpointId=None, contextHandoffId=None, workspacePreparation=dict(type='root'))
            payload('runs', run, run_id=rid, thread_id=tid, ordinal=i, provider='codex', provider_instance_id='codex', status='completed', requested_at=ts, completed_at=stamp(i*10+2))
            for j, role in enumerate(['user', 'assistant']):
                if label=='two' and i==1 and role=='assistant':
                    continue
                text = fixture[role].replace('{n}', str(i))
                if label=='two':
                    text = ('   ' if i==1 else 'Short user message') if role=='user' else 'Short final assistant.'
                elif role=='assistant':
                    text += fixture['longTail'] * 18
                mid = uid if role=='user' else f'{rid}-assistant'
                mt = stamp(i*10+j)
                message = dict(createdBy='user' if role=='user' else 'agent', creationSource='web' if role=='user' else 'provider', id=mid, threadId=tid, runId=rid, nodeId=None, role=role, text=text, attachments=[], streaming=False, createdAt=mt, updatedAt=mt)
                payload('messages', message, message_id=mid, thread_id=tid, run_id=rid, role=role, streaming=0, created_at=mt, updated_at=mt)
                item = dict(id=mid+'-item', threadId=tid, runId=rid, nodeId=None, providerThreadId=None, providerTurnId=None, nativeItemRef=None, parentItemId=None, ordinal=i*1000000+j+1, status='completed', title=None, startedAt=mt, completedAt=mt, updatedAt=mt, type=role+'_message', messageId=mid, text=text, attachments=[])
                if role=='user':
                    item.update(createdBy='user', creationSource='web', inputIntent='turn_start')
                else:
                    item['streaming']=False
                payload('turn_items', item, turn_item_id=item['id'], thread_id=tid, run_id=rid, ordinal=item['ordinal'], type=item['type'], status='completed', updated_at=mt)
            if label=='long' and i%5==0:
                item = dict(id=rid+'-reasoning', threadId=tid, runId=rid, nodeId=None, providerThreadId=None, providerTurnId=None, nativeItemRef=None, parentItemId=None, ordinal=i*1000000+3, status='completed', title=None, startedAt=ts, completedAt=stamp(i*10+2), updatedAt=stamp(i*10+2), type='reasoning', text='Checked synthetic layout and navigation constraints.', streaming=False)
                payload('turn_items', item, turn_item_id=item['id'], thread_id=tid, run_id=rid, ordinal=item['ordinal'], type=item['type'], status='completed', updated_at=item['updatedAt'])
print('Seeded synthetic-only projections: long=80, two=2, one=1, empty=0. No provider calls.')
