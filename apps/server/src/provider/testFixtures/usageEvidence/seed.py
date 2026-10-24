#!/usr/bin/env python3
"""Seed an initialized, stopped, disposable worktree .t3; never use production userdata."""
import json, os, pathlib, shutil, sqlite3, stat, subprocess, sys
root=pathlib.Path.cwd().resolve()
base=root/'.t3/userdata'
if not (root/'.git').is_file() or base.resolve()!=base or base.resolve()==(pathlib.Path.home()/'.t3/userdata').resolve():
    raise SystemExit('Run from an isolated worktree with its server stopped')
git=subprocess.run(['git','rev-parse','--path-format=absolute','--show-toplevel','--git-dir','--git-common-dir'],capture_output=True,text=True)
paths=git.stdout.splitlines()
if git.returncode or len(paths)!=3 or pathlib.Path(paths[0]).resolve()!=root or paths[1]==paths[2]:
    raise SystemExit('Run from an isolated worktree with its server stopped')
scenario=sys.argv[1]
if scenario not in ['S1','S2','S3','R1','R2','R3']: raise SystemExit('Unknown scenario')
fixture=pathlib.Path(__file__).resolve().parent
home=base/'usage-evidence-empty-home'
control=pathlib.Path('/tmp').resolve()/'issue-11873-evidence/control.json'
milestones=control.with_suffix('.json.milestones')
if home.is_symlink() or control.parent.resolve()!=control.parent or control.is_symlink() or milestones.is_symlink():
    raise SystemExit('Fixture home and control paths must not be symlinks')
# SQLite may write its sidecars as soon as the database is opened.
for target in [base/'settings.json', *(base/('statev2.sqlite'+suffix) for suffix in ['', '-wal', '-shm', '-journal']), control, milestones]:
    try:
        info=target.lstat()
    except FileNotFoundError:
        continue
    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1:
        raise SystemExit(f'Fixture files must be regular files without links: {target}')
control.parent.mkdir(mode=0o700,exist_ok=True)
info=control.parent.stat()
if info.st_uid!=os.getuid() or info.st_mode & 0o022:
    raise SystemExit('Fixture control directory must be owned by the current user and not writable by others')
if home.exists(): shutil.rmtree(home)
home.mkdir()
milestones.unlink(missing_ok=True)
config={'homePath':str(home),'binaryPath':'codex','launchArgs':'-c model_providers.cliproxy.name="cliproxy" -c model_providers.cliproxy.base_url="http://127.0.0.1:8317/v1" -c model_providers.cliproxy.env_key="ANTHROPIC_AUTH_TOKEN" -c model_providers.cliproxy.wire_api="responses" -c model_provider="cliproxy"'}
if scenario in ['S3','R2','R3']:
    config={'homePath':str(home),'binaryPath':str(fixture/'peer.mjs')}
settings={'projectSettingsFolded':True,'providerInstances':{'codex':{'driver':'codex','displayName':'Codex (via cliproxy)' if scenario in ['S1','S2','R1'] else 'Codex (protocol fixture)','config':config},'claudeAgent':{'driver':'claudeAgent','enabled':False}}}
if scenario in ['S2','R1']:
    settings['usageLimitSources']={'evidence-proxy':{'kind':'cliproxy','url':'http://127.0.0.1:18317','managementKey':'public-evidence-dummy-key','enabled':True,'label':'Demo proxy source'}}
(base/'settings.json').write_text(json.dumps(settings,indent=2)+'\n')
control.write_text(json.dumps({'scenario':scenario,'phase':'auth' if scenario=='R3' else 'success'}))
c=sqlite3.connect(base/'statev2.sqlite')
# Only projection context is seeded; provider responses still traverse the live RPC boundary.
for (name,) in c.execute("select name from sqlite_schema where type='table'").fetchall():
    if name.startswith('orchestration_v2_projection_') or name.startswith('projection_thread'):
        c.execute('DELETE FROM "'+name+'"')
c.execute('DELETE FROM projection_projects')
t='2026-10-22T12:00:00.000Z'
c.execute('INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES(?,?,?,?,?,?)',('evidence-project','Usage evidence',str(root),'[]',t,t))
payload={'createdBy':'user','creationSource':'web','lineage':{'parentThreadId':None,'relationshipToParent':None,'rootThreadId':'evidence-thread'},'id':'evidence-thread','projectId':'evidence-project','title':'Usage comparison','providerInstanceId':'codex','modelSelection':{'instanceId':'codex','model':'gpt-5.4'},'runtimeMode':'full-access','interactionMode':'default','branch':None,'worktreePath':None,'activeProviderThreadId':None,'createdAt':t,'updatedAt':t,'archivedAt':None,'deletedAt':None,'forkedFrom':None}
c.execute('INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json,provider_instance_id) VALUES(?,?,?,?,?,?,?,?,?,?)',('evidence-thread','evidence-project','Usage comparison','codex','full-access','default',t,t,json.dumps(payload),'codex'))
c.commit();c.close()
