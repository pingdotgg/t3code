from pathlib import Path
import subprocess,json
from PIL import Image,ImageDraw
root=Path('/tmp/lead-33577-r2/web');names=['B1-initial-real','H-approval-lifecycle','H-question-lifecycle','B3-harness','B4-approval-exit','B4-question-fresh','D1-real','G1-harness','B5-F13-harness','B5-F15-harness','B5-F17-harness','B1-F14-harness','B1-stop-clean','B1-reject-real','B2-fresh-real','B5-F12-boundary','B5-F12-hover']
for name in names:
 for side in ['before','after']:
  p=root/'raw'/f'{name}-{side}.mp4'
  if not p.exists():continue
  duration=float(subprocess.check_output(['ffprobe','-v','quiet','-show_entries','format=duration','-of','csv=p=0',str(p)]))
  times=[min(duration-.2,t)for t in [0,duration*.2,duration*.45,duration*.65,duration*.82,duration-.5]]
  sheet=Image.new('RGB',(1440,660),'#444');draw=ImageDraw.Draw(sheet)
  for i,t in enumerate(times):
   out=root/'review'/f'frame-{name}-{side}-{i}.png'
   subprocess.run(['ffmpeg','-y','-loglevel','error','-ss',str(max(0,t)),'-i',str(p),'-frames:v','1','-vf','scale=480:290:force_original_aspect_ratio=decrease',str(out)],check=True)
   im=Image.open(out).convert('RGB');x=(i%3)*480;y=(i//3)*330;draw.text((x+5,y+5),f'{name} {side} t={t:.1f}s',fill='white');sheet.paste(im,(x,y+25))
  sheet.save(root/'review'/f'video-{name}-{side}.jpg',quality=94)
print('finished filmstrips')
