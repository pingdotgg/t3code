"""Visual-only D1/D2 projections. Never evidence of adapter or settlement behavior.

Stop the dev server first. Run against a migrated disposable database:
  python3 scripts/fixtures/issue-18386/seed.py .t3/formal-18386/userdata/statev2.sqlite before
  vp run dev --home-dir "$PWD/.t3/formal-18386"
Repeat with `after`. Both versions use identical IDs/history and fixed timestamps.
No provider is invoked. Use focused adapter tests for backend proof.
"""
import json,pathlib,sqlite3,sys
path=pathlib.Path(sys.argv[1]).resolve(); version=sys.argv[2]
assert '/.t3/formal-18386/' in str(path), 'Only the disposable formal-18386 home is allowed'
assert version in ('before','after')
c=sqlite3.connect(path); c.execute('PRAGMA foreign_keys=OFF')
# The input must be a disposable migrated database. Remove live work and auth-independent history.
for (table,) in c.execute("select name from sqlite_master where type='table'").fetchall():
 if table.startswith(('orchestration_','projection_')): c.execute('delete from '+table)
base=json.loads(pathlib.Path(__file__).with_name('projection.json').read_text())
source='bee451d8-4676-48c2-adb6-d9d4131ca506'; project='32891c9e-7431-4d46-8c15-979c2bab97d8'
now='2026-10-22T12:00:00.000Z'
c.execute('insert into projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) values(?,?,?,?,?,?)',(project,'Permission denial fixtures',str(path.parent.parent/'workspace'),'[]',now,now))
long='printf '+ 'T3_DENIAL_PROBE_'*40
reason=('Rule denies this operation. '*30)[:400]
messages={
 'D1':'Claude Code denied 1 tool call this turn:\n- Bash: printf T3_DENIAL_PROBE (Permission rule Bash(printf T3_DENIAL_PROBE*) denies this)',
 'D2':'Claude Code denied 6 tool calls this turn:\n- Bash: '+long[:400]+' ('+reason+')\n- Read: /tmp/permission-fixture/private.txt (no reason given)\n- Custom: {"scope":"fixture","action":"inspect"} (no reason given)\n- Bash: curl example.com (PreToolUse hook blocked curl)\n- Bash: ls /secret (no reason given)\n- and 1 more',
 'Control':None}
for i,(label,message) in enumerate(messages.items()):
 target=source if i==0 else ['','7e5eaa52-6686-4444-8888-000000000002','7e5eaa52-6686-4444-8888-000000000003'][i]
 tables=json.loads(json.dumps(base).replace(source,target))
 if i:
  ids={v:v+'-'+label for rows in tables.values() for row in rows for k,v in row.items() if k.endswith('_id') and k!='provider_instance_id' and isinstance(v,str) and target not in v and v!=project}
  def remap(v):
   if isinstance(v,dict): return {k:remap(x) for k,x in v.items()}
   if isinstance(v,list): return [remap(x) for x in v]
   return ids.get(v,v) if isinstance(v,str) else v
  for rows in tables.values():
   for row in rows:
    for k,v in list(row.items()): row[k]=json.dumps(remap(json.loads(v))) if k=='payload_json' else remap(v)
 failed=version=='after' and label!='Control'
 for table,rows in tables.items():
  for row in rows:
   p=json.loads(row['payload_json']) if 'payload_json' in row else None
   if p:
    if table=='orchestration_v2_projection_threads': p['title']=label+' — permission fixture'; row['title']=p['title']; p['lastVisitedAt']=now
    if table.endswith(('_runs','_run_attempts','_provider_turns')) or (table.endswith('_nodes') and p['id']==json.loads(tables['orchestration_v2_projection_runs'][0]['payload_json'])['rootNodeId']):
     p['status']='failed' if failed else 'completed'; row['status']=p['status']
    if p.get('type')=='system_notice':
     if not failed: continue
     p['message']=message
    if p.get('type')=='error':
     if not failed: continue
     p['failure']['message']='Claude Code denied '+('6 tool calls' if label=='D2' else '1 tool call')+' this turn.'
    if label=='Control' and p.get('type')=='command_execution':
     p.pop('toolNonExecutionKind',None); p.update(status='completed',input='printf T3_CONTROL',output='T3_CONTROL',exitCode=0); row['status']='completed'
    if label=='Control' and (p.get('type')=='assistant_message' or p.get('role')=='assistant'): p['text']='The visual control completed successfully.'
    row['payload_json']=json.dumps(p,separators=(',',':'))
   cols=list(row)
   c.execute('insert into '+table+'('+','.join(cols)+') values('+','.join('?' for _ in cols)+')',list(row.values()))
c.commit(); c.close()
print('Seeded visual-only '+version+' D1/D2/control at '+str(path))
