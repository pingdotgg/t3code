import runpy,sys,json,sqlite3,copy,pathlib,subprocess,argparse
parser=argparse.ArgumentParser(description='Seed stopped linked-PR native fixtures in an isolated migrated home')
parser.add_argument('home',type=pathlib.Path)
parser.add_argument('--output',type=pathlib.Path,required=True)
args=parser.parse_args()
root=args.home.resolve()
sys.argv=['seed.py',str(root)]
runpy.run_path(str(pathlib.Path(__file__).with_name('seed.py')),run_name='__main__')
db=sqlite3.connect(root/'userdata/statev2.sqlite'); db.row_factory=sqlite3.Row
row=dict(db.execute("select * from orchestration_v2_projection_threads where thread_id='remote-command-center'").fetchone())
payload=json.loads(row['payload_json']); l42=payload['pullRequests'][0]
def link(n,title,head,state='open',base='main'):
 l=copy.deepcopy(l42); l.update(number=n,url=f'https://github.com/example/fixture/pull/{n}')
 l['snapshot'].update(title=title,headBranch=head,state=state,baseBranch=base)
 if n==43:l['linkedAt']='2026-10-21T12:01:00.000Z'
 return l
l43=link(43,'Second linked change with a deliberately long title for narrow native sheets','second-feature')
l44=link(44,'Closed linked change','closed-feature','closed')
l45=link(45,'Merged linked change','merged-feature','merged')
l42pending=copy.deepcopy(l42); l42pending['snapshot']=None
l43pending=copy.deepcopy(l43); l43pending['snapshot']=None
l43stack=copy.deepcopy(l43); l43stack['snapshot']['baseBranch']='fork-feature'
fixtures={'f0':[],'f1':[l42],'f2':[l42pending],'f3c':[l44],'f3m':[l45],'f4':[l42],'f5':[l45,l44,l42,l43pending],'f6':[l42,l43stack]}
with db:
 for f,links in fixtures.items():
  ident='remote-command-center' if f=='f1' else 'remote-command-center-'+f
  p=copy.deepcopy(payload); p.update(id=ident,title=f.upper()+' Linked PR fixture',pullRequests=links); p['lineage']['rootThreadId']=ident
  r=copy.deepcopy(row); r.update(thread_id=ident,title=p['title'],payload_json=json.dumps(p))
  if f=='f4':
   w=root/'workspace-f4'
   if not w.exists():subprocess.run(['git','clone','--quiet',str(root/'workspace'),str(w)],check=True)
   p['worktreePath']=str(w); r['payload_json']=json.dumps(p)
  cols=','.join(r); marks=','.join('?' for _ in r)
  db.execute(f'INSERT OR REPLACE INTO orchestration_v2_projection_threads ({cols}) VALUES ({marks})',list(r.values()))
with db:
 ids=['remote-command-center' if f=='f1' else 'remote-command-center-'+f for f in fixtures]
 marks=','.join('?' for _ in ids)
 db.execute(f'DELETE FROM orchestration_v2_projection_threads WHERE thread_id NOT IN ({marks})',ids)
 db.execute("DELETE FROM projection_projects WHERE project_id != ?",['t3code'])
db.close()
args.output.parent.mkdir(parents=True,exist_ok=True)
args.output.write_text(json.dumps(fixtures,indent=2))
print('Seeded 8 stopped fixture threads F0,F1,F2,F3c,F3m,F4,F5,F6')
