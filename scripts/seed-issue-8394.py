"""Disposable visual projections only. Run with the isolated dev server stopped.
Usage: python3 scripts/seed-issue-8394.py /absolute/isolated/statev2.sqlite
Uses committed sanitized synthetic records; never use live state.
Initialize a fresh home with `vp run dev --home-dir /tmp/issue-8394-clean/.t3`,
stop it, then seed its userdata/statev2.sqlite and restart with the same option.
This is projection-only visual state: replay can replace it. No provider runs.
After offline reseeding, clear only the browser's thread/shell projection caches
(or use a fresh browser profile) before collecting evidence.
"""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile

path = Path(sys.argv[1]).resolve()
if '.t3/userdata/statev2.sqlite' not in str(path) or path == Path.home() / '.t3/userdata/statev2.sqlite':
    raise SystemExit('An isolated worktree database is required')
if not path.is_file():
    raise SystemExit('Initialize the isolated database with the app first')
c = sqlite3.connect(path)
fixture = json.loads(Path(__file__).with_name('fixtures').joinpath('issue-8394.json').read_text())
for table, rows in fixture.items():
    columns = {r[1] for r in c.execute('pragma table_info(' + table + ')')}
    if not rows or not set(rows[0]).issubset(columns):
        raise SystemExit('Missing or incompatible initialized schema: ' + table)
source = next((r for r in fixture['orchestration_v2_projection_messages'] if r['role'] == 'user'), None)
item = next((r for r in fixture['orchestration_v2_projection_turn_items'] if r['type'] == 'user_message'), None)
if source is None or item is None or json.loads(item['payload_json'])['messageId'] != source['message_id']:
    raise SystemExit('Synthetic source templates missing or inconsistent')
# mkstemp creates the backup 0600 beside the isolated database, not in shared /tmp.
fd, backup_path = tempfile.mkstemp(prefix='seed-backup-', suffix='.sqlite', dir=path.parent)
os.close(fd)
with sqlite3.connect(backup_path) as backup:
    c.backup(backup)
with c:
    for table, rows in fixture.items():
        for row in rows:
            if table == 'projection_projects':
                row['workspace_root'] = str(Path(__file__).resolve().parents[1])
            keys = list(row)
            c.execute('insert or replace into ' + table + ' (' + ','.join(keys) + ') values (' + ','.join('?' for _ in keys) + ')', list(row.values()))
