#!/usr/bin/env python3
"""Run with dev server stopped: python3 <fixture>/seed.py <worktree> <stage-dir>.
Start once with --no-seed to initialize migrations first. Does not change auth.
Launch with ISSUE_8640_STATE=<stage-dir> NODE_OPTIONS='--max-old-space-size=1536 --import=<absolute fixture>/provider.mjs' vp run dev --no-seed.
Set stage file to original, title, success in that order. Same provider wrapper applies on baseline and head; production clocks and intervals are unchanged.
"""
import pathlib,sqlite3,sys
root=pathlib.Path(sys.argv[1]).resolve()
state=pathlib.Path(sys.argv[2]).resolve()
assert (root/'.git').exists(), 'Expected a checkout/worktree'
db=root/'.t3/userdata/statev2.sqlite'
assert db.exists(), 'Initialize isolated migrations with dev --no-seed first'
assert db.resolve()!=pathlib.Path.home()/'.t3/userdata/statev2.sqlite'
state.mkdir(parents=True,exist_ok=True)
(state/'stage').write_text('original\n')
(state/'provider.jsonl').write_text('')
with sqlite3.connect(db) as c:
 c.execute('INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET title=excluded.title,workspace_root=excluded.workspace_root,deleted_at=NULL',('abaff30b-8067-4cbc-aecf-6f2598d1d925','server',str(root/'apps/server'),'[]','2026-10-22T00:00:00.000Z','2026-10-22T00:00:00.000Z'))
print('Seeded isolated project abaff30b-8067-4cbc-aecf-6f2598d1d925 at',root/'apps/server')
