import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import data from "./data.json" with { type: "json" };

const [home, role] = process.argv.slice(2);
if (!home || !["before", "after", "remote"].includes(role)) {
  throw new Error("Usage: node init.mjs <new-disposable-home> <before|after|remote>");
}
const directory = NodePath.resolve(home);
if (!directory.startsWith("/tmp/issue-22024-")) {
  throw new Error("Fixture homes must be new /tmp/issue-22024-* directories");
}
await NodeFSP.mkdir(directory);
await NodeFSP.mkdir(NodePath.join(directory, "userdata"));
await NodeFSP.writeFile(
  NodePath.join(directory, "userdata", "environment-id"),
  data.environmentIds[role],
);
console.log(JSON.stringify({ home: directory, role, environmentId: data.environmentIds[role] }));
