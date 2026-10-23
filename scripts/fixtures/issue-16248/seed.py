#!/usr/bin/env python3
"""Seed stopped, migrated, isolated T3 state. No template or live-state reads.

python3 scripts/fixtures/issue-16248/seed.py /tmp/issue16248-proof-home --workspace /tmp/issue16248-workspace
Open /<environment-id>/minimap-proof-600 after normal startup pairing.
This projection-only fixture proves rendering, not event-sourced mutations.
"""
import argparse
import datetime
import json
import pathlib
import os
import sqlite3

data = json.loads(pathlib.Path(__file__).with_name('data.json').read_text())
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('home', type=pathlib.Path)
p.add_argument('--workspace', required=True, type=pathlib.Path)
p.add_argument('--counts', default=','.join(map(str, data['counts'])))
p.add_argument('--generation', default='a', choices=['a', 'b'])
p.add_argument('--append', type=int, default=0)
p.add_argument('--assistant-only', action='store_true')
p.add_argument('--history', action='store_true', help='One run per item for Load earlier turns')
a = p.parse_args()
home = a.home.resolve()
if home == (pathlib.Path.home()/'.t3').resolve() or not (home/'userdata/statev2.sqlite').is_file():
    p.error('Requires an existing isolated migrated database; live T3 home refused')
runtime = home/'userdata/server-runtime.json'
if runtime.exists():
    pid = json.loads(runtime.read_text()).get('pid')
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        pass
    else:
        p.error('Stop the isolated server before seeding')
# An explicit marker makes accidental targeting of an unrelated isolated database fail closed.
marker = home/'MINIMAP_PROOF_ONLY'
if not marker.exists():
    c = sqlite3.connect(home/'userdata/statev2.sqlite')
    if c.execute('select count(*) from projection_projects').fetchone()[0]:
        p.error('First seed requires an empty database')
    marker.write_text('Synthetic issue-16248 rendering fixture\n')
else:
    c = sqlite3.connect(home/'userdata/statev2.sqlite')
a.workspace.mkdir(parents=True, exist_ok=True)
ts = data['createdAt']
base_datetime = datetime.datetime.fromisoformat(ts.replace('Z', '+00:00'))
project = data['projectId']
model = {'instanceId':'codex', 'model':'gpt-5'}
creation = dict(createdBy='user', creationSource='web')
def put(table, **values):
    keys = list(values)
    c.execute('insert into '+table+' ('+','.join(keys)+') values ('+','.join('?' for _ in keys)+')', [json.dumps(v) if isinstance(v,(dict,list)) else v for v in values.values()])
with c:
    put_project = not c.execute('select 1 from projection_projects where project_id=?',(project,)).fetchone()
    if put_project:
        put('projection_projects',project_id=project,title=data['projectTitle'],workspace_root=str(a.workspace.resolve()),scripts_json=[],created_at=ts,updated_at=ts)
    for count in map(int, a.counts.split(',')):
        if count < 0 or count > 1000: p.error('Count must be 0..1000')
        t = f'minimap-proof-{count}' + ('-assistant' if a.assistant_only else '') + ('-history' if a.history else '')
        for table in ['messages','turn_items','nodes','runs','threads']:
            c.execute('delete from orchestration_v2_projection_'+table+' where thread_id=?',(t,))
        thread = dict(creation,id=t,projectId=project,title=f'{count} user items'+(' assistant only' if a.assistant_only else ''),providerInstanceId='codex',modelSelection=model,runtimeMode='approval-required',interactionMode='default',branch=None,worktreePath=None,activeProviderThreadId=None,lineage=dict(parentThreadId=None,relationshipToParent=None,rootThreadId=t),forkedFrom=None,createdAt=ts,updatedAt=ts,archivedAt=None,deletedAt=None)
        put('orchestration_v2_projection_threads',thread_id=t,project_id=project,title=thread['title'],default_provider='codex',provider_instance_id='codex',runtime_mode=thread['runtimeMode'],interaction_mode='default',created_at=ts,updated_at=ts,payload_json=thread)
        ordinal = 0
        for i in range(count + a.append):
            stem = f'{t}-{a.generation}-{i:04d}'
            runstem = stem if a.history else f'{t}-{a.generation}-0000'
            runid, nodeid = runstem+'-run', runstem+'-node'
            dt = (base_datetime+datetime.timedelta(seconds=i)).isoformat(timespec='milliseconds').replace('+00:00','Z')
            run = dict(id=runid,threadId=t,ordinal=i+1,providerInstanceId='codex',modelSelection=model,providerThreadId=None,userMessageId=stem+'-user',rootNodeId=nodeid,activeAttemptId=None,status='completed',requestedAt=dt,startedAt=dt,completedAt=dt,checkpointId=None,contextHandoffId=None)
            if i == 0 or a.history:
                put('orchestration_v2_projection_runs',run_id=runid,thread_id=t,ordinal=i+1,provider='codex',provider_instance_id='codex',status='completed',requested_at=dt,completed_at=dt,payload_json=run)
            node = dict(id=nodeid,threadId=t,runId=runid,parentNodeId=None,rootNodeId=nodeid,kind='root_turn',status='completed',countsForRun=True,providerThreadId=None,providerTurnId=None,nativeItemRef=None,runtimeRequestId=None,checkpointScopeId=None,startedAt=dt,completedAt=dt)
            if i == 0 or a.history:
                put('orchestration_v2_projection_nodes',node_id=nodeid,thread_id=t,run_id=runid,root_node_id=nodeid,kind='root_turn',status='completed',started_at=dt,completed_at=dt,payload_json=node)
            def item(kind, **extra):
                global ordinal
                ident=stem+'-'+kind
                obj=dict(id=ident,threadId=t,runId=runid,nodeId=nodeid,providerThreadId=None,providerTurnId=None,nativeItemRef=None,parentItemId=None,ordinal=ordinal,status='completed',title=None,startedAt=dt,completedAt=dt,updatedAt=dt,type=kind,**extra)
                put('orchestration_v2_projection_turn_items',turn_item_id=ident,thread_id=t,run_id=runid,node_id=nodeid,ordinal=ordinal,type=kind,status='completed',updated_at=dt,payload_json=obj)
                ordinal+=1
            def message(role,text):
                mid=stem+'-'+role
                obj=dict(creation,id=mid,threadId=t,runId=runid,nodeId=nodeid,role=role,text=text,attachments=[],streaming=False,createdAt=dt,updatedAt=dt)
                put('orchestration_v2_projection_messages',message_id=mid,thread_id=t,run_id=runid,node_id=nodeid,role=role,streaming=0,created_at=dt,updated_at=dt,payload_json=obj)
                return mid
            if not a.assistant_only:
                text='   ' if i==1 else data['userText'].format(number=i+1)
                mid=message('user',text)
                item('user_message',**creation,messageId=mid,inputIntent='turn_start',text=text,attachments=[])
            item('command_execution',input=data['workInput'],output=data['workOutput'],exitCode=0)
            if i%3:
                text=data['shortAssistant'] if i%3==1 else data['longAssistantHeading']+data['longAssistantParagraph']*data['longAssistantRepeats']
                mid=message('assistant',text)
                item('assistant_message',messageId=mid,text=text,streaming=False,attachments=[])
        print(json.dumps(dict(thread=t,userItems=0 if a.assistant_only else count+a.append,runs=(count+a.append if a.history else int(count+a.append>0)),turnItems=ordinal,expectedMarks512=min(count+a.append,129) if count+a.append>=2 else 0)))