# A fresh 0700 directory, so a planted symlink in shared /tmp cannot redirect the write.
fixture_path = os.path.join(tempfile.mkdtemp(prefix='issue-8394-evidence-'), 'fixture.md')
fixtures = {
'S1': '1. test\n5. test\n8. test\n15. test',
'S2': '1. a\n1. b\n1. c\n\nnext\n\n0. a\n0. b',
'S3': '-       first block\n\n        1. one\n        5. five',
'S4': '1. outer\n   5. nested\n   8. nested\n2. outer',
'S4b': '1. outer\n\n   5. nested\n   8. nested\n2. outer',
'S5': '> 1. quoted\n> 5. quoted',
'S6': '1) one\n5) five',
'S7': '3. three\n100000000. wide marker with enough words to wrap at narrow width\n2. two\n3. three',
'S8': '9. nine\n10. ten\n\nNon-one shorthand\n\n5. five\n5. next\n\nZero reset\n\n0. zero\n2. two',
'S9': 'Plain prose\n\n- bullet\n- [ ] task\n- [x] done\n\n```\n1. test\n5. test\n8. test\n15. test\n```\n\n1\\. literal\n\n<ol><li value="8">HTML</li></ol>',
'S9empty': '',
'S9whitespace': '   \n\t',
'S10': '1. test\n5. test\n8. test\n15. test',
'R4stream': '1. test\n5. test\n8. test\n15. test\n\nDigit boundary\n\n9. nine\n10. ten\n\n```text\nsynthetic streamed code\n```',
'R4settled': '1. test\n5. test\n8. test\n15. test\n\nDigit boundary\n\n9. nine\n10. ten\n\n```text\nsynthetic streamed code\n```',
'R3automation': '[Triggered by schedule task: synthetic]\n\nSynthetic automation\n\n1. test\n5. test\n8. test\n15. test',
'R5': '1. test\n5. test\n8. test\n15. test\n\n[fixture.md](t3-context://v1/mention/issue8394_file)',
'S10file': '[Open synthetic Markdown fixture](' + fixture_path + ')',
'R3': '1. test\n5. test\n8. test\n15. test\n\n' + ('Synthetic long message paragraph with 15 target.\n\n' * 100),
}
with c:
    c.execute("update orchestration_v2_projection_threads set title='Issue 8394 synthetic evidence', payload_json=json_set(payload_json,'$.title','Issue 8394 synthetic evidence') where thread_id=?", (source['thread_id'],))
    for n, (label, text) in enumerate(fixtures.items()):
        row = dict(source)
        mid = 'issue-8394-' + label
        payload = json.loads(row['payload_json'])
        stamp = (datetime(2026, 10, 22, 0, 46, 5, tzinfo=timezone.utc) + timedelta(seconds=n)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        payload.update(id=mid, text=text if label in ('R3automation', 'S9empty', 'S9whitespace') else label + '\n\n' + text, createdAt=stamp, updatedAt=stamp)
        row.update(created_at=stamp, updated_at=stamp)
        row.update(message_id=mid)
        if label in ('S10', 'R4stream', 'R4settled'):
            row['role'] = payload['role'] = 'assistant'
            payload['createdBy'] = 'agent'
            payload['creationSource'] = 'provider'
        if label == 'R3automation':
            payload['createdBy'] = 'agent'
        if label == 'R5':
            payload['context'] = {'version': 1, 'records': [{'version': 1, 'contextId': 'issue8394_file', 'kind': 'mention', 'label': 'fixture.md', 'path': fixture_path}]}
        if label == 'R4stream':
            payload['streaming'] = True
            row['streaming'] = 1
        row['payload_json'] = json.dumps(payload)
        keys = list(row)
        c.execute('insert or replace into orchestration_v2_projection_messages ('+','.join(keys)+') values ('+','.join('?' for _ in keys)+')', list(row.values()))
        ir = dict(item)
        ip = json.loads(ir['payload_json'])
        iid = 'turn-item:' + mid
        ip.update(id=iid, messageId=mid, text=payload['text'], ordinal=1000010+n, startedAt=stamp, completedAt=stamp, updatedAt=stamp)
        ir['updated_at'] = stamp
        if label == 'R3automation':
            ip['createdBy'] = 'agent'
        if label == 'R5':
            ip['context'] = payload['context']
        if label in ('S10', 'R4stream', 'R4settled'):
            ip.update(type='assistant_message', streaming=label == 'R4stream')
            ir['type'] = 'assistant_message'
        ir.update(turn_item_id=iid, ordinal=ip['ordinal'], payload_json=json.dumps(ip))
        keys = list(ir)
        c.execute('insert or replace into orchestration_v2_projection_turn_items ('+','.join(keys)+') values ('+','.join('?' for _ in keys)+')', list(ir.values()))
with c:
    for n in range(2):
        ir = dict(item)
        ip = json.loads(ir['payload_json'])
        iid = 'turn-item:issue-8394-thought-' + str(n)
        for key in ['messageId', 'inputIntent', 'attachments', 'createdBy', 'creationSource']:
            ip.pop(key, None)
        ip.update(id=iid, type='reasoning', text='1. thought\n5. thought\n8. thought\n15. thought', streaming=False, ordinal=1000040+n)
        ir.update(turn_item_id=iid, type='reasoning', ordinal=ip['ordinal'], payload_json=json.dumps(ip))
        keys = list(ir)
        c.execute('insert or replace into orchestration_v2_projection_turn_items ('+','.join(keys)+') values ('+','.join('?' for _ in keys)+')', list(ir.values()))
with open(fixture_path, 'x') as f:
    f.write('1. test\n5. test\n8. test\n15. test\n\n<ol start="3"><li>first</li><li value="100">second</li><li>third</li></ol>\n')
print('Backup:', backup_path)
print('Fixture:', fixture_path)
print('Thread:', source['thread_id'])
