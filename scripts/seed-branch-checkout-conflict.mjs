import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// Never overwrite an existing repo: each run owns a fresh disposable fixture.
const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-checkout-conflict-"));
const git = (...args) => NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" });
git("init", "-q", "-b", "main");
git("config", "user.name", "Checkout fixture");
git("config", "user.email", "fixture@example.invalid");
NodeFS.writeFileSync(NodePath.join(cwd, "example.txt"), "main\n");
git("add", "example.txt");
git("commit", "-qm", "main example");
git("checkout", "-qb", "feature");
NodeFS.writeFileSync(NodePath.join(cwd, "example.txt"), "feature\n");
git("commit", "-qam", "feature example");
git("checkout", "-q", "main");
NodeFS.writeFileSync(NodePath.join(cwd, "example.txt"), "uncommitted work\n");
console.log(`Fixture: ${cwd}`);
console.log(
  "Run this expression in the paired browser on your isolated dev origin to seed the project through projects.mutate RPC:",
);
console.log(`(async () => {
  const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws?orchestrationProtocol=2');
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(Error('Project seed timed out')); }, 10000);
    socket.onopen = () => socket.send(JSON.stringify({
      _tag: 'Request', id: '1', tag: 'projects.mutate', headers: [],
      payload: { type: 'project.create', commandId: crypto.randomUUID(), projectId: crypto.randomUUID(), title: 'Checkout conflict fixture', workspaceRoot: ${JSON.stringify(cwd)} }
    }));
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.requestId !== '1') return;
      clearTimeout(timer); socket.close();
      message.exit?._tag === 'Success' ? resolve(message.exit.value) : reject(Error(JSON.stringify(message)));
    };
    socket.onerror = () => { clearTimeout(timer); reject(Error('Project seed socket failed')); };
  });
})()`);
console.log(
  "Then use New thread > Checkout conflict fixture; keep Current checkout and select feature. Do not submit a message.",
);
console.log(
  "For create failure: search an unused branch, wait for Create row, run git branch <name> in this fixture, then click the stale Create row.",
);
