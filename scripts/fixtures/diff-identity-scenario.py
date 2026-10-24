#!/usr/bin/env python3
"""Reproduce the supplemental browser fixtures without opening app state.

Usage: diff-identity-scenario.py DIR {defaults,headers,truncated,single} [CELL]
CELL is 1440-light, 1440-dark, 390-light, 390-dark, ONE, or TWO.
The base generator guards DIR before any files are replaced.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
def read(path):
    return path.read_text(encoding='utf-8')
def write(path, value):
    path.write_text(value, encoding='utf-8', newline='\n')
scenario = sys.argv[2]
cell = sys.argv[3] if len(sys.argv) > 3 else '1440-light'
assert scenario in ('defaults', 'headers', 'truncated', 'single')
assert cell in ('1440-light', '1440-dark', '390-light', '390-dark', 'ONE', 'TWO')
base = json.loads(subprocess.check_output([
    sys.executable, str(Path(__file__).with_name('diff-identity.py')),
    str(root), 'zero' if scenario == 'single' else 'amplified',
], text=True))
if scenario == 'single':
    assert cell in ('ONE', 'TWO')
    write(root / 'a-modified-0.txt', f'single-file version {cell}\n')
else:
    marker = ('C25-final-' + cell if scenario == 'defaults' else
              'C6-' + cell if scenario == 'headers' else 'C8-truncated')
    target = root / 'a-modified-0.txt'
    write(target, marker + '\n' + read(target))
    target = root / 'b-added-0.txt'
    if scenario == 'headers':
        write(target, read(target) + 'truncation sentinel ' + 'z' * 160000 + '\n')
    elif scenario == 'truncated':
        write(target, read(target) + ''.join(
            f'{i:05d} truncation sentinel ' + 'z' * 112 + '\n' for i in range(11000)
        ))
patch = subprocess.check_output([
    'git', '-C', str(root), 'diff', '-O/dev/null', '--unified=3', '--inter-hunk-context=0', '--find-renames', '--no-color',
    '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/',
    '--minimal', '--patch', 'HEAD', '--', *base['paths'],
])
print(json.dumps({
    'schema': 1, 'scenario': scenario, 'cell': cell, 'base': base,
    'patchBytes': len(patch), 'patchSha256': hashlib.sha256(patch).hexdigest(),
}, indent=2))
