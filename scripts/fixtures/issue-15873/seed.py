"""Seed stopped, disposable T3 projection state. No events, effects, or auth are written.

Usage: python3 scripts/fixtures/issue-15873/seed.py <worktree>/.t3/userdata/statev2.sqlite
The database must have been migrated by that product SHA and its server stopped.
"""
import copy
import json
import pathlib
import sqlite3
import sys
import re
import uuid

HERE = pathlib.Path(__file__).resolve().parent


def fixtures():
    original = json.loads((HERE / 'runtime.json').read_text())
    output = {}
    for name in ('G', 'A', 'S', 'C', 'L'):
        data = copy.deepcopy(original)
        thread = data['orchestration_v2_projection_threads'][0]['thread_id']
        # Separate all identities, retaining percent-encoded references and async-answer linkage.
        encoded = json.dumps(data)
        # Native item identities are global primary keys, even across fixture threads.
        tokens = set(re.findall(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:msg_|call_|rs_)[0-9a-f]+', encoded))
        for token in sorted(tokens, key=len, reverse=True):
            encoded = encoded.replace(token, str(uuid.uuid5(uuid.NAMESPACE_URL, 'issue-15873/' + name + '/' + token)))
        encoded = encoded.replace('provider-session:provider-instance:codex:shared', 'provider-session:provider-instance:codex:fixture-' + name)
        data = json.loads(encoded)
        items = data['orchestration_v2_projection_turn_items']
        if name in ('A', 'L', 'C'):
            second = data['orchestration_v2_projection_runs'][1]['run_id']
            for table, rows in data.items():
                if table.startswith('orchestration_v2_') and table != 'orchestration_v2_projection_checkpoint_scopes':
                    data[table] = [r for r in rows if r.get('run_id') != second and not (table == 'orchestration_v2_projection_provider_turns' and ':ordinal:2:' in r['run_attempt_id'].replace('%3A', ':'))]
            nodes = {r['node_id'] for r in data['orchestration_v2_projection_nodes']}
            data['orchestration_v2_projection_provider_turns'] = [r for r in data['orchestration_v2_projection_provider_turns'] if r['node_id'] in nodes]
            for r in data['orchestration_v2_projection_checkpoints']:
                p = json.loads(r['payload_json'])
                if p['nodeId'] not in nodes:
                    p['nodeId'] = data['orchestration_v2_projection_runs'][0]['payload_json'] and json.loads(data['orchestration_v2_projection_runs'][0]['payload_json'])['rootNodeId']
                    r['node_id'] = p['nodeId']; r['payload_json'] = json.dumps(p)
            ids = {r['turn_item_id'] for r in data['orchestration_v2_projection_turn_items']}
            data = json.loads(json.dumps(data).replace(':ordinal:3', ':ordinal:2').replace('%3Aordinal%3A3', '%3Aordinal%3A2').replace('%253Aordinal%253A3', '%253Aordinal%253A2'))
            for r in data['orchestration_v2_projection_runs']:
                if r['ordinal'] == 3:
                    r['ordinal'] = 2
                    p = json.loads(r['payload_json']); p['ordinal'] = 2; r['payload_json'] = json.dumps(p)
        if name == 'C':
            first = data['orchestration_v2_projection_runs'][0]['run_id']
            later = data['orchestration_v2_projection_runs'][1]['run_id']
            root_id = json.loads(data['orchestration_v2_projection_runs'][0]['payload_json'])['rootNodeId']
            answer = next(r for r in data['orchestration_v2_projection_turn_items'] if json.loads(r['payload_json']).get('messageId', '').startswith('async-answer:'))
            message_id = json.loads(answer['payload_json'])['messageId']
            for table, rows in data.items():
                if table.startswith('orchestration_v2_') and table != 'orchestration_v2_projection_checkpoint_scopes':
                    data[table] = [r for r in rows if r is answer or r.get('message_id') == message_id or r.get('run_id') != later]
            for table in ('orchestration_v2_projection_messages', 'orchestration_v2_projection_turn_items'):
                for r in data[table]:
                    p = json.loads(r['payload_json'])
                    if p.get('id') == message_id or p.get('messageId') == message_id:
                        r['run_id'] = first; r['node_id'] = root_id
                        p['runId'] = first; p['nodeId'] = root_id
                        for key in ('createdAt', 'startedAt', 'completedAt', 'updatedAt'):
                            if key in p: p[key] = '2026-10-21T23:24:01.000Z'
                        for column, key in (('created_at', 'createdAt'), ('updated_at', 'updatedAt')):
                            if column in r: r[column] = p[key]
                        if 'ordinal' in p: p['ordinal'] = 1000007; r['ordinal'] = 1000007
                        r['payload_json'] = json.dumps(p)
                    elif p.get('runId') == first and p.get('ordinal', 0) >= 1000007:
                        p['ordinal'] += 1; r['ordinal'] = p['ordinal']; r['payload_json'] = json.dumps(p)
            for table in ('orchestration_v2_projection_turn_items', 'orchestration_v2_projection_runtime_requests'):
                for r in data[table]:
                    p = json.loads(r['payload_json'])
                    if 'resolvedAt' in p: p['resolvedAt'] = '2026-10-21T23:24:01.000Z'; r['resolved_at'] = p['resolvedAt']
                    r['payload_json'] = json.dumps(p)
            nodes = {r['node_id'] for r in data['orchestration_v2_projection_nodes']}
            data['orchestration_v2_projection_provider_turns'] = [r for r in data['orchestration_v2_projection_provider_turns'] if r['node_id'] in nodes]
        if name == 'L':
            long_answer = '\n\n'.join([
                'Blue. Use the following accessible palette and preserve the chronological placement of this answer.',
                *[f'{i}. Keep the answer visible after the question has finished. This paragraph provides enough free text to wrap naturally on a narrow phone while retaining the full answer for copying and search.' for i in range(1, 8)],
                '```text\nwide_palette_reference: blue indigo violet teal amber orange rose emerald sky cobalt\n```',
                'Final confirmation: LATE_TAIL_15873.'])
            for table in ('orchestration_v2_projection_messages', 'orchestration_v2_projection_turn_items', 'orchestration_v2_projection_runtime_requests'):
                for r in data[table]:
                    p = json.loads(r['payload_json'])
                    if p.get('id', '').startswith('async-answer:') or p.get('messageId', '').startswith('async-answer:'):
                        p['text'] = 'Which color should the late-answer probe use?\n' + long_answer
                    if 'questionAnswer' in p:p['questionAnswer']['answers']['0'] = long_answer
                    if 'answers' in p:p['answers']['0'] = long_answer
                    r['payload_json'] = json.dumps(p)
        if name == 'S':
            for r in data['orchestration_v2_projection_turn_items']:
                p = json.loads(r['payload_json'])
                if p.get('messageId', '').startswith('async-answer:'):
                    p['inputIntent'] = 'steer'
                    r['payload_json'] = json.dumps(p)
        tr = data['orchestration_v2_projection_threads'][0]
        tr['title'] = name + ' — ' + {'G':'Queued gap', 'A':'Adjacent answer', 'S':'Settled steer replay (active unverified)', 'C':'Same-run control', 'L':'Long answer'}[name]
        p = json.loads(tr['payload_json']); p['title'] = tr['title']; tr['payload_json'] = json.dumps(p)
        # Normalize derived chronology and checkpoint links after removing a run.
        retained_runs = {r['run_id']: r['ordinal'] for r in data['orchestration_v2_projection_runs']}
        last_run_ordinal = max(retained_runs.values())
        for r in data['orchestration_v2_projection_provider_threads']:
            p = json.loads(r['payload_json'])
            if r['last_run_ordinal'] != last_run_ordinal or p['lastRunOrdinal'] != last_run_ordinal:
                r['last_run_ordinal'] = p['lastRunOrdinal'] = last_run_ordinal
                r['payload_json'] = json.dumps(p)
        for r in data['orchestration_v2_projection_turn_items']:
            p = json.loads(r['payload_json'])
            if p.get('runId') and p['ordinal'] >= 2000000:
                p['ordinal'] = retained_runs[p['runId']] * 1000000 + p['ordinal'] % 1000000
                r['ordinal'] = p['ordinal']; r['payload_json'] = json.dumps(p)
        previous = None
        for i, r in enumerate(data['orchestration_v2_projection_checkpoints']):
            p = json.loads(r['payload_json']); p['parentCheckpointId'] = previous
            r['app_run_ordinal'] = p['appRunOrdinal'] = retained_runs.get(r['run_id'])
            r['parent_checkpoint_id'] = previous
            previous = p['id']; r['payload_json'] = json.dumps(p)
        if data['orchestration_v2_projection_checkpoint_scopes']:
            r = data['orchestration_v2_projection_checkpoint_scopes'][0]
            p = json.loads(r['payload_json'])
            if r.get('run_id') not in retained_runs:
                root = json.loads(data['orchestration_v2_projection_runs'][0]['payload_json'])
                r['run_id'] = p['runId'] = root['id']; r['node_id'] = p['nodeId'] = root['rootNodeId']
            for key in ('latestCheckpointId', 'lastCheckpointId'):
                if key in p: p[key] = previous
            r['payload_json'] = json.dumps(p)
        data['orchestration_v2_turn_item_positions'] = [dict(thread_id=r['thread_id'], turn_item_id=r['turn_item_id'], ordinal=r['ordinal']) for r in data['orchestration_v2_projection_turn_items']]
        validate(data)
        output[name] = data
    return output


def validate(data):
    runs = {r['run_id']: r['ordinal'] for r in data['orchestration_v2_projection_runs']}
    last_run_ordinal = max(runs.values())
    nodes = {r['node_id'] for r in data['orchestration_v2_projection_nodes']}
    messages = {r['message_id']: json.loads(r['payload_json']) for r in data['orchestration_v2_projection_messages']}
    positions = set()
    for table, rows in data.items():
        for r in rows:
            assert not r.get('run_id') or r['run_id'] in runs, (table, 'run', r)
            assert not r.get('node_id') or r['node_id'] in nodes, (table, 'node', r)
            if 'payload_json' in r:
                p = json.loads(r['payload_json'])
                if r.get('run_id'): assert p.get('runId', p.get('id')) == r['run_id'], table
                for column, key in (('created_at', 'createdAt'), ('updated_at', 'updatedAt')):
                    if column in r and key in p: assert r[column] == p[key], (table, column)
                if table == 'orchestration_v2_projection_runs':
                    assert r['ordinal'] == p['ordinal'], 'run ordinal mismatch'
                if table == 'orchestration_v2_projection_provider_threads':
                    assert r['last_run_ordinal'] == p['lastRunOrdinal'] == last_run_ordinal, 'last run ordinal mismatch'
                if table == 'orchestration_v2_projection_checkpoints':
                    assert r['app_run_ordinal'] == p['appRunOrdinal'] == runs.get(r['run_id']), 'checkpoint run ordinal mismatch'
            if table == 'orchestration_v2_projection_turn_items':
                assert r['ordinal'] not in positions, ('duplicate position', r['ordinal'])
                positions.add(r['ordinal'])
                if p.get('messageId'):
                    m = messages[p['messageId']]
                    assert m['text'] == p['text'] and m['runId'] == p['runId'], 'message mismatch'
    assert all(json.loads(r['payload_json'])['status'] == 'completed' for r in data['orchestration_v2_projection_runs'])


def seed(db_path):
    path = pathlib.Path(db_path).resolve()
    disposable = HERE.parents[2] / '.t3'
    live = (pathlib.Path.home() / '.t3').resolve()
    if path.name != 'statev2.sqlite' or not path.is_relative_to(disposable) or path.is_relative_to(live):
        raise ValueError('Only a migrated disposable worktree .t3 database is accepted')
    all_data = fixtures()
    db = sqlite3.connect(path)
    db.execute('PRAGMA foreign_keys=OFF')
    with db:
        for data in all_data.values():
            for table, rows in data.items():
                for row in rows:
                    if table == 'projection_projects':
                        row = dict(row, workspace_root=str(HERE.parents[2]))
                    columns = list(row)
                    db.execute(f'INSERT OR REPLACE INTO {table} ({",".join(columns)}) VALUES ({",".join("?" for _ in columns)})', list(row.values()))
    db.close()
    for name,data in all_data.items():
        print(name, data['orchestration_v2_projection_threads'][0]['thread_id'])


if __name__ == '__main__':
    seed(sys.argv[1])
