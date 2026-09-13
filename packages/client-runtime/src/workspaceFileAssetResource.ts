import type { AssetResource } from "@t3tools/contracts";
import { mediaFileReference } from "./mediaReference.ts";

/** File panels carry their source checkout independently of their resource owner. */
export function workspaceFileAssetResource(input: {
  readonly cwd: string | null | undefined;
  readonly path: string | null | undefined;
}): Extract<AssetResource, { readonly _tag: "draft-workspace-file" }> | null {
  if (!input.cwd || !input.path) return null;
  return {
    _tag: "draft-workspace-file",
    cwd: input.cwd,
    // Relative HTML paths permit sibling assets; outside files stay exact-file grants.
    path: mediaFileReference(input.path, input.cwd).relativePath ?? input.path,
  };
}
