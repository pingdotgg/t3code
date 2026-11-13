// The Conn monorepo root, the one input these tools take from outside the Conn Server:
// `CONN_MONOREPO`, else the checkout this file sits in (native/conn-server/crates/conn-mcp).
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

export const monorepoRoot = NodePath.resolve(
  process.env.CONN_MONOREPO ?? NodePath.join(here, "../../../../.."),
);
