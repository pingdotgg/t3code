// Stand-in agent-device CLI, installed by the stand-in npm: records how a launcher ran it.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const records = process.env.DEVICE_STUB_RECORDS;
if (records) {
  NodeFS.mkdirSync(records, { recursive: true });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => /^(AGENT_DEVICE_|ELECTRON_RUN_AS_NODE$)/.test(name)),
  );
  NodeFS.writeFileSync(
    NodePath.join(records, `${Date.now()}-${process.pid}-agent-device.json`),
    JSON.stringify({ kind: "agent-device", argv: process.argv.slice(2), env }),
  );
}
process.stdout.write("{}\n");
