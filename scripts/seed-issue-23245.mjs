import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Schema from "effect/Schema";

// Usage: node scripts/seed-issue-23245.mjs <worktree>/.t3 R1|R2|R3|R4|empty
// Reset preferences only; create the project/thread and provider setup in the app.
const [directory, row] = process.argv.slice(2);
const fixtures = JSON.parse(
  await NodeFSP.readFile(new URL("./fixtures/issue-23245.json", import.meta.url)),
);
if (!directory || !Object.hasOwn(fixtures, row))
  throw new Error("Expected isolated .t3 path and fixture row");
const base = await NodeFSP.realpath(NodePath.resolve(directory));
if (NodePath.basename(base) !== ".t3" || base === NodePath.join(NodeOS.homedir(), ".t3")) {
  throw new Error("Use a worktree's isolated .t3 directory");
}
const path = NodePath.join(base, "userdata/settings.json");
// Settings may carry the comments and trailing commas the server accepts.
const decodeSettings = Schema.decodeSync(
  fromLenientJson(Schema.Record(Schema.String, Schema.Unknown)),
);
const settings = decodeSettings(
  await NodeFSP.readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "{}";
    throw error;
  }),
);
settings.favorites = fixtures[row];
settings.providerInstances = {
  ...settings.providerInstances,
  opencode: {
    ...settings.providerInstances?.opencode,
    driver: "opencode",
    displayName: "OpenCode",
    enabled: false,
  },
};
await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
const temporary = `${path}.${process.pid}.tmp`;
await NodeFSP.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
await NodeFSP.rename(temporary, path);
console.log(`Seeded ${row}: ${settings.favorites.length} favorites in ${base}`);
