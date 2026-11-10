from pathlib import Path
for side in ['before','after']:
 p=Path('/home/ubuntu/wt/pr-33577-mobile-'+side+'/apps/server/scripts/dev-replay-agent.ts')
 s=p.read_text()
 old='''        await untilAbort(response, signal);
        pendingAgentRequests.delete(String(id));'''
 new='''        await untilAbort(response, signal);
        const captureDir = "/tmp/lead-33577-r2/mobile/gates/SIDE";
        NodeFS.mkdirSync(captureDir, { recursive: true });
        const release = `${captureDir}/${sessionId}.release`;
        NodeFS.writeFileSync(`${captureDir}/${sessionId}.waiting.json`, JSON.stringify({sessionId, answeredAt: new Date().toISOString()}));
        await untilAbort(new Promise<void>((resolve) => {
          const watcher = NodeFS.watch(captureDir, () => {
            if (NodeFS.existsSync(release)) { watcher.close(); resolve(); }
          });
          if (NodeFS.existsSync(release)) { watcher.close(); resolve(); }
          signal.addEventListener("abort", () => { watcher.close(); resolve(); }, {once:true});
        }), signal);
        pendingAgentRequests.delete(String(id));'''.replace('SIDE',side)
 assert old in s
 p.write_text(s.replace(old,new))
