import subprocess,sys,time,re,json
from pathlib import Path
from PIL import Image,ImageChops
platform,side=sys.argv[1:3];session='pr33577-mobile-'+('android' if platform=='m1' else 'ios');root=Path('/tmp/lead-33577-r2/mobile');raw=root/'raw'/f'{platform}-{side}-tail-{int(time.time())}';raw.mkdir();log=open(raw/'driver.log','w');manifest=[]
def cmd(*args):
 p=subprocess.run(['agent-device',*args,'--session',session],text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT);log.write(f'{time.time()} {args}\n{p.stdout}\n');log.flush()
 if p.returncode:raise RuntimeError(p.stdout)
 return p.stdout
def press(t):cmd('press',f'label="{t}"','--settle')
def still(name):
 a=raw/f'{platform}-{side}-h-{name}-a.png';b=raw/f'{platform}-{side}-h-{name}-b.png';cmd('screenshot',str(a));time.sleep(.5);cmd('screenshot',str(b));same=ImageChops.difference(Image.open(a).convert('RGB'),Image.open(b).convert('RGB')).getbbox() is None;manifest.append({'name':name,'path':str(b),'identical':same});print(name,same,flush=True)
# Called after the initial driver stops at the intentional syncing spinner, chapter 8/stage 1.
for i in range(4):press('Next stage')
press('Next chapter');still('deferred')
snap=cmd('snapshot','-i');label=re.search(r'\[button\] "(Worked[^"\n]*)"',snap).group(1)
press(label);cmd('snapshot','-i');press('Fail deferred');still('deferred-failed')
snap=cmd('snapshot','-i');label=re.search(r'\[button\] "(Worked[^"\n]*)"',snap).group(1)
press(label);cmd('snapshot','-i');press('Complete deferred');still('deferred-loaded');press('Missing wait control');still('deferred-missing-wait');cmd('record','stop')
(root/f'{platform}-{side}-tail-manifest.json').write_text(json.dumps(manifest,indent=2))
