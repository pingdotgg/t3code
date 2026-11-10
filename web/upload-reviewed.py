from pathlib import Path
import json,subprocess,concurrent.futures
r=Path('/tmp/lead-33577-r2/web')
files=json.loads((r/'scripts/upload-files.json').read_text())
def upload(path):
 x=subprocess.run(['/tmp/lead-33577-r2/cafe-upload.sh',path],text=True,capture_output=True,check=True)
 return path,x.stdout
with concurrent.futures.ThreadPoolExecutor(max_workers=3)as pool:
 for path,output in pool.map(upload,files):
  with (r/'uploads.md').open('a')as f:f.write(output)
  with (r/'scripts/upload-map.jsonl').open('a')as f:f.write(json.dumps({'path':path,'markdown':output})+'\n')
  print(Path(path).name,flush=True)
