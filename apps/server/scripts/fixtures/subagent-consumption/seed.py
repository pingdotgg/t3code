#!/usr/bin/env python3
"""Seed visual-only projections into an explicitly selected, stopped, isolated server."""
import argparse
import json
from pathlib import Path
import sqlite3

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--home-dir', type=Path, required=True)
parser.add_argument('--server-stopped', action='store_true', required=True)
parser.add_argument('--with-synthetic-catalog', action='store_true')
args = parser.parse_args()
home = args.home_dir.resolve()
if home == Path.home() / '.t3' or 'userdata' == home.name:
    parser.error('Select an isolated T3 home, never the live home or userdata itself')
db = home / 'userdata/statev2.sqlite'
if not db.is_file():
    parser.error('Start the isolated server once to initialize its schema, then stop it')
if args.with_synthetic_catalog:
    settings_path = home / 'userdata/settings.json'
    settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
    original = settings_path.with_name('before-subagent-consumption-settings.json')
    if not original.exists():
        original.write_text(json.dumps(settings, indent=2) + '\n')
    settings.setdefault('providerInstances', {}).update(json.loads(Path(__file__).with_name('catalog.json').read_text()))
    settings_path.write_text(json.dumps(settings, indent=2) + '\n')
c = sqlite3.connect(db)
backup = db.with_name('before-subagent-consumption-fixture.sqlite')
with sqlite3.connect(backup) as destination:
    c.backup(destination)
T = '2026-10-21T09:00:00.000Z'
END = '2026-10-21T09:00:10.000Z'
PROJECT = 'visual-15429-project'

def insert(table, row):
    cols = ','.join(row)
    c.execute(f'INSERT OR REPLACE INTO {table} ({cols}) VALUES ({",".join("?" for _ in row)})', list(row.values()))

def payload(table, data, indexed):
    insert('orchestration_v2_projection_' + table, {**indexed, 'payload_json': json.dumps(data, separators=(',', ':'))})

def thread(id, title, parent=None, long=False):
    data = dict(id=id, projectId=PROJECT + '-child' if long else PROJECT, title=title, providerInstanceId='claudeAgent',
        modelSelection=dict(instanceId='claudeAgent', model='claude-opus-5-5'),
        runtimeMode='full-access', interactionMode='default', branch=('synthetic/long-branch-' + 'sample-' * 24) if long else None,
        worktreePath='/tmp/t3-synthetic-15429-child/' + 'long-worktree-segment-' * 12 if long else None, activeProviderThreadId=None, lineage=dict(rootThreadId=parent or id, parentThreadId=parent, relationshipToParent='subagent' if parent else None),
        forkedFrom=None, createdBy='agent' if parent else 'user', creationSource='web', createdAt=T, updatedAt=END,
        archivedAt=None, settledOverride=None, settledAt=None, snoozedUntil=None, snoozedAt=None, lastVisitedAt=None, deletedAt=None, pullRequests=[])
    payload('threads', data, dict(thread_id=id, project_id=data['projectId'], title=title, default_provider='claudeAgent', provider_instance_id='claudeAgent',runtime_mode='full-access', interaction_mode='default',active_provider_thread_id=None,created_at=T,updated_at=END,archived_at=None,deleted_at=None))

