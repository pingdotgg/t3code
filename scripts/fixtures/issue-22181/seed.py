#!/usr/bin/env python3
"""Seed only a stopped, migrated evidence home; never reads live T3 data.

Usage: python3 scripts/fixtures/issue-22181/seed.py <isolated-home>
Direct projections prove client presentation, not orchestration business behavior.
"""
import json, sqlite3, sys
from pathlib import Path
p=Path(__file__).resolve().parent
home=Path(sys.argv[1]).resolve()
# Whole components after symlink resolution: rejects `.t3/evidence-existing` and aliases.
if ('.t3','evidence') not in zip(home.parts,home.parts[1:]):
    raise SystemExit('Expected isolated worktree .t3/evidence home')
c=sqlite3.connect(home/'userdata/statev2.sqlite')
def insert(table, **values):
    c.execute(f"INSERT OR REPLACE INTO {table} ({','.join(values)}) VALUES ({','.join('?' for _ in values)})",list(values.values()))
def dump(v): return json.dumps(v,ensure_ascii=False)
t='2026-10-01T12:00:00.000Z';tid='proof-22181';pid='proof-project-22181';rid='proof-run-22181'
root=str(home/'workspace')
import shutil
shutil.copytree(p/'workspace',root,dirs_exist_ok=True)
# Stored as .txt so the repo's TS tooling (knip) never sees a fake source file.
src=Path(root)/'packages/shared/src/markdownLinks.ts'
src.with_name(src.name+'.txt').replace(src)
model={'instanceId':'codex','model':'gpt-5.4'}
c.execute('DELETE FROM projection_projects')
for table in ['orchestration_v2_projection_threads','orchestration_v2_projection_runs','orchestration_v2_projection_messages','orchestration_v2_projection_turn_items']:
    c.execute('DELETE FROM '+table)
insert('projection_projects',project_id=pid,title='Markdown proof',workspace_root=root,scripts_json='[]',created_at=t,updated_at=t)
thread=dict(createdBy='user',creationSource='web',id=tid,projectId=pid,title='Markdown literal proof',providerInstanceId='codex',modelSelection=model,runtimeMode='full-access',interactionMode='default',branch=None,worktreePath=None,activeProviderThreadId=None,lineage={'parentThreadId':None,'relationshipToParent':None,'rootThreadId':tid},forkedFrom=None,createdAt=t,updatedAt=t,archivedAt=None,settledOverride=None,settledAt=None,deletedAt=None)
insert('orchestration_v2_projection_threads',thread_id=tid,project_id=pid,title=thread['title'],default_provider='codex',runtime_mode='full-access',interaction_mode='default',created_at=t,updated_at=t,payload_json=dump(thread),provider_instance_id='codex')
run=dict(id=rid,threadId=tid,ordinal=1,providerInstanceId='codex',modelSelection=model,providerThreadId=None,userMessageId='proof-user',rootNodeId=None,activeAttemptId=None,status='completed',requestedAt=t,startedAt=t,completedAt=t,checkpointId=None,contextHandoffId=None)
insert('orchestration_v2_projection_runs',run_id=rid,thread_id=tid,ordinal=1,provider='codex',status='completed',requested_at=t,completed_at=t,payload_json=dump(run),provider_instance_id='codex')
text=(p/'payload.md').read_text()
attachment=dict(type='file',id='proof-22181-00000000-0000-4000-8000-000000000001-md',name='attachment.md',mimeType='text/markdown',sizeBytes=(p/'attachment.md').stat().st_size)
for n,role in enumerate(['user','assistant']):
    mid='proof-'+role;stamp=f'2026-10-01T12:00:0{n}.000Z'
    msg=dict(createdBy='user' if n==0 else 'agent',creationSource='web' if n==0 else 'provider',id=mid,threadId=tid,runId=rid,nodeId=None,role=role,text=text,attachments=[attachment] if n==0 else [],streaming=False,createdAt=stamp,updatedAt=stamp)
    insert('orchestration_v2_projection_messages',message_id=mid,thread_id=tid,run_id=rid,role=role,streaming=0,created_at=stamp,updated_at=stamp,payload_json=dump(msg))
    item=dict(id='item-'+mid,threadId=tid,runId=rid,nodeId=None,providerThreadId=None,providerTurnId=None,nativeItemRef=None,parentItemId=None,ordinal=n+1,status='completed',title=None,startedAt=stamp,completedAt=stamp,updatedAt=stamp,type=role+'_message',messageId=mid,text=text,attachments=msg['attachments'])
    if n==0: item.update(createdBy='user',creationSource='web',inputIntent='turn_start')
    else: item['streaming']=False
    insert('orchestration_v2_projection_turn_items',turn_item_id=item['id'],thread_id=tid,run_id=rid,ordinal=n+1,type=item['type'],status='completed',updated_at=stamp,payload_json=dump(item))
plan='# Deterministic plan\n\n'+''.join(f'{i}. Inspect the visible Markdown controls and preserve wrapping.\n\n' for i in range(1,15))+'15. Verify `I/W217:220`, `foo/TODO:12` and `docs/README:12`.\n'
item.update(id='proof-plan-item',type='proposed_plan',ordinal=3,planId='proof-plan',markdown=plan,streaming=False)
insert('orchestration_v2_projection_turn_items',turn_item_id=item['id'],thread_id=tid,run_id=rid,ordinal=3,type='proposed_plan',status='completed',updated_at=t,payload_json=dump(item))
collision='Collision only: `foo/TODO:12` and [TODO](other/TODO:12).'
item.update(id='proof-collision-item',runId=None,type='assistant_message',ordinal=4,messageId='proof-collision',text=collision,streaming=False)
insert('orchestration_v2_projection_turn_items',turn_item_id=item['id'],thread_id=tid,run_id=None,ordinal=4,type='assistant_message',status='completed',updated_at=t,payload_json=dump(item))
msg.update(id='proof-collision',runId=None,text=collision,role='assistant',attachments=[])
insert('orchestration_v2_projection_messages',message_id=msg['id'],thread_id=tid,run_id=None,role='assistant',streaming=0,created_at=t,updated_at=t,payload_json=dump(msg))
c.commit();c.close()
# Attachment storage is intentionally separate from workspace Markdown (no cwd).
assets=home/'userdata/attachments';assets.mkdir(parents=True,exist_ok=True)
(assets/'proof-22181-00000000-0000-4000-8000-000000000001-md.md').write_bytes((p/'attachment.md').read_bytes())
print('Seeded',tid,'at',home,'workspace',root)
