// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - verifies generated remote scripts using real shell and Node processes.
import { describe, expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { quoteRemoteArg, remoteDeviceScript } from "./sshDeviceScript.ts";
import { AGENT_DEVICE_VERSION, DEVICE_HUB_VERSION } from "./DeviceToolchain.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

it.skipIf(NodeOS.platform() === "win32")(
  "preserves shell metacharacters and newlines in remote arguments",
  async () => {
    const value = "quotes ' \" ; $(echo expanded) $HOME\nnext line";
    const result = await exec("sh", ["-c", `printf %s ${quoteRemoteArg(value)}`]);
    expect(result.stdout).toBe(value);
  },
);

describe.skipIf(NodeOS.platform() === "win32")("remote helper lifecycle", () => {
  it("reuses its own healthy helpers and stops only its own runtime", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-remote-script-"));
    const bin = NodePath.join(home, "bin");
    await NodeFSP.mkdir(bin);
    await NodeFSP.writeFile(NodePath.join(bin, "adb"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const root = NodePath.join(home, ".t3/device");
    const hubDir = NodePath.join(root, `tools/expo-device-hub@${DEVICE_HUB_VERSION}`);
    const agentDir = NodePath.join(root, `tools/agent-device@${AGENT_DEVICE_VERSION}`);
    const hub = NodePath.join(hubDir, "node_modules/expo-device-hub/dist/server/cli.mjs");
    const agent = NodePath.join(agentDir, "node_modules/agent-device/bin/agent-device.mjs");
    await NodeFSP.mkdir(NodePath.join(hubDir, "node_modules/expo-device-hub/dist/server"), {
      recursive: true,
    });
    await NodeFSP.mkdir(NodePath.join(agentDir, "node_modules/agent-device/bin"), {
      recursive: true,
    });
    await NodeFSP.writeFile(NodePath.join(hubDir, ".install-complete"), DEVICE_HUB_VERSION);
    await NodeFSP.writeFile(NodePath.join(agentDir, ".install-complete"), AGENT_DEVICE_VERSION);
    await NodeFSP.writeFile(
      hub,
      `import http from 'node:http';
const args=process.argv.slice(2); http.createServer((req,res)=>res.end('ok')).listen(Number(args[args.indexOf('--port')+1]),'127.0.0.1');`,
    );
    await NodeFSP.writeFile(
      agent,
      `import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http'; import {spawn} from 'node:child_process';
const args=process.argv.slice(2);
const state=process.env.AGENT_DEVICE_STATE_DIR || args[args.indexOf('--state-dir')+1];
const file=path.join(state,'daemon.json');
if(args[0]==='daemon') { const data=JSON.parse(fs.readFileSync(file,'utf8')); try {process.kill(data.pid,'SIGTERM')} catch {} }
else if(args[0]==='serve') { const server=http.createServer((req,res)=>res.end('ok')); server.listen(0,'127.0.0.1',()=>{fs.writeFileSync(file,JSON.stringify({httpPort:server.address().port,pid:process.pid,token:'test'}));process.send?.('ready');process.disconnect?.();}); }
else { const child=spawn(process.execPath,[process.argv[1],'serve'],{detached:true,stdio:['ignore','ignore','ignore','ipc'],env:process.env});await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);});child.unref(); }
`,
    );
    const invoke = async (owner: string, mode: "start" | "stop") => {
      const file = NodePath.join(home, `${owner}-${mode}.cjs`);
      await NodeFSP.writeFile(file, remoteDeviceScript(owner, mode));
      const result = await exec(process.execPath, [file], {
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
      });
      return result.stdout ? JSON.parse(result.stdout) : null;
    };
    try {
      const first = await invoke("one", "start");
      const second = await invoke("two", "start");
      const reused = await invoke("one", "start");
      expect(reused.hubPort).toBe(first.hubPort);
      expect(reused.daemonPort).toBe(first.daemonPort);
      expect(second.hubPort).not.toBe(first.hubPort);
      expect(second.daemonPort).not.toBe(first.daemonPort);
      await invoke("one", "stop");
      expect((await fetch(`http://127.0.0.1:${second.hubPort}/readyz`)).ok).toBe(true);
      expect(
        JSON.parse(await NodeFSP.readFile(NodePath.join(root, "hosts/two/hub.json"), "utf8")).owner,
      ).toBe("two");
    } finally {
      await invoke("one", "stop").catch(() => {});
      await invoke("two", "stop").catch(() => {});
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  });
});
