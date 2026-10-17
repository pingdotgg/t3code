// @effect-diagnostics nodeBuiltinImport:off - workspace names are pure and do not use injected services.
import * as NodeCrypto from "node:crypto";
const WORKSPACE_NAME_PREFIX = "t3-";
const WORKSPACE_DIGEST_LENGTH = 8;
const WORKSPACE_NAME_PATTERN = new RegExp(
  `^${WORKSPACE_NAME_PREFIX}.+-[0-9a-f]{${WORKSPACE_DIGEST_LENGTH}}$`,
);
function bookmarkDigest(refName: string): string {
  return NodeCrypto.createHash("sha256")
    .update(refName)
    .digest("hex")
    .slice(0, WORKSPACE_DIGEST_LENGTH);
}
/**
 * `t3-<bookmark with "/" → "-">-<8 hex of sha256(bookmark)>`. The digest is not decoration:
 * without it `a/b` and `a-b` both map to `t3-a-b`, the second `jj workspace add` fails on the
 * duplicate name, and `listRefs` attributes one workspace root to two bookmarks.
 */
export function workspaceNameForRef(refName: string): string {
  return `${WORKSPACE_NAME_PREFIX}${refName.replaceAll("/", "-")}-${bookmarkDigest(refName)}`;
}
/** True for any name {@link workspaceNameForRef} could have produced. Never true for `default`. */
export function isT3WorkspaceName(name: string): boolean {
  return WORKSPACE_NAME_PATTERN.test(name);
}
