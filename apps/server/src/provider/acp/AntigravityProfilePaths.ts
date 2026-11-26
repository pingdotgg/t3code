// @effect-diagnostics nodeBuiltinImport:off -- lstat proves no managed component is a link.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export const ANTIGRAVITY_SHARED_APP_DATA_DIR = "antigravity-acp";
export const ANTIGRAVITY_SESSIONS_DIR = "sessions";
export const ANTIGRAVITY_SESSION_SLOTS_DIR = "session-slots";
export const ANTIGRAVITY_DISPOSABLE_DIR = "disposable";

export const isValidAntigravityNativeId = (value: string): boolean =>
  /^[A-Za-z0-9-]{1,64}$/.test(value);

export const isValidAntigravitySlotId = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/**
 * Proves a native runtime entry is at its literal path below the canonical profile: every
 * component exists with the expected type and none is a link. A link could point at another
 * child's transcript or another session's database under the same profile.
 */
export async function antigravityManagedPath(
  profileRoot: string,
  segments: ReadonlyArray<string>,
  kind: "file" | "directory",
): Promise<{ readonly path: string; readonly info: NodeFS.Stats } | undefined> {
  let current = profileRoot;
  let info: NodeFS.Stats | undefined;
  for (const [index, segment] of segments.entries()) {
    current = NodePath.join(current, segment);
    info = await NodeFSP.lstat(current).catch(() => undefined);
    const expectFile = kind === "file" && index === segments.length - 1;
    if (
      info === undefined ||
      info.isSymbolicLink() ||
      (expectFile ? !info.isFile() : !info.isDirectory())
    ) {
      return undefined;
    }
  }
  if (info === undefined) return undefined;
  return (await NodeFSP.realpath(current).catch(() => undefined)) === current
    ? { path: current, info }
    : undefined;
}

export const antigravityProfileRoot = (profileDirectory: string) =>
  NodeFSP.realpath(profileDirectory).catch(() => undefined);

export async function readAntigravitySessionSlotId(
  profileRoot: string,
  sessionId: string,
): Promise<string | undefined> {
  if (!isValidAntigravityNativeId(sessionId)) return undefined;
  const entry = await antigravityManagedPath(
    profileRoot,
    [ANTIGRAVITY_SESSION_SLOTS_DIR, sessionId],
    "file",
  );
  if (entry === undefined || entry.info.size > 128) return undefined;
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(
      entry.path,
      NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
    );
    const slotId = (await handle.readFile("utf8")).trim();
    if (!isValidAntigravitySlotId(slotId)) return undefined;
    const directory = await antigravityManagedPath(
      profileRoot,
      [ANTIGRAVITY_SESSIONS_DIR, slotId],
      "directory",
    );
    return directory === undefined ? undefined : slotId;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function resolveAntigravitySessionAppDataSegments(
  profileRoot: string,
  sessionId: string,
): Promise<readonly [string] | readonly [string, string]> {
  const slotId = await readAntigravitySessionSlotId(profileRoot, sessionId);
  return slotId !== undefined
    ? [ANTIGRAVITY_SESSIONS_DIR, slotId]
    : [ANTIGRAVITY_SHARED_APP_DATA_DIR];
}
