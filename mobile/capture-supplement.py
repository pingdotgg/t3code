import subprocess,time,json,re,sys
from pathlib import Path
side=sys.argv[1];r=Path('/tmp/lead-33577-r2/mobile');run=r/'raw'/f'm1-{side}-supplement-{int(time.time())}';run.mkdir();log=open(run/'driver.log','w')
def cmd(*a):
 p=subprocess.run(['agent-device',*a,'--session','pr33577-mobile-android'],text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT);log.write(f'{time.time()} {a}\n{p.stdout}\n');log.flush()
 if p.returncode:raise RuntimeError(p.stdout)
 return p.stdout
def press(t):cmd('press','label="'+t+'"','--settle')
def fold():
 snap=cmd('snapshot','-i');m=re.search(r'\[button\] "(Worked[^"\n]*)"',snap)
 if m:press(m[1]);time.sleep(1);press(m[1])
cmd('wait','text','Next chapter');time.sleep(2);cmd('record','start',str(run/f'm1-{side}-h-approval-supplement.mp4'),'--hide-touches');time.sleep(2)
for i in range(4):press('Next stage');time.sleep(3)
fold();cmd('record','stop')
cmd('record','start',str(run/f'm1-{side}-h-ownership-supplement.mp4'),'--hide-touches')
for page in range(1,9):
 press('Next chapter');time.sleep(2)
 if page in [1,2]:fold()
 if page==4:
  press('Next stage');time.sleep(2);press('Next stage');time.sleep(2)
 if page==5:
  for i in range(3):press('Next stage');time.sleep(2)
 if page==7:
  for i in range(2):press('Next stage');time.sleep(2)
 if page==8:
  for i in range(5):press('Next stage');time.sleep(1)
cmd('record','stop')
(r/'scripts'/f'supplement-{side}.json').write_text(json.dumps({'directory':str(run),'kind':'approval','heartbeat':'500ms native repaint counter; fixture clock frozen at each step','coreStages':[1,2,62,64,65]},indent=2))
