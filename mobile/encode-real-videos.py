import subprocess,json,concurrent.futures
from pathlib import Path
root=Path('/tmp/lead-33577-r2/mobile');raw=root/'raw';pub=root/'publish'
videos=[raw/(name+'.mp4') for name in ['m1-before-real-question-retake', 'm1-after-real-question-retake', 'm1-before-real-approval-retake', 'm1-after-real-approval-retake', 'm1-before-reject', 'm1-after-reject', 'm1-before-stop']]
def encode(p):
 out=pub/(p.stem+'.webp')
 subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-i',str(p),'-vf','fps=6,scale=480:-2','-loop','0','-c:v','libwebp_anim','-lossless','1','-q:v','100','-y',str(out)],check=True)
 assert out.stat().st_size<10*1024*1024
 print(out,out.stat().st_size,flush=True);return {'raw':str(p),'webp':str(out),'bytes':out.stat().st_size}
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:results=list(ex.map(encode,videos))
(root/'scripts/videos-real-retakes.json').write_text(json.dumps(results,indent=2))