with c:
    insert('projection_projects',dict(project_id=PROJECT,title='Subagent usage fixtures',workspace_root='/tmp/t3-synthetic-15429',scripts_json='[]',created_at=T,updated_at=END,deleted_at=None))
    insert('projection_projects',dict(project_id=PROJECT+'-child',title='Synthetic child workspace',workspace_root='/tmp/t3-synthetic-15429-child',scripts_json='[]',created_at=T,updated_at=END,deleted_at=None))
    for case in json.loads(Path(__file__).with_name('cases.json').read_text()):
        label=case['id']; tid='visual-15429-'+label; child=tid+'-child' if case.get('child',True) else None
        rid=tid+'-run'; node=tid+'-root'; aid=tid+'-agent'; title=label+' · '+case['title']; status=case.get('status','completed')
        agenttitle=(title+' — synthetic long title for collision and truncation ' * 5) if case.get('long') else title
        thread(tid,title)
        if child: thread(child,agenttitle,tid,case.get('long',False))
        if label == 'V02':
            for neighbor in range(1, 9):
                thread(tid+'-neighbor-'+str(neighbor), 'Synthetic previous neighbor '+str(neighbor), tid)
        run=dict(id=rid,threadId=tid,ordinal=1,providerInstanceId='claudeAgent',modelSelection=dict(instanceId='claudeAgent',model='claude-opus-5-5'),providerThreadId=None,userMessageId=tid+'-message',rootNodeId=node,activeAttemptId=tid+'-attempt',status='completed',queuePosition=None,requestedAt=T,startedAt=T,completedAt=END,checkpointId=None,contextHandoffId=None)
        payload('runs',run,dict(run_id=rid,thread_id=tid,ordinal=1,provider='claudeAgent',provider_instance_id='claudeAgent',provider_thread_id=None,status='completed',requested_at=T,completed_at=END))
        agent=dict(id=aid,threadId=tid,runId=rid,parentNodeId=node,origin='provider_native' if case.get('native') else 'app_owned',createdBy='agent',driver='claudeAgent',providerInstanceId='claudeAgent',providerThreadId=None,childThreadId=child,nativeTaskRef=None,prompt='Inspect the synthetic sample.',title=agenttitle,model=case.get('model','claude-opus-5-5'),status=status,result=case.get('result','Synthetic sample inspected successfully.'),startedAt=T if case.get('timing',True) else None,completedAt=END if case.get('timing',True) and status!='running' else None,updatedAt=END)
        if case.get('long'):
            agent['model']='synthetic-long-model-'+'sample-model-'*12
            if args.with_synthetic_catalog:
                agent['driver']='codex'
                agent['providerInstanceId']='visual15429'
                agent['modelSelection']={'instanceId':'visual15429','model':agent['model'],'options':[{'id':'effort','value':'high'},{'id':'serviceTier','value':'priority'}]}
            agent['result']=('Synthetic multiline sample result for truncation. '*7)+'\nSecond synthetic line.'
        if 'progress' in case:agent['progress']=case['progress']
        if 'usage' in case:agent['turnTokenUsage']={'usageScope':'main_agent','hasSubagents':False,**case['usage']}
        if case.get('native'):agent['workflow']=dict(name='Synthetic workflow',phases=[],agents=[dict(index=0,label='Synthetic member',state='completed',totalTokens=123)],totalTokens=70876)
        if not case.get('missing'):
            payload('subagents',agent,dict(subagent_id=aid,thread_id=tid,run_id=rid,parent_node_id=node,provider=agent['driver'],driver=agent['driver'],provider_instance_id=agent['providerInstanceId'],provider_thread_id=None,child_thread_id=child,origin=agent['origin'],status=status,started_at=agent['startedAt'],completed_at=agent['completedAt'],updated_at=END))
        base=dict(threadId=tid,runId=rid,nodeId=node,providerThreadId=None,providerTurnId=None,nativeItemRef=None,parentItemId=None,status='completed',title=None,startedAt=T,completedAt=END,updatedAt=END)
        message=dict(id=tid+'-message',threadId=tid,runId=rid,nodeId=node,createdBy='user',creationSource='web',role='user',text='Synthetic visual fixture '+label+'. No provider is running.',attachments=[],streaming=False,createdAt=T,updatedAt=T)
        payload('messages',message,dict(message_id=message['id'],thread_id=tid,run_id=rid,node_id=node,role='user',streaming=0,created_at=T,updated_at=T))
        items=[dict(base,id=tid+'-user',ordinal=1000001,type='user_message',messageId=message['id'],inputIntent='turn_start',text=message['text'],attachments=[],createdBy='user',creationSource='web')]
        if case.get('caller')=='notification':
            items.append(dict(base,id=tid+'-notification',ordinal=1000002,type='notification',source=dict(kind='background_task',work='subagent',childThreadId=child),outcome='completed',summary='Synthetic subagent completed.'))
        else:
            items.append(dict(base,id=tid+'-item',ordinal=1000002,type='subagent',nodeId=aid,subagentId=aid,origin=agent['origin'],driver=agent['driver'],providerInstanceId=agent['providerInstanceId'],childThreadId=child,prompt=agent['prompt'],result=agent['result'],title=agenttitle,status=status,startedAt=agent['startedAt'],completedAt=agent['completedAt'],**({'progress':case['progress']} if 'progress' in case else {})))
        for item in items:
            payload('turn_items',item,dict(turn_item_id=item['id'],thread_id=tid,run_id=rid,node_id=item['nodeId'],provider_thread_id=None,provider_turn_id=None,parent_item_id=None,ordinal=item['ordinal'],type=item['type'],status=item['status'],updated_at=END))
print('Seeded 16 synthetic visual threads. Event history, scheduled work and auth were not changed.')
print('Backup:',backup)
