#!/usr/bin/python3
import os, json
r = os.fdopen(3, 'rb', buffering=0)
w = os.fdopen(4, 'wb', buffering=0)
seq = 0
closed_targets = 0
casts = 0
acks = 0
downloads = []

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
    if method == 'Fixture.hang':
        send({'method':'Fixture.pending','params':{}})
        continue
    if method == 'Page.screencastFrameAck': events.append(('Fixture.acked', {}))
    if method == 'Browser.close':
        if os.path.exists('ignore-close'): continue
        quit()
    if method == 'Fixture.targets':
        for i in range(40): send({'method':'Target.targetCreated','params':{'targetInfo':{'type':'page','targetId':str(i)}}})
    if method == 'Target.closeTarget': closed_targets += 1
    if method == 'Page.startScreencast': casts += 1
    if method == 'Page.screencastFrameAck': acks += 1
    if method == 'Fixture.frame': events = [('Page.screencastFrame', {'sessionId':1,'data':'Zml4dHVyZQ=='})]
    if method == 'Fixture.fileChooser': events = [('Page.fileChooserOpened', {'backendNodeId':42,'mode':params['mode']})]
    if method == 'DOM.describeNode': result = {'node':{'attributes':['type','file','accept','image/png,image/jpeg']}}
    if method == 'Browser.setDownloadBehavior': downloads.append(params)
    if method == 'Fixture.counts': result = {'closed':closed_targets,'casts':casts,'acks':acks,'downloads':downloads}
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
        send({'method': event, 'params': params, 'sessionId': command.get('sessionId')})
