#!/usr/bin/env python3
"""Seed stopped, isolated test homes; never touches live T3 home."""
import argparse
import json
import os
from pathlib import Path
import socket
import sqlite3
p=argparse.ArgumentParser()
p.add_argument('home',type=Path)
p.add_argument('--server-port',type=int,required=True)
p.add_argument('--workspace',type=Path,required=True)
a=p.parse_args()
home=a.home.resolve()
# Compare lexical and resolved forms of both sides, so a symlinked ~/.t3 or test home cannot alias it.
live=Path.home()/'.t3'
lives={Path(os.path.abspath(live)),live.resolve()}
if any(h.is_relative_to(l) for h in (Path(os.path.abspath(a.home)),home) for l in lives):
    raise SystemExit('Refusing live T3 home')
with socket.socket() as s:
    if s.connect_ex(('127.0.0.1',a.server_port))==0:
        raise SystemExit('Stop target server before seeding')
a.workspace.mkdir(parents=True,exist_ok=True)
(a.workspace/'fixture.txt').write_text('Shared terminal geometry fixture\n')
c=sqlite3.connect(home/'userdata/statev2.sqlite')
fixture=json.loads(Path(__file__).with_name('web-seed.json').read_text())
with c:
    c.execute('INSERT OR REPLACE INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at,auto_pull) VALUES (?,?,?,?,?,?,0)',(fixture['projectId'],fixture['title'],str(a.workspace.resolve()),'[]',fixture['clock'],fixture['clock']))
    for t in fixture['threads']:
        payload={**t,'projectId':fixture['projectId'],'providerInstanceId':'codex','modelSelection':{'instanceId':'codex','model':'gpt-6-astra'},'runtimeMode':'full-access','interactionMode':'default','branch':None,'worktreePath':None,'pullRequests':[],'activeProviderThreadId':None,'lineage':{'parentThreadId':None,'relationshipToParent':None,'rootThreadId':t['id']},'forkedFrom':None,'createdBy':'system','creationSource':'server','createdAt':fixture['clock'],'updatedAt':fixture['clock'],'archivedAt':None,'settledOverride':None,'settledAt':None,'snoozedUntil':None,'snoozedAt':None,'lastVisitedAt':fixture['clock'],'deletedAt':None}
        c.execute('INSERT OR REPLACE INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,active_provider_thread_id,created_at,updated_at,archived_at,deleted_at,payload_json,provider_instance_id) VALUES (?,?,?,?,?,?,NULL,?,?,NULL,NULL,?,?)',(t['id'],fixture['projectId'],t['title'],'codex','full-access','default',fixture['clock'],fixture['clock'],json.dumps(payload),'codex'))
print(json.dumps({'home':str(home),'projectId':fixture['projectId'],'threadIds':[t['id'] for t in fixture['threads']],'workspace':str(a.workspace.resolve())}))
