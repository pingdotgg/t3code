#!/usr/bin/env python3
"""Seed static image replies by cloning app-written V2 rows; stop the sandbox server first.

Example: python3 scripts/fixtures/image-cache-proof.py --db .t3/userdata/statev2.sqlite
--thread <app-created-thread-id> --workspace /tmp/issue-15676/workspace
Requires Pillow for labelled PNG fixtures. This changes projections only, not event history.
"""
import argparse, json, pathlib, sqlite3
from PIL import Image, ImageDraw, ImageFont

p = argparse.ArgumentParser()
p.add_argument('--db', type=pathlib.Path)
p.add_argument('--thread')
p.add_argument('--template-thread')
p.add_argument('--workspace', type=pathlib.Path, required=True)
p.add_argument('--color', choices=['blue', 'yellow'], default='blue')
p.add_argument('--images-only', action='store_true')
p.add_argument('--board', action='store_true')
p.add_argument('--supplement', action='store_true')
p.add_argument('--font', type=pathlib.Path, help='TrueType font for PNG labels; defaults to Liberation Sans Bold, else Pillow default')
a = p.parse_args()
f = json.loads(pathlib.Path(__file__).with_suffix('.json').read_text())
default_font = pathlib.Path('/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf')
if a.font and not a.font.is_file():
    p.error(f'--font not found: {a.font}')
font_path = a.font or (default_font if default_font.is_file() else None)
font = ImageFont.truetype(str(font_path), 28) if font_path else ImageFont.load_default(28)
label, color, ink = ('BLUE v1', '#1261e8', 'white') if a.color == 'blue' else ('YELLOW v2', '#ffe100', 'black')
def png(path, size):
    image = Image.new('RGB', size, color)
    ImageDraw.Draw(image).text((12, 24), label, font=font, fill=ink)
    image.save(path)
assets = a.workspace / 'fixtures'
assets.mkdir(parents=True, exist_ok=True)
png(f['imagePath'], (360, 100))
png(assets / 'chart.png', (360, 100))
png(assets / 'chart space.png', (360, 100))
png(assets / 'tall.png', (180, 280))
(assets / 'chart.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="360" height="100" viewBox="0 0 360 100"><rect width="360" height="100" fill="'+color+'"/><text x="12" y="55" font-size="28" fill="'+ink+'">'+label+' SVG</text></svg>')
if a.images_only:
    raise SystemExit()
if not a.db or not a.thread:
    p.error('--db and --thread are required for projection seeding')
resolved = a.db.resolve()
if '.t3' not in resolved.parts or resolved.is_relative_to(pathlib.Path.home() / '.t3'):
    p.error('Only an isolated worktree .t3 database is supported')
c = sqlite3.connect(resolved)
c.row_factory = sqlite3.Row
# Keep the first backup: a repeat seed must not replace the pre-seed recovery copy.
backup_path = pathlib.Path(str(resolved)+'.image-proof-backup')
if not backup_path.exists():
    with sqlite3.connect(backup_path) as backup:
        c.backup(backup)
msg = c.execute("SELECT * FROM orchestration_v2_projection_messages WHERE thread_id=? AND role='assistant' LIMIT 1", (a.template_thread or a.thread,)).fetchone()
item = c.execute("SELECT * FROM orchestration_v2_projection_turn_items WHERE thread_id=? AND type='assistant_message' LIMIT 1", (a.template_thread or a.thread,)).fetchone()
if not msg or not item:
    p.error('Create this thread and complete a real provider reply before seeding')
texts = [f['supplement']] if a.supplement else [f['board']] if a.board else [r+' — source BLUE v1\n\n![chart]('+f['imagePath']+')' for r in f['initialReplies']]
with c:
    c.execute('DELETE FROM orchestration_v2_projection_messages WHERE thread_id=?', (a.thread,))
    c.execute('DELETE FROM orchestration_v2_projection_turn_items WHERE thread_id=?', (a.thread,))
    for i, text in enumerate(texts, 1):
        mid, iid = a.thread+'-message-'+str(i), a.thread+'-item-'+str(i)
        for table, template, rowid in [('orchestration_v2_projection_messages',msg,mid), ('orchestration_v2_projection_turn_items',item,iid)]:
            row = dict(template)
            payload = json.loads(row['payload_json'])
            payload.update(id=rowid, text=text, updatedAt=f['timestamp'], threadId=a.thread, nodeId=None, runId='image-proof-static-run-'+str(i))
            row['thread_id'] = a.thread
            row['run_id'] = payload['runId']
            row['node_id'] = payload['nodeId']
            row['updated_at'] = f['timestamp']
            if table.endswith('_messages'):
                row.update(message_id=mid, created_at=f['timestamp'])
                payload['createdAt'] = f['timestamp']
            else:
                row.update(turn_item_id=iid, ordinal=i)
                payload.update(messageId=mid, nativeItemRef=None, providerTurnId=None, ordinal=i, startedAt=f['timestamp'], completedAt=f['timestamp'])
            row['payload_json'] = json.dumps(payload)
            c.execute('INSERT INTO '+table+' ('+','.join(row)+') VALUES ('+','.join('?' for _ in row)+')',tuple(row.values()))
print('Seeded static projection fixture:',len(texts),'assistant replies; event history unchanged')
