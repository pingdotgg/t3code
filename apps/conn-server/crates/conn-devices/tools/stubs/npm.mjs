// Stand-in `npm` for the device conformance check: `npm install --prefix <dir> … <name>@<version>`
// lays out the package's entry file. agent-device's entry is the recording stand-in CLI.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const argv = process.argv.slice(2);
const records = process.env.DEVICE_STUB_RECORDS;
if (records) {
  NodeFS.mkdirSync(records, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(records, `${Date.now()}-${process.pid}-npm.json`),
    JSON.stringify({ kind: "npm", argv }),
  );
}
const prefix = argv[argv.indexOf("--prefix") + 1];
const spec = argv.at(-1);
const name = spec.slice(0, spec.lastIndexOf("@"));
const entries = {
  "agent-device": ["bin", "agent-device.mjs"],
  "expo-device-hub": ["dist", "server", "cli.mjs"],
};
const entry = NodePath.join(prefix, "node_modules", name, ...entries[name]);
NodeFS.mkdirSync(NodePath.dirname(entry), { recursive: true });
NodeFS.copyFileSync(new URL("./agent-device.mjs", import.meta.url), entry);
