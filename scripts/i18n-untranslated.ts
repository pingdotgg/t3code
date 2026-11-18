// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a synchronous wrapper around one lint run.
// Counts copy that `t3code/no-untranslated-copy` flags, per directory.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

const ROOTS = ["apps/web/src", "apps/mobile/src", "packages/client-runtime/src"];
const RULE = "no-untranslated-copy";
// Split these one level deeper; they hold most of each app.
const SPLIT = new Set(["apps/web/src/components", "apps/mobile/src/features"]);

const lint = NodeChildProcess.spawnSync("vp", ["lint", "--format=json", ...ROOTS], {
  encoding: "utf8",
  maxBuffer: 512 * 1024 * 1024,
});
const report: { diagnostics: ReadonlyArray<{ code?: string; filename: string }> } = JSON.parse(
  lint.stdout,
);

const bucket = (file: string) => {
  const relative = NodePath.relative(process.cwd(), NodePath.resolve(file)).split(NodePath.sep);
  const depth = SPLIT.has(relative.slice(0, 4).join("/")) ? 5 : 4;
  return relative.length > depth
    ? relative.slice(0, depth).join("/")
    : `${relative.slice(0, -1).join("/")}/*`;
};

const counts = new Map<string, number>();
for (const diagnostic of report.diagnostics) {
  if (!diagnostic.code?.includes(RULE)) continue;
  const key = bucket(diagnostic.filename);
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

const rows = [...counts].toSorted((left, right) => right[1] - left[1]);
const width = Math.max(...rows.map(([key]) => key.length), 5);
for (const [key, count] of rows) console.log(`${String(count).padStart(6)}  ${key.padEnd(width)}`);
for (const root of ROOTS) {
  const total = rows.filter(([key]) => key.startsWith(root)).reduce((sum, [, n]) => sum + n, 0);
  console.log(`${String(total).padStart(6)}  ${root} total`);
}
console.log(`${String(rows.reduce((sum, [, n]) => sum + n, 0)).padStart(6)}  all`);
