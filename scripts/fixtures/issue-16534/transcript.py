"""Emit stopped synthetic runs and transcript items for real thread-link rendering."""
import json
from pathlib import Path

def write_transcript(output):
    clock='2026-10-21T23:00:00.000Z'
    def q(v): return 'NULL' if v is None else "'"+str(v).replace("'","''")+"'"
    def enc(v):return json.dumps(v,separators=(',',':'))
    runs=[];messages=[];items=[]
    for group in ['A','B']:
        tid=f'triage-{group}-8';rid=f'triage-fixture-run-{group}';uid=rid+'-user';aid=rid+'-assistant'
        run=dict(id=rid,threadId=tid,ordinal=1,providerInstanceId='codex',modelSelection=dict(instanceId='codex',model='gpt-6.1-sol'),providerThreadId=None,userMessageId=uid,rootNodeId=None,activeAttemptId=None,status='completed',requestedAt=clock,startedAt=clock,completedAt=clock,checkpointId=None,contextHandoffId=None)
        runs.append('('+','.join(map(q,[rid,tid,1,'codex',None,'completed',clock,clock,enc(run),'codex']))+')')
        linktext='Synthetic fixture navigation: '+' | '.join(f'[{label}](t3-thread://v1/{target})' for label,target in [('Open A1','triage-A-1'),('Open A8','triage-A-8'),('Open child','triage-A-9'),('Open grandchild','triage-A-10'),('Open sibling','triage-A-12'),('Open fork','triage-A-11'),('Open missing','triage-missing')])
        for ordinal,(mid,role,text) in enumerate([(uid,'user','Use these synthetic navigation links.'),(aid,'assistant',linktext)]):
            m=dict(id=mid,threadId=tid,runId=rid,nodeId=None,role=role,text=text,attachments=[],streaming=False,createdAt=clock,updatedAt=clock,createdBy='user' if role=='user' else 'agent',creationSource='web')
            messages.append('('+','.join(map(q,[mid,tid,rid,None,role,0,clock,clock,enc(m)]))+')')
            item=dict(id=mid+'-item',threadId=tid,runId=rid,nodeId=None,providerThreadId=None,providerTurnId=None,nativeItemRef=None,parentItemId=None,ordinal=ordinal,status='completed',title=None,startedAt=clock,completedAt=clock,updatedAt=clock,type=role+'_message',messageId=mid,text=text,streaming=False)
            if role=='user':item.update(createdBy='user',creationSource='web',inputIntent='turn_start',attachments=[])
            items.append('('+','.join(map(q,[item['id'],tid,rid,None,None,None,None,ordinal,item['type'],'completed',clock,enc(item)]))+')')
    tables=[('runs','run_id,thread_id,ordinal,provider,provider_thread_id,status,requested_at,completed_at,payload_json,provider_instance_id',runs),('messages','message_id,thread_id,run_id,node_id,role,streaming,created_at,updated_at,payload_json',messages),('turn_items','turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,parent_item_id,ordinal,type,status,updated_at,payload_json',items)]
    for table,columns,values in tables:(output/('transcript-'+table.replace('_','-')+'.sql')).write_text(f'INSERT OR REPLACE INTO orchestration_v2_projection_{table} ({columns}) VALUES '+','.join(values)+';\n')
if __name__=='__main__':
    import sys
    write_transcript(Path(sys.argv[1]))
