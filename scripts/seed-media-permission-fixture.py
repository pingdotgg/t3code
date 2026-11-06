#!/usr/bin/env python3
"""Seed synthetic, projection-only media evidence. Run after migrations, with server stopped.

python3 scripts/seed-media-permission-fixture.py --home .t3/evidence --server-port 13866
Re-run after projection replay. No provider is started; this is visual test data,
not a test of event history. Requires ffmpeg and ffprobe on PATH.
"""
import argparse
import datetime
import json
import pathlib
import socket
import sqlite3
import struct
import subprocess
import zlib

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--home', type=pathlib.Path, required=True)
parser.add_argument('--server-port', type=int, required=True)
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parents[1]
home = args.home.resolve()
assert home.is_relative_to(root / '.t3'), 'Home must be inside this checkout/.t3'
assert not args.home.is_symlink(), 'Do not use symlinked homes'
with socket.socket() as probe:
    assert probe.connect_ex(('127.0.0.1', args.server_port)) != 0, 'Stop the dev server first'
db = home / 'userdata/statev2.sqlite'
assert db.is_file(), 'Initialize migrations with the dev server, then stop it'
connection = sqlite3.connect(db)
assert not connection.execute("select 1 from orchestration_v2_projection_messages where thread_id NOT LIKE 'media-permission-%' limit 1").fetchone(), 'Use a fresh synthetic-only home'
bootstrap = connection.execute("select project_id,workspace_root from projection_projects where project_id != 'media-permission-fixture'").fetchall()
assert all(pathlib.Path(path) == root / 'apps/server' for _, path in bootstrap), 'Unexpected non-fixture project'
backup = db.with_name('statev2.before-media-fixture.' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%f') + '.sqlite')
with sqlite3.connect(backup) as destination:
    connection.backup(destination)
backup.chmod(0o400)
media = home / 'media-permission-fixture'
media.mkdir(exist_ok=True)
assert not media.is_symlink()
def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
# Deterministic RGB checkerboard, without image-library dependencies.
pixels = b''.join(b'\0' + b''.join(bytes((38, 155, 160) if (x//40+y//40)%2 else (244, 182, 78)) for x in range(320)) for y in range(180))
(media/'demo.png').write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB',320,180,8,2,0,0,0)) + chunk(b'IDAT',zlib.compress(pixels)) + chunk(b'IEND',b''))
subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=15','-t','3','-an','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-movflags','+faststart','-map_metadata','-1',str(media/'demo.mp4')],check=True)
probe = json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(media/'demo.mp4')]))
assert probe['streams'][0]['codec_name'] == 'h264' and probe['streams'][0]['pix_fmt'] == 'yuv420p'
(media/'corrupt.mp4').write_text('Synthetic invalid media fixture\n')
(media/'recovery.mp4').unlink(missing_ok=True)
T='2026-10-22T12:00:00.000Z'
P='media-permission-fixture'
selection={'instanceId':'codex','model':'gpt-5.4'}
creation={'createdBy':'agent','creationSource':'provider'}
def insert(table, values):
    connection.execute('INSERT INTO '+table+' ('+','.join(values)+') VALUES ('+','.join('?' for _ in values)+')',list(values.values()))
def payload(table, columns, value):
    insert(table,dict(columns,payload_json=json.dumps(value)))
video=str(media/'demo.mp4'); image=str(media/'demo.png')
fixtures={
 'a1': ('A1 · Denied host video',f'![Demo]({video})\n\n![Image comparison]({image})'),
 'a2': ('A2 · Empty label',f'![]({video})'),
 'a3': ('A3 · Long labels',f'![A deliberately long descriptive video label that explains the synthetic demonstration and should wrap without losing the access explanation]({video})\n\n![{"a"*140}.mp4]({video})'),
 'a4': ('A4 · Authored dimensions',f'<img src="{video}" alt="Demo" width="120" height="68" />'),
 'a5': ('A5 · Reasoning inspector',f'![Demo]({video})'),
 'r1': ('R1 · Inline image',f'Before inline ![Image comparison]({image}) after inline.'),
 'r2': ('R2/R3 · Retry recovery',f'![Demo]({media/"recovery.mp4"})'),
 'r3': ('R3 · Decode failure',f'![Demo]({media/"corrupt.mp4"})'),
 'r7': ('R7 · Host playback',f'![Demo]({video}#t=0.1)\n\n![Image comparison]({image})'),
 'r8': ('R8 · Direct HTTP', f'![Demo](http://localhost:5826/@fs{media}/demo.mp4)\n\n![Broken direct](http://localhost:5826/@fs{media}/corrupt.mp4)'),
}
with connection:
    for project_id, _ in bootstrap:
        connection.execute('DELETE FROM orchestration_v2_projection_threads WHERE project_id=?', (project_id,))
        connection.execute('DELETE FROM projection_projects WHERE project_id=?', (project_id,))
    for suffix in ['turn_items','messages','nodes','runs','threads']:
        connection.execute('DELETE FROM orchestration_v2_projection_'+suffix+' WHERE '+('project_id' if suffix=='threads' else 'thread_id')+('=?' if suffix=='threads' else " LIKE 'media-permission-%'"), (P,) if suffix=='threads' else ())
    connection.execute('DELETE FROM projection_projects WHERE project_id=?',(P,))
    insert('projection_projects',dict(project_id=P,title='Synthetic media evidence',workspace_root=str(media),scripts_json='[]',created_at=T,updated_at=T))
    for key,(title,text) in fixtures.items():
        tid='media-permission-'+key; rid=tid+'-run'; nid=tid+'-root'
        thread=dict(creation,id=tid,projectId=P,title=title,providerInstanceId='codex',modelSelection=selection,runtimeMode='full-access',interactionMode='default',branch=None,worktreePath=None,activeProviderThreadId=None,lineage=dict(parentThreadId=None,relationshipToParent=None,rootThreadId=tid),forkedFrom=None,createdAt=T,updatedAt=T,archivedAt=None,settledOverride='settled',settledAt=T,lastVisitedAt=T,deletedAt=None)
        payload('orchestration_v2_projection_threads',dict(thread_id=tid,project_id=P,title=title,default_provider='codex',provider_instance_id='codex',runtime_mode='full-access',interaction_mode='default',created_at=T,updated_at=T),thread)
        run=dict(id=rid,threadId=tid,ordinal=1,providerInstanceId='codex',modelSelection=selection,providerThreadId=None,userMessageId=tid+'-user',rootNodeId=nid,activeAttemptId=None,status='completed',requestedAt=T,startedAt=T,completedAt=T,checkpointId=None,contextHandoffId=None)
        payload('orchestration_v2_projection_runs',dict(run_id=rid,thread_id=tid,ordinal=1,provider='codex',provider_instance_id='codex',status='completed',requested_at=T,completed_at=T),run)
        node=dict(id=nid,threadId=tid,runId=rid,parentNodeId=None,rootNodeId=nid,kind='root_turn',status='completed',countsForRun=True,providerThreadId=None,providerTurnId=None,nativeItemRef=None,runtimeRequestId=None,checkpointScopeId=None,startedAt=T,completedAt=T)
        payload('orchestration_v2_projection_nodes',dict(node_id=nid,thread_id=tid,run_id=rid,root_node_id=nid,kind='root_turn',status='completed',started_at=T,completed_at=T),node)
        for ordinal,role,body in [(1,'user',title),(3,'assistant',text if key!='a5' else 'Synthetic reasoning fixture complete.')]:
            mid=tid+('-user' if role=='user' else '-assistant')
            message=dict(creation,id=mid,threadId=tid,runId=rid,nodeId=nid,role=role,text=body,attachments=[],streaming=False,createdAt=T,updatedAt=T)
            payload('orchestration_v2_projection_messages',dict(message_id=mid,thread_id=tid,run_id=rid,node_id=nid,role=role,streaming=0,created_at=T,updated_at=T),message)
            item=dict(creation,id=mid+'-item',threadId=tid,runId=rid,nodeId=nid,providerThreadId=None,providerTurnId=None,nativeItemRef=None,parentItemId=None,ordinal=ordinal,status='completed',title=None,startedAt=T,completedAt=T,updatedAt=T,type=role+'_message',messageId=mid,text=body,attachments=[],streaming=False)
            if role=='user': item['inputIntent']='turn_start'
            payload('orchestration_v2_projection_turn_items',dict(turn_item_id=item['id'],thread_id=tid,run_id=rid,node_id=nid,ordinal=ordinal,type=item['type'],status='completed',updated_at=T),item)
        if key=='a5':
            item=dict(id=tid+'-reasoning',threadId=tid,runId=rid,nodeId=nid,providerThreadId=None,providerTurnId=None,nativeItemRef=None,parentItemId=None,ordinal=2,status='completed',title='Synthetic media reasoning',startedAt=T,completedAt=T,updatedAt=T,type='reasoning',text=text,streaming=False)
            payload('orchestration_v2_projection_turn_items',dict(turn_item_id=item['id'],thread_id=tid,run_id=rid,node_id=nid,ordinal=2,type='reasoning',status='completed',updated_at=T),item)
    for key in fixtures:
        tid='media-permission-'+key
        msg=connection.execute("SELECT json_extract(payload_json,'$.text') FROM orchestration_v2_projection_messages WHERE message_id=?",(tid+'-assistant',)).fetchone()[0]
        item=connection.execute("SELECT json_extract(payload_json,'$.text') FROM orchestration_v2_projection_turn_items WHERE turn_item_id=?",(tid+'-assistant-item',)).fetchone()[0]
        assert msg==item
print(json.dumps(dict(home=str(home),backup=str(backup),media=str(media),threads=list(fixtures),ffmpeg=subprocess.check_output(['ffmpeg','-version'],text=True).splitlines()[0],projectionOnly=True),indent=2))
