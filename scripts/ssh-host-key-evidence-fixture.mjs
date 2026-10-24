import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
const [directory, mode = "unknown", portText = "22269"] = process.argv.slice(2);
if (!directory || !["unknown", "changed"].includes(mode))
  throw new Error(
    "Usage: node scripts/ssh-host-key-evidence-fixture.mjs <isolated-directory> <unknown|changed> [port]",
  );
const root = NodePath.resolve(directory);
const port = Number(portText);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
if (!root.startsWith("/tmp/")) throw new Error("Use an isolated directory under /tmp");
NodeFS.mkdirSync(NodePath.join(root, "bin"), { recursive: true });
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const knownHosts = NodePath.join(root, "evidence_known_hosts");
const config = NodePath.join(root, "ssh_config");
NodeFS.writeFileSync(
  config,
  `Host *\n  UserKnownHostsFile ${quote(knownHosts)}\n  GlobalKnownHostsFile /dev/null\n  StrictHostKeyChecking ask\n`,
);
NodeFS.writeFileSync(
  NodePath.join(root, "bin/ssh"),
  `#!/bin/sh\nexec /usr/bin/ssh -F ${quote(config)} "$@"\n`,
  {
    mode: 0o755,
  },
);
if (mode === "changed") {
  const key = NodePath.join(root, "mismatched_key");
  if (!NodeFS.existsSync(key))
    NodeChildProcess.execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  const [type, value] = NodeFS.readFileSync(key + ".pub", "utf8")
    .trim()
    .split(/\s+/);
  NodeFS.writeFileSync(knownHosts, `[127.0.0.1]:${port} ${type} ${value}\n`);
} else NodeFS.writeFileSync(knownHosts, "");
const common = {
  connectionId: "issue5869-ssh",
  environmentId: "issue5869-host",
  label: "Host key fixture",
};
const catalog = {
  schemaVersion: 1,
  targets: [{ _tag: "SshConnectionTarget", ...common }],
  profiles: [
    {
      _tag: "SshConnectionProfile",
      ...common,
      target: { alias: "127.0.0.1", hostname: "127.0.0.1", username: "ubuntu", port },
    },
  ],
  credentials: [],
  remoteDpopTokens: [],
  disabledEnvironmentIds: [],
};
NodeFS.writeFileSync(NodePath.join(root, "catalog.json"), JSON.stringify(catalog, null, 2));
console.log(
  `Prepared ${mode} host-key fixture in ${root}. Start an isolated sshd on port ${port} with a DIFFERENT host key. Launch Electron with PATH=${quote(NodePath.join(root, "bin"))}:$PATH, isolated T3CODE_HOME and XDG_CONFIG_HOME. The wrapper invokes real OpenSSH with isolated trust files. Add ubuntu@127.0.0.1:${port} in Connections for the dialog fixture. To seed the saved connection, pass catalog.json contents to desktopBridge.setConnectionCatalog and reload. The catalog contains no credentials. Never use this fixture against a real server or real known_hosts.`,
);
