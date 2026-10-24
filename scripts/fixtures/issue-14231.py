#!/usr/bin/env python3
"""Seed synthetic question UI projections in a stopped, migrated isolated T3 home.

Usage: python3 scripts/fixtures/issue-14231.py /absolute/isolated/home
This fixture does not create event history or prove provider response behavior.
"""
import argparse
import json
from pathlib import Path
import sqlite3
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('home', type=Path)
parser.add_argument('--variant', help='Seed only this additional named variant, e.g. replacement-1440-light')
parser.add_argument('--only', choices=['repro', 'multi', 'baseline', 'empty', 'short'])
args = parser.parse_args()
home = args.home.resolve()
if home == (Path.home() / '.t3').resolve() or not (home / 'userdata/statev2.sqlite').is_file():
    parser.error('Use an initialized isolated home, never the live ~/.t3 home')
c = sqlite3.connect(home / 'userdata/statev2.sqlite')
now = '2026-10-21T12:00:00.000Z'
project = 'issue-14231-project'
workspace = Path(tempfile.gettempdir()) / 't3-issue-14231-synthetic-workspace'
workspace.mkdir(exist_ok=True)
model = {'instanceId': 'codex', 'model': 'gpt-6-astra'}

def insert(table, row):
    columns = ','.join(row)
    c.execute(f'INSERT OR REPLACE INTO {table} ({columns}) VALUES ({",".join("?" for _ in row)})', tuple(json.dumps(v) if isinstance(v, (dict, list)) else v for v in row.values()))

