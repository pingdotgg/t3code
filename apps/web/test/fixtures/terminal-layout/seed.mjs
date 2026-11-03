import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// Run with the isolated server stopped: node seed.mjs <T3-home> <project-id>.
// The app creates projects/drafts normally; this adds only the named script.
const [home, projectId] = process.argv.slice(2);
if (!home || !projectId) throw new Error("Usage: node seed.mjs <isolated-T3-home> <project-id>");
const resolvedHome = await NodeFSP.realpath(home);
const liveHome = await NodeFSP.realpath(NodePath.join(NodeOS.homedir(), ".t3"));
if (resolvedHome === liveHome || resolvedHome.startsWith(liveHome + NodePath.sep)) {
  throw new Error("Refusing to write live T3 state");
}
const target = NodePath.join(resolvedHome, "userdata/settings.json");
const settings = JSON.parse(
  await NodeFSP.readFile(target, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "{}";
    throw error;
  }),
);
const shellPath = NodeURL.fileURLToPath(new URL("./shell.sh", import.meta.url));
const script = {
  id: "evidence-deterministic-t",
  name: "Evidence deterministic terminal with deliberately long label",
  command: `bash '${shellPath.replaceAll("'", "'\\''")}' G`,
  icon: "play",
  runOnWorktreeCreate: false,
};
settings.projectScriptOverrides ??= {};
const previous = settings.projectScriptOverrides[projectId] ?? [];
settings.projectScriptOverrides[projectId] = [
  ...previous.filter((item) => item.id !== script.id),
  script,
];
await NodeFSP.writeFile(target, JSON.stringify(settings, null, 2) + "\n");
