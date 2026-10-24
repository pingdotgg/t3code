import json, sqlite3, sys, pathlib, subprocess
root=pathlib.Path(sys.argv[1]).resolve()
if root == (pathlib.Path.home()/".t3").resolve():
 raise ValueError("Refusing the live ~/.t3 home")
if not (root.name == "repro" and root.parent.name == ".t3"):
 raise ValueError("Fixture home must be a .t3/repro directory")
workspace=root/"workspace"
workspace.mkdir(exist_ok=True)
def git(*args): subprocess.run(["git","-C",str(workspace),*args],check=True,capture_output=True)
if not (workspace/".git").exists():
 git("init","-b","main")
 git("config","user.name","Triage fixture")
 git("config","user.email","fixture@example.invalid")
 (workspace/"README.md").write_text("Linked PR fixture\n")
 git("add","README.md")
 git("commit","-m","fixture")
 git("remote","add","origin","https://github.com/example/fixture.git")
now="2026-10-21T12:00:00.000Z"
project={"project_id":"t3code","title":"Linked PR fixture","workspace_root":str(workspace),"scripts_json":"[]","created_at":now,"updated_at":now,"deleted_at":None}
link={"host":"github.com","repository":"example/fixture","number":42,"url":"https://github.com/example/fixture/pull/42","source":"manual","linkedAt":now,"stack":None,"snapshot":{"state":"open","title":"Fork branch change","headBranch":"fork-feature","baseBranch":"main","isDraft":False,"updatedAt":None,"syncedAt":now}}
payload={"createdBy":"user","creationSource":"mobile","id":"remote-command-center","projectId":"t3code","title":"Open the linked pull request","providerInstanceId":"codex","modelSelection":{"instanceId":"codex","model":"gpt-6.1-sol"},"runtimeMode":"full-access","interactionMode":"default","branch":"main","worktreePath":None,"pullRequests":[link],"activeProviderThreadId":None,"lineage":{"parentThreadId":None,"relationshipToParent":None,"rootThreadId":"remote-command-center"},"forkedFrom":None,"createdAt":now,"updatedAt":now,"archivedAt":None,"settledOverride":None,"settledAt":None,"snoozedUntil":None,"snoozedAt":None,"lastVisitedAt":now,"titleRegeneration":None,"deletedAt":None}
thread={"thread_id":"remote-command-center","project_id":"t3code","title":payload["title"],"default_provider":"codex","provider_instance_id":"codex","runtime_mode":"full-access","interaction_mode":"default","active_provider_thread_id":None,"created_at":now,"updated_at":now,"archived_at":None,"deleted_at":None,"payload_json":json.dumps(payload)}
db=sqlite3.connect(root/"userdata/statev2.sqlite")
with db:
 for table,row in [("projection_projects",project),("orchestration_v2_projection_threads",thread)]:
  cols=",".join(row); params=",".join("?" for _ in row)
  db.execute(f"INSERT OR REPLACE INTO {table} ({cols}) VALUES ({params})",list(row.values()))
db.close()
print("Seeded stopped thread remote-command-center with linked open PR 42 and checkout main")
