#!/usr/bin/env python3
"""Generate synthetic projection SQL and isolated settings; never open a database."""
import argparse
import json
from pathlib import Path


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'))


def quote(value):
    return 'NULL' if value is None else "'" + str(value).replace("'", "''") + "'"


def insert(table, row):
    return f"INSERT OR REPLACE INTO {table} ({','.join(row)}) VALUES ({','.join(quote(v) for v in row.values())});\n"


def main():
    fixture = json.loads(Path(__file__).with_name('scenarios.json').read_text())
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scenario', required=True, choices=list(fixture['scenarios']))
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    scenario = fixture['scenarios'][args.scenario]
    clock = fixture['capture']['clock']
    project = fixture['project']
    selection = dict(instanceId='claudeAgent', model=scenario['model'], options=[
        dict(id='effort', value=scenario['effort'])])
    if scenario.get('fastMode'):
        selection['options'].append(dict(id='fastMode', value=True))
    key = 'issue-17110-thread'
    thread = dict(createdBy='user', creationSource='web', id=key,
                  projectId=project['id'], title='Issue 17110 synthetic empty Claude thread',
                  providerInstanceId='claudeAgent', modelSelection=selection,
                  runtimeMode='full-access', interactionMode='default', branch=None,
                  worktreePath=None, activeProviderThreadId=None,
                  lineage=dict(parentThreadId=None, relationshipToParent=None, rootThreadId=key),
                  forkedFrom=None, createdAt=clock, updatedAt=clock, archivedAt=None,
                  settledOverride=None, settledAt=None, snoozedUntil=None, snoozedAt=None,
                  lastVisitedAt=None, deletedAt=None)
    project_default = selection if scenario.get('projectDefault') else None
    sql = insert('projection_projects', dict(
        project_id=project['id'], title=project['title'], workspace_root=project['path'],
        scripts_json='[]', created_at=clock, updated_at=clock, deleted_at=None,
        default_model_selection_json=encoded(project_default) if project_default else None))
    sql += insert('orchestration_v2_projection_threads', dict(
        thread_id=key, project_id=project['id'], title=thread['title'],
        default_provider='claudeAgent', runtime_mode=thread['runtimeMode'],
        interaction_mode=thread['interactionMode'], active_provider_thread_id=None,
        created_at=clock, updated_at=clock, archived_at=None, deleted_at=None,
        payload_json=encoded(thread), provider_instance_id='claudeAgent'))
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / 'seed.sql').write_text('BEGIN IMMEDIATE;\n' + sql + 'COMMIT;\n')
    (args.output / 'claude-settings.json').write_text(encoded(scenario['settings']) + '\n')
    (args.output / 'capture.json').write_text(encoded(dict(
        scenario=args.scenario, capture=fixture['capture'], project=project,
        thread=thread, projectDefaultModelSelection=project_default,
        expected=scenario['expected'], steps=fixture['browserSteps'])) + '\n')


if __name__ == '__main__':
    main()
