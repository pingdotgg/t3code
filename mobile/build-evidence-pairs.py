from pathlib import Path
import json
import numpy as np
from PIL import Image,ImageDraw
root=Path('/tmp/lead-33577-r2/mobile');pub=root/'publish';pub.mkdir(exist_ok=True)
paths={}
for platform,side in [('m1','before'),('m1','after'),('m2','before')]:
 paths[platform,side]={x['name']:x for x in json.loads((root/f'{platform}-{side}-harness-manifest.json').read_text())}
paths['m2','after']={name:{'path':str(root/'raw'/'m2-after-1794272007'/f'm2-after-h-{name}-b.png'),'identical':True} for name in ['pending-start','resumed','completed','expanded','approval-completed','history','runless-history','gallery','minute-1']}
choices={'m1':['pending-start','resumed','completed','expanded','approval-completed','history','runless-history','runless-ownership','wake','message-3','gallery','minute-1','deferred-failed','deferred-loaded','deferred-missing-wait'],'m2':['pending-start','resumed','completed','expanded','approval-completed','history','runless-history','gallery','minute-1']}
pairs=[]
for platform,names in choices.items():
 for name in names:
  a=paths[platform,'before'][name];b=paths[platform,'after'][name]
  if not a['identical'] or not b['identical']:print('SKIP unsettled',platform,name);continue
  before=Image.open(a['path']).convert('RGB');after=Image.open(b['path']).convert('RGB');assert before.size==after.size
  diff=np.abs(np.array(before).astype('int16')-np.array(after).astype('int16'));d0=pub/f'{platform}-h-{name}-diff0.png';dt=pub/f'{platform}-h-{name}-diff16.png'
  Image.fromarray(np.minimum(diff*32,255).astype('uint8')).save(d0)
  Image.fromarray(np.repeat((np.max(diff,axis=2)>16)[:,:,None],3,axis=2).astype('uint8')*255).save(dt)
  pairs.append({'id':f'{platform}-h-{name}','before':a['path'],'after':b['path'],'diff0':str(d0),'diff16':str(dt),'changedPixels':int(np.any(diff,axis=2).sum()),'thresholdPixels':int((np.max(diff,axis=2)>16).sum())})
(root/'pairs.json').write_text(json.dumps(pairs,indent=2));(root/'scripts'/'pairs.json').write_text(json.dumps(pairs,indent=2))
for chunk in range(0,len(pairs),3):
 sheet=Image.new('RGB',(1080,2040),'#777');draw=ImageDraw.Draw(sheet)
 for row,p in enumerate(pairs[chunk:chunk+3]):
  for col,field in enumerate(['before','after','diff0','diff16']):
   im=Image.open(p[field]);im.thumbnail((264,640));sheet.paste(im,(col*270,row*680+30));draw.text((col*270,row*680+5),p['id']+' '+field,fill='white')
 sheet.save(root/'review'/f'final-pairs-{chunk//3}.png')
print([(p['id'],p['changedPixels']) for p in pairs])
