// @effect-diagnostics nodeBuiltinImport:off -- The renderer reads this id through a synchronous IPC reply, which Effect's async FileSystem cannot serve.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const CLIENT_ID_PATTERN = /^[a-f0-9-]{36}$/;

/** Stable per-install id stored beside, not inside, Chromium storage; null when unreadable. */
export function readOrCreateEditorClientId(userDataPath: string): string | null {
  try {
    const file = NodePath.join(userDataPath, "editor-client-id");
    if (!NodeFS.existsSync(file)) {
      NodeFS.writeFileSync(file, NodeCrypto.randomUUID(), { flag: "wx", mode: 0o600 });
    }
    const id = NodeFS.readFileSync(file, "utf8").trim();
    return CLIENT_ID_PATTERN.test(id) ? id : null;
  } catch {
    return null;
  }
}
