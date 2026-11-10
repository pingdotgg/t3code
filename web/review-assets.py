from PIL import Image,ImageDraw,ImageChops
from pathlib import Path
import json,subprocess
root=Path('/tmp/lead-33577-r2/web');(root/'review').mkdir(exist_ok=True);(root/'diffs').mkdir(exist_ok=True)
files=sorted(p for p in (root/'raw').glob('*.png') if '-settle-' not in p.name and not p.name.endswith('-a.png') and 'probe' not in p.name and 'complete-probe' not in p.name)
pairs=[]
for a in files:
 if not a.name.endswith('-before.png'):continue
 b=a.with_name(a.name.replace('-before.png','-after.png'))
 if not b.exists():continue
 x=Image.open(a).convert('RGB');y=Image.open(b).convert('RGB');
 if x.size!=y.size:continue
 import numpy as np
 delta=np.abs(np.asarray(x).astype('int16')-np.asarray(y).astype('int16'))
 # Diff0: every changed channel amplified 16x; DiffT: mask max channel >16/255.
 d0=Image.fromarray(np.minimum(delta*16,255).astype('uint8'));mask=delta.max(axis=2)>16;dt=Image.fromarray(np.where(mask[:,:,None],np.array([255,0,200]),np.array([0,0,0])).astype('uint8'))
 name=a.name[:-11];p0=root/'diffs'/f'{name}-diff0.png';pt=root/'diffs'/f'{name}-diffT16.png';d0.save(p0);dt.save(pt)
 pairs.append({'name':name,'before':str(a),'after':str(b),'diff0':str(p0),'diffT':str(pt),'changed0':int((delta.max(axis=2)>0).sum()),'changedT':int(mask.sum()),'pixels':x.width*x.height,'size':x.size})
(root/'scripts/pairs.json').write_text(json.dumps(pairs,indent=2))
# Contact sheets include every selected capture and both differences, with enough text to locate them.
for offset in range(0,len(pairs),5):
 batch=pairs[offset:offset+5];sheet=Image.new('RGB',(1440,5*400),'#444');draw=ImageDraw.Draw(sheet)
 for i,pair in enumerate(batch):
  draw.text((6,i*400+4),pair['name']+' : Before | After | Diff0 x16 | DiffT >16',fill='white')
  for j,key in enumerate(['before','after','diff0','diffT']):
   im=Image.open(pair[key]).convert('RGB');im.thumbnail((354,370));sheet.paste(im,(j*360,i*400+24))
 sheet.save(root/'review'/f'comparison-{offset//5:02}.jpg',quality=92)
print('pairs',len(pairs),'sheets',(len(pairs)+4)//5)
