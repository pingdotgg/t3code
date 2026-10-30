#!/usr/bin/env python3
"""Rebuild synthetic markdown projections in stopped, migrated isolated DBs.

Usage: python3 seed-issue-16105.py /absolute/worktree/.t3 [...]
No existing project/thread or event history is needed. These projection-only
visual/search fixtures must never be used for provider or orchestration tests.
"""
import copy
import json
import pathlib
import socket
import sqlite3
import sys

folder = pathlib.Path(__file__).parent
fixture = json.loads((folder / 'issue-16105.json').read_text())
templates = json.loads((folder / 'issue-16105-skeleton.json').read_text())
for port in (14829, 15209):
    with socket.socket() as probe:
        if probe.connect_ex(('127.0.0.1', port)) == 0:
            raise SystemExit(f'Stop proof server on {port} before seeding')
for argument in sys.argv[1:]:
    home = pathlib.Path(argument).resolve()
    if home.name != '.t3' or home == pathlib.Path.home() / '.t3':
        raise SystemExit('Only explicit isolated worktree .t3 homes are allowed')
    database = home / 'userdata/statev2.sqlite'
    if not database.is_file():
        raise SystemExit('Initialize/migrate this isolated database first')
    connection = sqlite3.connect(database)
    thread = fixture['threadId']
    project = '8129f6fb-0c4b-4e6b-9527-879d6b27b934'
    stamp = fixture['timestamp']
    backup = database.with_suffix('.before-16105-seed.sqlite')
    if not backup.exists():
        with sqlite3.connect(backup) as target:
            connection.backup(target)
    rows = {}
    def add(table, row):
        rows.setdefault(table, []).append(row)
    def projected(table, payload, **columns):
        add(table, {**columns, 'payload_json': json.dumps(payload)})
    add('projection_projects', dict(project_id=project,title='16105 synthetic proof',workspace_root=str(home.parent),scripts_json='[]',created_at=stamp,updated_at=stamp,deleted_at=None))
    body = copy.deepcopy(templates['thread'])
    body.update(id=thread,projectId=project)
    projected('orchestration_v2_projection_threads',body,thread_id=thread,project_id=project,title=body['title'],default_provider='codex',provider_instance_id='codex',runtime_mode=body['runtimeMode'],interaction_mode=body['interactionMode'],active_provider_thread_id=None,created_at=stamp,updated_at=stamp,archived_at=None,deleted_at=None)
    run_ordinal = 0
    for index, case in enumerate(fixture['messages']):
        if case['role'] == 'user':
            run_ordinal += 1
            run = f'run:proof-16105:{run_ordinal}'
            root = f'node:proof-16105:{run_ordinal}:root'
            message_id = f'message:proof-16105:{case["fixture"]}'
            body = copy.deepcopy(templates['run'])
            body.update(id=run,threadId=thread,ordinal=run_ordinal,userMessageId=message_id,rootNodeId=root)
            projected('orchestration_v2_projection_runs',body,run_id=run,thread_id=thread,ordinal=run_ordinal,provider='codex',provider_instance_id='codex',provider_thread_id=None,status='completed',requested_at=stamp,completed_at=stamp)
            body = copy.deepcopy(templates['rootNode'])
            body.update(id=root,threadId=thread,runId=run,rootNodeId=root,parentNodeId=None)
            projected('orchestration_v2_projection_nodes',body,node_id=root,thread_id=thread,run_id=run,parent_node_id=None,root_node_id=root,kind='root_turn',status='completed',provider_thread_id=None,provider_turn_id=None,runtime_request_id=None,checkpoint_scope_id=None,started_at=stamp,completed_at=stamp)
        role = case['role']
        message_id = f'message:proof-16105:{case["fixture"]}'
        node = root if role == 'user' else f'node:proof-16105:{case["fixture"]}'
        if role == 'assistant':
            body = copy.deepcopy(templates['assistantNode'])
            body.update(id=node,threadId=thread,runId=run,parentNodeId=root,rootNodeId=root)
            projected('orchestration_v2_projection_nodes',body,node_id=node,thread_id=thread,run_id=run,parent_node_id=root,root_node_id=root,kind='assistant_message',status='completed',provider_thread_id=None,provider_turn_id=None,runtime_request_id=None,checkpoint_scope_id=None,started_at=stamp,completed_at=stamp)
        message = copy.deepcopy(templates[role+'Message'])
        message.update(id=message_id,threadId=thread,runId=run,nodeId=node,text=case['text'])
        item = copy.deepcopy(templates[role+'Item'])
        item_id = f'turn-item:proof-16105:{case["fixture"]}'
        ordinal = (index+1)*1000000
        item.update(id=item_id,threadId=thread,runId=run,nodeId=node,messageId=message_id,text=case['text'],ordinal=ordinal)
        for key in ('context','scheduledTaskId'):
            if key in case:
                message[key] = case[key]
                item[key] = case[key]
        projected('orchestration_v2_projection_messages',message,message_id=message_id,thread_id=thread,run_id=run,node_id=node,role=role,streaming=0,created_at=stamp,updated_at=stamp)
        projected('orchestration_v2_projection_turn_items',item,turn_item_id=item_id,thread_id=thread,run_id=run,node_id=node,provider_thread_id=None,provider_turn_id=None,parent_item_id=None,ordinal=ordinal,type=role+'_message',status='completed',updated_at=stamp)
        add('orchestration_v2_turn_item_positions',dict(thread_id=thread,turn_item_id=item_id,ordinal=ordinal))
    with connection:
        tables = [r[0] for r in connection.execute("SELECT name FROM sqlite_schema WHERE type='table' AND (name LIKE 'orchestration_v2_projection_%' OR name='orchestration_v2_turn_item_positions')")]
        for table in tables:
            if 'thread_id' in [r[1] for r in connection.execute(f'PRAGMA table_info({table})')]:
                connection.execute(f'DELETE FROM {table} WHERE thread_id=?',(thread,))
        for table, values in rows.items():
            for row in values:
                keys = ','.join(row)
                placeholders = ','.join('?' for _ in row)
                connection.execute(f'INSERT OR REPLACE INTO {table} ({keys}) VALUES ({placeholders})',list(row.values()))
    manifest = database.with_name('issue-16105-seeded.json')
    manifest.write_text(json.dumps({'fixture':fixture,'rows':rows},indent=2)+'\n')
    connection.close()
    print(json.dumps({'database':str(database),'manifest':str(manifest),'messages':len(fixture['messages'])}))
