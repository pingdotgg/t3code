from pathlib import Path
from PIL import Image,ImageDraw,ImageSequence
r=Path('/tmp/lead-33577-r2/mobile');paths=list((r/'publish').glob('*.webp'))
for p in paths:
 im=Image.open(p);frames=[];time=0
 for f in ImageSequence.Iterator(im):
  d=f.info.get('duration',100);frames.append((time,f.copy().convert('RGB')));time+=d
 targets=[time*i/5 for i in range(6)];sheet=Image.new('RGB',(900,1400),'#888');draw=ImageDraw.Draw(sheet)
 for i,t in enumerate(targets):
  _,f=next(((ts,f) for ts,f in reversed(frames) if ts<=t),frames[0]);f.thumbnail((295,660));x=i%3*300;y=i//3*700;sheet.paste(f,(x,y+25));draw.text((x,y),f'{t/1000:.1f}s',fill='white')
 sheet.save(r/'review'/(p.stem+'-webp.png'));print(p.name,len(frames),time/1000)
