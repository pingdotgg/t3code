#!/usr/bin/env python3
"""Apply ONLY to a disposable checkout. Temporary index/profile, real native module."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
p=argparse.ArgumentParser()
p.add_argument('checkout',type=Path)
a=p.parse_args()
root=a.checkout.resolve()
if root == Path(__file__).resolve().parents[3]:
    raise SystemExit('Use a separate disposable checkout, not fixture source checkout')
sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
fixture=Path(__file__).with_name('native-fixture.tsx.template').read_text()
(root/'apps/mobile/issue14463-static.tsx').write_text(fixture.replace('__PRODUCT_SHA__',sha[:12]))
(root/'apps/mobile/index.ts').write_text("import './issue14463-static';\n")
profile=root/'apps/mobile/eas.json'
data=json.loads(profile.read_text())
data['build']['issue14463-static']={'corepack':True,'distribution':'internal','environment':'preview','env':{'APP_VARIANT':'preview','NODE_OPTIONS':'--max-old-space-size=8192'},'ios':{'simulator':True,'image':'macos-tahoe-26.6-xcode-27.1'},'developmentClient':False}
profile.write_text(json.dumps(data,indent=2)+'\n')
# Include ignored native vendored frameworks when EAS packs the disposable checkout.
ignore=root/'.easignore'
text=(root/'.gitignore').read_text()
ignore.write_text(text+'\n!apps/mobile/modules/t3-terminal/Vendor/\n!apps/mobile/modules/t3-terminal/Vendor/**\n.env*\n**/.env*\n')
print(json.dumps({'productSha':sha,'templateSha256':hashlib.sha256(fixture.encode()).hexdigest(),'profile':'issue14463-static','limitedIntegration':'server arbitration, WS delivery, connection permissions/navigation not exercised'}))
