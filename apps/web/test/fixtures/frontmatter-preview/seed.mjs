import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
const destination = NodePath.resolve(process.argv[2] ?? ".");
for (const name of NodeFS.readdirSync(new URL(".", import.meta.url))) {
  if (name.endsWith(".md"))
    NodeFS.copyFileSync(
      NodeURL.fileURLToPath(new URL(name, import.meta.url)),
      NodePath.resolve(destination, name),
    );
}
