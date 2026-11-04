// @effect-diagnostics nodeBuiltinImport:off - Pack inspection is synchronous and independent of the server runtime.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { readManifest } from "./files.ts";

export { parsePstackRoleDefaults, PSTACK_PANEL_ROLES, type PstackRoleDefault } from "./roles.ts";

export const PSTACK_SKILL_PREFIX = "pstack:";
export const PSTACK_LAYOUT_VERSION = 3;

/** Upstream test corpus that packaged desktop builds delete; the runtime pack never needs it. */
export const PSTACK_PACKAGED_PRUNED_DIR = "skills/statechart/scripts/test";

const isRuntimePackFile = (packPath: string) =>
  NodePath.posix.basename(packPath) !== ".gitignore" &&
  !packPath.startsWith(`${PSTACK_PACKAGED_PRUNED_DIR}/`);

/** Files relative to a source root containing upstream/ and UPSTREAM.json. */
export function pstackPackEntries(sourceRoot: string): ReadonlyArray<{
  readonly packPath: string;
  readonly sourcePath: string;
  readonly executable: boolean;
}> {
  const root = NodePath.resolve(sourceRoot);
  return [
    ...Object.entries(readManifest(root).files)
      .filter(([packPath]) => isRuntimePackFile(packPath))
      .map(([packPath, { executable }]) => ({
        packPath,
        sourcePath: NodePath.join(root, "upstream", packPath),
        executable,
      })),
    {
      packPath: "UPSTREAM.json",
      sourcePath: NodePath.join(root, "UPSTREAM.json"),
      executable: false,
    },
  ];
}

export function pstackContentHash(
  sourceRoot: string,
  layoutVersion = PSTACK_LAYOUT_VERSION,
): string {
  return NodeCrypto.createHash("sha256")
    .update(`${layoutVersion}:`)
    .update(readManifest(sourceRoot).subtreeHash)
    .digest("hex")
    .slice(0, 16);
}
