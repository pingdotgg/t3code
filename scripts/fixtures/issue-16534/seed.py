#!/usr/bin/env python3
"""Generate synthetic sidebar projections without reading personal application data.

Generation never touches a database. Apply the generated SQL files with the documented SQLite
helper only after the environment owner has stopped the isolated server. These
are projection fixtures, not event-history or provider integration fixtures.
"""
import argparse
import hashlib
import json
from pathlib import Path

CLOCK = '2026-10-22T00:00:00.000Z'


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'))


def quote(value):
    return 'NULL' if value is None else "'" + str(value).replace("'", "''") + "'"


def thread(group, number):
    key = f'triage-{group}-{number}'
    stamp = f'2026-10-21T20:{number:02d}:00.000Z'
    return dict(createdBy='user', creationSource='web', id=key,
                projectId=f'triage-project-{group}', title=f'Triage {group} thread {number}',
                providerInstanceId='codex', modelSelection=dict(instanceId='codex', model='gpt-6.1-sol'),
                runtimeMode='full-access', interactionMode='default', branch=None,
                worktreePath=None, activeProviderThreadId=None,
                lineage=dict(parentThreadId=None, relationshipToParent=None, rootThreadId=key),
                forkedFrom=None, createdAt=stamp, updatedAt=stamp, archivedAt=None,
                settledOverride=None, settledAt=None, snoozedUntil=None, snoozedAt=None,
                lastVisitedAt=None, deletedAt=None)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--variant', choices=['plain', 'spacers', 'pinned', 'snoozed', 'settled', 'lineage', 'archived', 'orphan', 'working', 'status', 'grouped', 'all'], default='plain')
    parser.add_argument('--legacy', action='store_true')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    threads = [thread(group, n) for group in ['A', 'B'] for n in range(1, 9)]
    projects = ['A', 'B']
    target = threads[0]
    if args.variant in ['spacers', 'all']:
        projects.append('Spacer')
        threads += [thread('Spacer', n) for n in range(1, 41)]
    if args.variant == 'pinned':
        target.update(pinnedAt=CLOCK, pinOrderKey='a0')
    if args.variant == 'snoozed':
        target.update(snoozedAt=CLOCK, snoozedUntil='2099-01-01T00:00:00.000Z')
    if args.variant == 'settled':
        target.update(settledOverride='settled', settledAt=CLOCK)
        for n in range(2, 17):
            settled = threads[n-1] if n <= 8 else thread('A', n)
            settled.update(settledOverride='settled', settledAt=f'2026-10-21T21:{n:02d}:00.000Z')
            if n > 8:
                threads.append(settled)
    if args.variant == 'archived':
        target['archivedAt'] = CLOCK
    if args.variant in ['lineage', 'orphan', 'all']:
        for n, parent, relationship in [(9, target['id'], 'subagent'), (10, 'triage-A-9', 'subagent'), (11, target['id'], 'fork'), (12, target['id'], 'subagent')]:
            child = thread('A', n)
            child['lineage'] = dict(parentThreadId=parent, relationshipToParent=relationship, rootThreadId=target['id'])
            threads.append(child)
        if args.variant == 'orphan':
            threads[16]['lineage']['parentThreadId'] = 'triage-missing-root'
            threads[16]['lineage']['rootThreadId'] = 'triage-missing-root'
    messages = []
    for group in ['A', 'B']:
        text = "Synthetic navigation links: " + " | ".join(f"[Open {label}](t3-thread://v1/{target_id})" for label,target_id in [('A1','triage-A-1'),('A8','triage-A-8'),('child','triage-A-9'),('grandchild','triage-A-10'),('sibling','triage-A-12'),('fork','triage-A-11'),('missing','triage-missing')])
        messages.append(dict(id=f'triage-link-{group}',threadId=f'triage-{group}-8',runId=None,nodeId=None,role='assistant',text=text,attachments=[],streaming=False,createdAt=CLOCK,updatedAt=CLOCK,createdBy='agent',creationSource='web'))
    message_values = ['(' + ','.join(map(quote,[m['id'],m['threadId'],None,None,m['role'],0,CLOCK,CLOCK,encoded(m)])) + ')' for m in messages]
    (args.output/'messages.sql').write_text('INSERT OR REPLACE INTO orchestration_v2_projection_messages (message_id,thread_id,run_id,node_id,role,streaming,created_at,updated_at,payload_json) VALUES ' + ','.join(message_values) + ';\n')
    item_values = []
    for m in messages:
        item=dict(id=m['id']+'-item',threadId=m['threadId'],runId=None,nodeId=None,providerThreadId=None,providerTurnId=None,nativeItemRef=None,parentItemId=None,ordinal=0,status='completed',title=None,startedAt=CLOCK,completedAt=CLOCK,updatedAt=CLOCK,type='assistant_message',messageId=m['id'],text=m['text'],streaming=False)
        item_values.append('(' + ','.join(map(quote,[item['id'],item['threadId'],None,None,None,None,None,0,'assistant_message','completed',CLOCK,encoded(item)])) + ')')
    (args.output/'turn-items.sql').write_text('INSERT OR REPLACE INTO orchestration_v2_projection_turn_items (turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,parent_item_id,ordinal,type,status,updated_at,payload_json) VALUES '+','.join(item_values)+';\n')
    # One statement, so the state helper can apply it as one atomic transaction.
    project_values = []
    for group in projects:
        project_values.append('(' + ','.join(map(quote, [f'triage-project-{group}', f'Triage {group}', f'/tmp/triage-16534-{group}', '[]', '2026-10-21T20:00:00.000Z', '2026-10-21T20:00:00.000Z'])) + ')')
    project_sql = 'INSERT OR REPLACE INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ' + ',\n'.join(project_values) + ';\n'
    values = []
    for t in threads:
        values.append('(' + ','.join(map(quote, [t['id'],t['projectId'],t['title'],'codex','full-access','default',None,t['createdAt'],t['updatedAt'],t['archivedAt'],None,encoded(t),'codex'])) + ')')
    sql = 'INSERT OR REPLACE INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,active_provider_thread_id,created_at,updated_at,archived_at,deleted_at,payload_json,provider_instance_id) VALUES ' + ',\n'.join(values) + ';\n'
    fixture = dict(clock=CLOCK, variant=args.variant, threads=threads,
                   settings=dict(legacySidebarEnabled=args.legacy,sidebarThreadSortOrder='updated_at',sidebarProjectSortOrder='manual',sidebarThreadPreviewCount=6,sidebarProjectGroupingMode='separate'),
                   uiState=dict(projectExpandedById={},projectOrder=[],threadLastVisitedAtById={},sidebarProjectScopeKey=None))
    (args.output/'reset-threads.sql').write_text("DELETE FROM orchestration_v2_projection_threads WHERE thread_id LIKE 'triage-%';\n")
    (args.output/'hide-unrelated-projects.sql').write_text("UPDATE projection_projects SET deleted_at=" + quote(CLOCK) + " WHERE project_id NOT IN (" + ','.join(quote('triage-project-' + group) for group in projects) + ");\n")
    (args.output/'archive-unrelated-threads.sql').write_text("UPDATE orchestration_v2_projection_threads SET archived_at=" + quote(CLOCK) + ",payload_json=json_set(payload_json,'$.archivedAt'," + quote(CLOCK) + ") WHERE thread_id NOT LIKE 'triage-%';\n")
    (args.output/'hide-v1-threads.sql').write_text("UPDATE projection_threads SET deleted_at="+quote(CLOCK)+" WHERE thread_id NOT LIKE 'triage-%';\n")
    (args.output/'projects.sql').write_text(project_sql)
    (args.output/'threads.sql').write_text(sql)
    (args.output/'fixture.json').write_text(encoded(fixture)+'\n')
    digest = hashlib.sha256(encoded(fixture).encode()).hexdigest()
    (args.output/'sha256.txt').write_text(digest+'\n')
    from transcript import write_transcript
    write_transcript(args.output)
    print(digest)


if __name__ == '__main__':
    main()
