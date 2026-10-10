// Counts TODO and FIXME comments for agents. The tool's name, description and input
// schema are declared in t3-plugin.json; the server checks input against that schema
// before this handler runs.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const MARKER = /\b(?:TODO|FIXME)\b/g;
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 1024 * 1024;

export function activate(context) {
  context.proposed.handle("t3.tool.count_todos", async ({ input }, { signal }) => {
    if (!NodePath.isAbsolute(input.directory)) throw new Error("Pass an absolute directory path.");
    const counts = [];
    let scanned = 0;
    let truncated = false;
    const visit = async (directory) => {
      for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
        signal.throwIfAborted();
        if (truncated) return;
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const path = NodePath.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(path);
        } else if (entry.isFile()) {
          if (scanned === MAX_FILES) {
            truncated = true;
            return;
          }
          scanned += 1;
          if ((await NodeFSP.stat(path)).size > MAX_FILE_BYTES) continue;
          const count = (await NodeFSP.readFile(path, "utf8")).match(MARKER)?.length ?? 0;
          if (count > 0) counts.push({ path: NodePath.relative(input.directory, path), count });
        }
      }
    };
    await visit(input.directory);
    counts.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
    return {
      total: counts.reduce((sum, file) => sum + file.count, 0),
      filesScanned: scanned,
      truncated,
      files: counts.slice(0, input.top ?? 10),
    };
  });
}
