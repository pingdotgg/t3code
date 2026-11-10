from pathlib import Path
from PIL import Image, ImageChops
import json,re
r=Path('/tmp/lead-33577-r2/mobile')
pairs=json.loads((r/'scripts/pairs.json').read_text())
attachments=(r/'scripts/attachment-manifest.md').read_text().splitlines()
byname={re.match(r'!\[(.*)\]\((.*)\)',s)[1]:s for s in attachments}
for pair in pairs:
 for key in ['before','after']:
  p=Path(pair[key]);a=p.with_name(p.name.replace('-b.png','-a.png'))
  assert a.exists(),a
  assert ImageChops.difference(Image.open(a).convert('RGB'),Image.open(p).convert('RGB')).getbbox() is None,(pair['id'],key,'unstable')
 for key in ['before','after','diff0','diff16']:
  p=Path(pair[key]);assert p.exists(),p;assert p.name in byname,p.name
 print(pair['id'],'stable both sides; uploaded original and both diffs')
for name in byname:
 if name.endswith('.webp'):
  p=r/'publish'/name;assert p.exists(),p;assert p.stat().st_size<10*1024*1024,p
  im=Image.open(p);assert im.n_frames>1,(name,'not animated')
print('PASS:',len(pairs),'settled pairs,',len(attachments),'successful uploader lines,',sum(n.endswith('.webp') for n in byname),'animated videos')