question = dict(id='direction', header='Direction', question='Which implementation direction should we take? Read the earlier thread before answering.', options=[dict(label='Incremental', description='Change one module at a time'), dict(label='Complete', description='Finish the full implementation')], multiSelect=False)
multi = [
    dict(id='scope', header='Scope', question='Which areas should change? Select all that apply before reading the earlier thread.', options=[dict(label='Web', description='Shared browser interface', value='web'), dict(label='Desktop', description='Electron interface', value='desktop')], multiSelect=True),
    dict(id='direction', header='Direction', question='Which implementation direction should we take?', options=question['options'], multiSelect=False),
    dict(id='notes', header='Notes', question='Edit the proposed answer or keep it as written.', options=[], initialAnswer='Keep the header visible.', multiSelect=False),
    dict(id='confirm', header='Confirm', question='Choose the release target. A custom answer is unavailable.', options=[dict(label='Nightly', description='Preview release', value='nightly'), dict(label='Stable', description='Regular release', value='stable')], multiSelect=False, allowCustomAnswer=False),
]
fixtures = [('repro', 'Question composer reproduction', [question], 24), ('multi', 'Question navigation proof', multi, 24), ('baseline', 'Composer baseline proof', None, 24), ('empty', 'Empty question boundary', [], 24), ('short', 'Short history proof', [question], 1)]
fixtures = [(suffix + variant, title, questions, count) for variant in (['-' + args.variant] if args.variant else ['', '-1440-light', '-1440-dark', '-390-light', '-390-dark']) for suffix, title, questions, count in fixtures if args.only is None or suffix == args.only]
with c:
    insert('projection_projects', dict(project_id=project, title='Synthetic question proof', workspace_root=str(workspace), scripts_json=[], created_at=now, updated_at=now, deleted_at=None, default_model_selection_json=model, default_thread_env_mode=None, favicon_path=None, auto_pull=0, project_icon_json=None))
    for suffix, title, questions, count in fixtures:
        tid = f'issue-14231-{suffix}'
        rid = f'{tid}-run'
        nid = f'{tid}-node'
        for table in ['messages', 'turn_items', 'runtime_requests', 'runs', 'threads']:
            c.execute(f'DELETE FROM orchestration_v2_projection_{table} WHERE thread_id=?', (tid,))
        thread = dict(createdBy='user', creationSource='web', id=tid, projectId=project, title=title, providerInstanceId='codex', modelSelection=model, runtimeMode='full-access', interactionMode='default', branch=None, worktreePath=None, pullRequests=[], activeProviderThreadId=None, lineage=dict(parentThreadId=None, relationshipToParent=None, rootThreadId=tid), forkedFrom=None, createdAt=now, updatedAt=now, archivedAt=None, settledOverride=None, settledAt=None, lastVisitedAt=None, deletedAt=None)
        insert('orchestration_v2_projection_threads', dict(thread_id=tid, project_id=project, title=title, default_provider='codex', runtime_mode='full-access', interaction_mode='default', active_provider_thread_id=None, created_at=now, updated_at=now, archived_at=None, deleted_at=None, payload_json=thread, provider_instance_id='codex'))
        run = dict(id=rid, threadId=tid, ordinal=count+1, providerInstanceId='codex', modelSelection=model, providerThreadId=None, userMessageId=f'{tid}-message-0', rootNodeId=nid, activeAttemptId=None, status='completed', queuePosition=None, requestedAt=now, startedAt=now, completedAt=now, checkpointId=None, contextHandoffId=None, workspacePreparation=dict(type='root'))
        insert('orchestration_v2_projection_runs', dict(run_id=rid, thread_id=tid, ordinal=count+1, provider='codex', provider_thread_id=None, status='completed', requested_at=now, completed_at=now, payload_json=run, provider_instance_id='codex'))
        for i in range(count):
            stamp = f'2026-10-21T11:{i:02}:00.000Z'
            mid = f'{tid}-message-{i}'
            rid = f'{tid}-run-{i}'
            history_run = dict(run, id=rid, ordinal=i+1, userMessageId=mid, requestedAt=stamp, startedAt=stamp, completedAt=stamp)
            insert('orchestration_v2_projection_runs', dict(run_id=rid, thread_id=tid, ordinal=i+1, provider='codex', provider_thread_id=None, status='completed', requested_at=stamp, completed_at=stamp, payload_json=history_run, provider_instance_id='codex'))
            text = f'## Timeline entry {i+1}\n\n' + 'This is thread history to read before answering the pending question.\n\n' * 3
            message = dict(createdBy='user', creationSource='web', id=mid, threadId=tid, runId=rid, nodeId=None, role='assistant', text=text, attachments=[], streaming=False, createdAt=stamp, updatedAt=stamp)
            insert('orchestration_v2_projection_messages', dict(message_id=mid, thread_id=tid, run_id=rid, node_id=None, role='assistant', streaming=0, created_at=stamp, updated_at=stamp, payload_json=message))
            item = dict(createdBy='user', creationSource='web', id=mid, threadId=tid, runId=rid, nodeId=None, providerThreadId=None, providerTurnId=None, nativeItemRef=None, parentItemId=None, ordinal=i, status='completed', title=None, startedAt=stamp, completedAt=stamp, updatedAt=stamp, type='assistant_message', messageId=mid, text=text, streaming=False)
            insert('orchestration_v2_projection_turn_items', dict(turn_item_id=mid, thread_id=tid, run_id=rid, node_id=None, provider_thread_id=None, provider_turn_id=None, parent_item_id=None, ordinal=i, type='assistant_message', status='completed', updated_at=stamp, payload_json=item))
        rid = f'{tid}-run'
        if questions is not None:
            reqid = f'{tid}-request'
            request = dict(id=reqid, nodeId=nid, providerTurnId=None, nativeRequestRef=None, kind='user_input', status='pending', responseCapability=dict(type='message'), createdAt=now, resolvedAt=None)
            insert('orchestration_v2_projection_runtime_requests', dict(runtime_request_id=reqid, thread_id=tid, node_id=nid, provider_turn_id=None, kind='user_input', status='pending', created_at=now, resolved_at=None, payload_json=request))
            item = dict(createdBy='user', creationSource='web', id=f'{tid}-question', threadId=tid, runId=rid, nodeId=nid, providerThreadId=None, providerTurnId=None, nativeItemRef=None, parentItemId=None, ordinal=count, status='completed', title=None, startedAt=now, completedAt=now, updatedAt=now, type='user_input_request', requestId=reqid, questions=questions)
            insert('orchestration_v2_projection_turn_items', dict(turn_item_id=item['id'], thread_id=tid, run_id=rid, node_id=nid, provider_thread_id=None, provider_turn_id=None, parent_item_id=None, ordinal=count, type=item['type'], status='completed', updated_at=now, payload_json=item))
print(f'Seeded {len(fixtures)} synthetic fixture threads in {home}')
