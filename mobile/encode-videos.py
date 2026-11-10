import subprocess,json,concurrent.futures
from pathlib import Path
root=Path('/tmp/lead-33577-r2/mobile');raw=root/'raw';pub=root/'publish'
videos=[raw/'m1-before-1794272655/m1-before-h-core.mp4',raw/'m1-after-1794272252/m1-after-h-core.mp4',raw/'m2-before-1794272619/m2-before-h-core.mp4',raw/'m2-after-1794272007/m2-after-h-core.mp4',raw/'m1-before-1794272655/m1-before-h-chapters.mp4',raw/'m1-after-1794272252/m1-after-h-chapters.mp4',raw/'m2-before-approval.mp4',raw/'m2-after-approval.mp4',raw/'m2-before-question-valid.mp4',raw/'m2-after-question.mp4']
def encode(p):
 out=pub/(p.stem+'.webp')
 subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-i',str(p),'-vf','fps=6,scale=480:-2','-loop','0','-c:v','libwebp_anim','-lossless','1','-q:v','100','-y',str(out)],check=True)
 assert out.stat().st_size<10*1024*1024
 print(out,out.stat().st_size,flush=True);return {'raw':str(p),'webp':str(out),'bytes':out.stat().st_size}
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:results=list(ex.map(encode,videos))
(root/'scripts/videos.json').write_text(json.dumps(results,indent=2))
