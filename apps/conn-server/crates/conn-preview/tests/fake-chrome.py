#!/usr/bin/python3
import os, json
r = os.fdopen(3, 'rb', buffering=0)
w = os.fdopen(4, 'wb', buffering=0)
seq = 0

def send(message):
    w.write(json.dumps(message).encode() + b'\0')

while True:
    data = bytearray()
    while True:
        byte = r.read(1)
        if not byte:
            quit()
        if byte == b'\0':
            break
        data.extend(byte)
    command = json.loads(data)
    method = command['method']
    params = command.get('params', {})
    result = {}
    events = []
    if method == 'Browser.close':
        quit()
    if method == 'Target.createBrowserContext':
        seq += 1
        result = {'browserContextId': 'context-' + str(seq)}
    if method == 'Target.createTarget':
        seq += 1
        result = {'targetId': 'target-' + str(seq)}
    if method == 'Target.attachToTarget':
        seq += 1
        result = {'sessionId': 'session-' + str(seq)}
    if method == 'Page.captureScreenshot':
        result={'data':'Zml4dHVyZQ=='}
    if method == 'Page.getFrameTree':
        result={'frameTree': {'frame': {'id':'frame'}}}
    if method == 'Page.createIsolatedWorld':
        result={'executionContextId':1}
    if method == 'Page.navigate':
        result = {'frameId': 'frame'}
        events = [('Page.frameNavigated', {'frame': {'url': params['url'], 'id': 'frame'}}), ('Page.lifecycleEvent', {'name': 'DOMContentLoaded'}), ('Page.lifecycleEvent', {'name': 'load'})]
    if method == 'Runtime.evaluate':
        expression=params.get('expression','')
        value='Fixture' if expression=='document.title' else ([] if 'password' in expression else (True if '__connInjected' in expression else 2))
        result={'result':{'value':value}}
    send({'id': command['id'], 'result': result})
    for event, params in events:
        send({'method': event, 'params': params, 'sessionId': command['sessionId']})
