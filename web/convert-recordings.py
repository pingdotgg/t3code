from pathlib import Path
import subprocess,json,concurrent.futures
root=Path('/tmp/lead-33577-r2/web');(root/'animations').mkdir(exist_ok=True)
records=json.loads((root/'scripts/video-metadata.json').read_text())
def convert(x):
 p=Path(x['path']);out=Path(x['publicAnimation']);args=['ffmpeg','-y','-loglevel','error','-i',str(p)]
 if x['name']=='D1-real':args+=['-t',str(x['publicDuration'])]
 args+=['-vf','fps=6,scale=960:-2:force_original_aspect_ratio=decrease','-loop','0','-c:v','libwebp_anim','-q:v','65',str(out)]
 subprocess.run(args,check=True)
 if out.stat().st_size>10*1024*1024:raise Exception('Oversize '+str(out))
 return {'name':out.name,'size':out.stat().st_size}
with concurrent.futures.ThreadPoolExecutor(max_workers=3)as pool:
 for result in pool.map(convert,records):print(json.dumps(result),flush=True)
