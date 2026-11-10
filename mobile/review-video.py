from pathlib import Path
import subprocess,json,sys
from PIL import Image,ImageDraw
root=Path('/tmp/lead-33577-r2/mobile');out=root/'review';out.mkdir(exist_ok=True)
for video in sys.argv[1:]:
 p=Path(video);dur=float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','json',video],text=True).strip().split('"duration": "')[1].split('"')[0]);frames=[]
 for i in range(8):
  shot=out/f'{p.stem}-{i}.png';t=max(0,min(dur-.1,dur*i/7));subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-ss',str(t),'-i',video,'-frames:v','1','-y',str(shot)],check=True)
  if shot.exists():frames.append((shot,t))
 sheet=Image.new('RGB',(1200,1450),'#888');d=ImageDraw.Draw(sheet)
 for i,(shot,t) in enumerate(frames):
  im=Image.open(shot);im.thumbnail((290,680));x=i%4*300;y=i//4*725;sheet.paste(im,(x,y+25));d.text((x,y),f'{t:.1f}s',fill='white')
 dest=out/f'{p.stem}-contact.png';sheet.save(dest);print(video,dur,dest)
