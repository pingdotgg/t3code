#!/usr/bin/env python3
"""Synthetic persisted-projection fixture; server must be stopped. Never use live T3 home.
Run from repository root: python3 apps/server/test/fixtures/issue-16099/seed.py
Only client presentation is exercised; this is not backend event-history proof.
"""
from pathlib import Path
import sqlite3,json,copy
root=Path.cwd().resolve(); home=root/'.t3'; workspace=root/'apps/server'
assert (root/'.git').exists() and home.resolve()!=Path.home()/'.t3'
files=workspace/'triage-16099'; files.mkdir(exist_ok=True)
for name in 'abc':
 lines=['<!doctype html>','<html><head><title>Report '+name.upper()+'</title></head><body>','<h1>Report '+name.upper()+'</h1>']
 lines += [f'<p>Report {name.upper()} — synthetic row {i}</p>' for i in range(4,80)]
 lines += ['<p id="marker">LINE 80 — HTML SOURCE REVEAL MARKER</p>','</body></html>']
 (files/(name+'.html')).write_text('\n'.join(lines)+'\n')
(files/'large.html').write_text('<!doctype html><html><body><h1>Large HTML report</h1><p>Full document renders.</p><!--'+'x'*1100000+'--></body></html>\n')
host=Path('/tmp/issue-16099-host.html');host.write_text('<!doctype html><html><body><h1>Host HTML report</h1><p>Synthetic read-only preview outside workspace.</p></body></html>\n')
other=Path('/tmp/issue-16099-other');other.mkdir(exist_ok=True);(other/'other.html').write_text('<!doctype html><html><body><h1>Other workspace report</h1></body></html>\n')
(files/'absent.html').unlink(missing_ok=True)
c=sqlite3.connect(home/'userdata/statev2.sqlite');c.row_factory=sqlite3.Row
pr=c.execute('select * from projection_projects where workspace_root=?',(str(workspace),)).fetchone()
tr=pr and c.execute('select * from orchestration_v2_projection_threads where project_id=?',(pr['project_id'],)).fetchone()
if not tr: raise SystemExit(f'No project with a thread for {workspace} in {home}/userdata/statev2.sqlite; see README prerequisite.')
p=dict(pr);t=dict(tr)
# Keep synthetic presentation only: no copied customer text in public captures.
for table in ['orchestration_v2_projection_turn_items','orchestration_v2_projection_messages','orchestration_v2_projection_threads','projection_projects']:
 c.execute('delete from '+table)
def insert(table,row):c.execute('insert into '+table+' ('+','.join(row)+') values ('+','.join('?' for _ in row)+')',list(row.values()))
for suffix,path,title in [('main',workspace,'HTML preview evidence'),('other',other,'Other workspace evidence')]:
 pp=copy.deepcopy(p);pp.update(project_id='evidence-16099-'+suffix,title=title,workspace_root=str(path),created_at='2026-10-20T12:00:00.000Z',updated_at='2026-10-20T12:00:00.000Z');insert('projection_projects',pp)
 tt=copy.deepcopy(t);tid='evidence-16099-'+suffix;payload=json.loads(tt['payload_json']);payload.update(id=tid,projectId=pp['project_id'],title=title,activeProviderThreadId=None,createdAt='2026-10-20T12:00:00.000Z',updatedAt='2026-10-20T12:00:00.000Z',lastVisitedAt=None);payload['lineage']={'parentThreadId':None,'relationshipToParent':None,'rootThreadId':tid};tt.update(thread_id=tid,project_id=pp['project_id'],title=title,active_provider_thread_id=None,payload_json=json.dumps(payload),created_at=payload['createdAt'],updated_at=payload['updatedAt']);insert('orchestration_v2_projection_threads',tt)
 text='Synthetic HTML preview evidence links\n\n'+'\n\n'.join('['+label+']('+target+')' for label,target in ([('A','triage-16099/a.html'),('B','triage-16099/b.html'),('C','triage-16099/c.html'),('A line 80','triage-16099/a.html:80'),('Host HTML',str(host)),('Absent HTML','triage-16099/absent.html')] if suffix=='main' else [('Other HTML',str(other/'other.html'))]))
 msg={'createdBy':'agent','creationSource':'mcp','id':tid+'-message','threadId':tid,'runId':None,'nodeId':None,'role':'assistant','text':text,'attachments':[],'streaming':False,'createdAt':payload['createdAt'],'updatedAt':payload['updatedAt']}
 insert('orchestration_v2_projection_messages',dict(message_id=msg['id'],thread_id=tid,run_id=None,node_id=None,role='assistant',streaming=0,created_at=msg['createdAt'],updated_at=msg['updatedAt'],payload_json=json.dumps(msg)))

 item={'id':tid+'-item','threadId':tid,'runId':None,'nodeId':None,'providerThreadId':None,'providerTurnId':None,'nativeItemRef':None,'parentItemId':None,'ordinal':1,'status':'completed','title':None,'startedAt':msg['createdAt'],'completedAt':msg['createdAt'],'updatedAt':msg['createdAt'],'streaming':False,'type':'assistant_message','messageId':msg['id'],'text':text,'attachments':[]}
 insert('orchestration_v2_projection_turn_items',dict(turn_item_id=item['id'],thread_id=tid,run_id=None,node_id=None,provider_thread_id=None,provider_turn_id=None,parent_item_id=None,ordinal=1,type='assistant_message',status='completed',updated_at=msg['createdAt'],payload_json=json.dumps(item)))
c.commit();c.close();print('Seeded synthetic HTML files and isolated presentation projections.')
