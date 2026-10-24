#!/usr/bin/env python3
"""Unregistered whole-image RGBA diffs. Requires Pillow and numpy."""
import argparse
import json
from pathlib import Path
from PIL import Image
import numpy as np
p=argparse.ArgumentParser()
p.add_argument('before',type=Path);p.add_argument('after',type=Path);p.add_argument('prefix',type=Path)
a=p.parse_args()
b=Image.open(a.before).convert('RGBA');c=Image.open(a.after).convert('RGBA')
if b.size!=c.size: raise SystemExit(f'Dimensions differ: {b.size} vs {c.size}')
d=np.abs(np.asarray(b).astype(np.int16)-np.asarray(c).astype(np.int16))
m=d.max(axis=2);changed=m>0;threshold=m>16
zero=np.zeros((*m.shape,3),dtype=np.uint8)
zero[changed]=np.maximum(64,np.minimum(255,d[...,:3][changed]*16)).astype(np.uint8)
# Alpha-only differences are visible too, as magenta.
zero[(d[...,:3].max(axis=2)==0)&changed]=[255,0,255]
th=np.zeros_like(zero);th[threshold]=[255,32,128]
Image.fromarray(zero).save(str(a.prefix)+'-diff0.png')
Image.fromarray(th).save(str(a.prefix)+'-diffT.png')
result={'before':str(a.before),'after':str(a.after),'dimensions':b.size,'pixels':int(m.size),'changed0':int(changed.sum()),'changedT':int(threshold.sum()),'maxDelta':int(m.max()),'threshold':'max absolute RGBA channel delta >16','amplification':'absolute RGB channel delta x16; nonzero pixels min64; alpha-only magenta','registration':'none; no masks; complete image','colorspace':'8-bit decoded PNG RGBA, no color conversion beyond RGBA decode'}
Path(str(a.prefix)+'-stats.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
