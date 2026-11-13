// @effect-diagnostics nodeBuiltinImport:off -- Extracts the standalone worker for execution by managed Node.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSea from "node:sea";
import * as NodeURL from "node:url";

export async function extensionHostEntry(directory: string): Promise<string> {
  const source = new URL(
    import.meta.url.endsWith(".ts") ? "./hostMain.ts" : "./hostMain.mjs",
    import.meta.url,
  );
  if (!NodeSea.isSea() && source.pathname.endsWith(".ts")) return NodeURL.fileURLToPath(source);
  const code = NodeSea.isSea()
    ? Buffer.from(NodeSea.getAsset("extension-host.mjs"))
    : await NodeFSP.readFile(source);
  const digest = NodeCrypto.createHash("sha256").update(code).digest("hex");
  const target = NodePath.join(directory, `${digest}.mjs`);
  await NodeFSP.mkdir(directory, { recursive: true });
  const current = await NodeFSP.readFile(target).catch((cause: unknown) => {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")
      return undefined;
    throw cause;
  });
  if (!current?.equals(code)) {
    const temporary = `${target}.${NodeCrypto.randomUUID()}.tmp`;
    try {
      await NodeFSP.writeFile(temporary, code, { mode: 0o600 });
      await NodeFSP.rename(temporary, target);
    } finally {
      await NodeFSP.rm(temporary, { force: true });
    }
  }
  return target;
}
