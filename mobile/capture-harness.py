import subprocess,sys,time,json
from pathlib import Path
from PIL import Image,ImageChops
platform,side=sys.argv[1:3]
session='pr33577-mobile-'+('android' if platform=='m1' else 'ios')
root=Path('/tmp/lead-33577-r2/mobile');runid=str(int(time.time()));raw=root/'raw'/f'{platform}-{side}-{runid}';raw.mkdir();cwd='/home/ubuntu/wt/pr-33577-mobile-'+('before' if platform=='m1' else 'after')
log=open(root/f'{platform}-{side}-harness-driver.log','w')
manifest=[]
def cmd(*args):
 start=time.time();p=subprocess.run(['agent-device',*args,'--session',session],cwd=cwd,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT);log.write(f'{time.time()} {args}\n{p.stdout}\n');log.flush()
 if p.returncode: raise RuntimeError(p.stdout)
 return p.stdout
def press(label):cmd('press',label if label.startswith('@') else f'label="{label}"','--settle')
def still(name):
 a=raw/f'{platform}-{side}-h-{name}-a.png';b=raw/f'{platform}-{side}-h-{name}-b.png'
 cmd('screenshot',str(a));time.sleep(.5);cmd('screenshot',str(b))
 same=ImageChops.difference(Image.open(a).convert('RGB'),Image.open(b).convert('RGB')).getbbox() is None
 manifest.append({'name':name,'path':str(b),'identical':same,'at':time.time()})
 if not same and not name.startswith(('priorities','deferred-loading','deferred-retry')):raise RuntimeError('Unsettled '+name)
cmd('record','start',str(raw/f'{platform}-{side}-h-core.mp4'),'--hide-touches')
still('start')
for stage in ['pending-start','pending-end','resumed','completed']:
 press('Next stage');still(stage)
# Toggle the production fold by its currently visible accessible label.
snap=cmd('snapshot','-i');import re
fold=re.search(r'\[button\] "(Worked[^"\n]*)"',snap)
if fold:press(fold.group(1));still('expanded');press(fold.group(1))
press('Request type');still('approval-completed')
cmd('record','stop')
cmd('record','start',str(raw/f'{platform}-{side}-h-chapters.mp4'),'--hide-touches')
for page in ['history','runless-history','runless-ownership','wake','message','gallery','minute','priorities','deferred']:
 press('Next chapter');still(page)
 if page=='deferred':
  snap=cmd('snapshot','-i');fold=re.search(r'\[button\] "(Worked[^"\n]*)"',snap)
  if fold:
   press(fold.group(1));still('deferred-loading');press('Fail deferred');still('deferred-failed')
   snap=cmd('snapshot','-i');retry=re.search(r'\[button\] "(Worked[^"\n]*)"',snap)
   if retry:press(retry.group(1));still('deferred-retry')
   else:
    busy=re.search(r'(@e[0-9]+[^ ]*) \[button\] "busy"',snap)
    if busy:press(busy.group(1))
   cmd('snapshot','-i');press('Complete deferred');cmd('snapshot','-i');still('deferred-loaded');cmd('snapshot','-i');press('Missing wait control');still('deferred-missing-wait')
 if page in ['wake','message','minute','priorities']:
  for i in range(5 if page=='priorities' else 3 if page=='message' else 2):press('Next stage');still(f'{page}-{i+1}')
cmd('record','stop')
(root/f'{platform}-{side}-harness-manifest.json').write_text(json.dumps(manifest,indent=2))
