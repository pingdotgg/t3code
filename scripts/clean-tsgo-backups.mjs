// Deletes stale tsgo backup files left behind by `effect-tsgo patch`.
//
// The patch command backs up the real tsgo binary to `tsgo.original`, and if
// that name is taken it writes `tsgo.original.1`, `.2`, ... without ever
// cleaning up. On runners that restore node_modules from a build cache
// (Vercel), backups accumulate across deploys until patch hard-fails at 101
// with "Too many backup files exist". Removing them is safe: from the second
// patch onward the backup is just the previously-patched binary, and pnpm
// restores the pristine one whenever the package is re-materialized.
//
// Runs as part of `prepare`, so it must only use node builtins.
import * as NodeFS from "node:fs";

const backups = NodeFS.globSync(
  "node_modules/.pnpm/@typescript+native-preview-*/node_modules/@typescript/native-preview-*/lib/tsgo{,.exe}.original*",
);

for (const backup of backups) {
  NodeFS.rmSync(backup, { force: true });
}

if (backups.length > 0) {
  console.log(`Removed ${backups.length} stale tsgo backup(s)`);
}
