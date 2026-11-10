import os,subprocess,time,json
from pathlib import Path
root=Path('/tmp/lead-33577-r2/web')
envs={'before':{'DISPLAY':':113','XAUTHORITY':'/tmp/xvfb-run.vySN6C/Xauthority'},'after':{'DISPLAY':':112','XAUTHORITY':'/tmp/xvfb-run.BrbFiJ/Xauthority'}}
if __name__=='__main__':
 import sys
 side,name=sys.argv[1:];env={**os.environ,**envs[side]}
 for i in range(4):
  a=root/'raw'/f'{name}-{side}-settle-a.png';b=root/'raw'/f'{name}-{side}.png'
  subprocess.run(['import','-window','2097155',str(a)],env=env,check=True);time.sleep(.55);subprocess.run(['import','-window','2097155',str(b)],env=env,check=True)
  r=subprocess.run(['compare','-metric','AE',str(a),str(b),'null:'],capture_output=True)
  if r.returncode==0:print(str(b));break
 else:raise RuntimeError('frames did not settle')
