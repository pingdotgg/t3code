// @effect-diagnostics nodeBuiltinImport:off - lean self-invoked private IPC client.
import * as NodeNet from "node:net";

export const codexManagedTokenCommandName = "__managed-chatgpt-token";

const REQUEST = "token\n";
const MAX_ENDPOINT_BYTES = 2048;
const MAX_TOKEN_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 80_000;

const readToken = (endpoint: string) =>
  new Promise<string>((resolve, reject) => {
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      reject(new Error("managed Codex credential transport failed"));
    };
    if (
      endpoint.length === 0 ||
      Buffer.byteLength(endpoint) > MAX_ENDPOINT_BYTES ||
      endpoint.includes("\0")
    ) {
      fail();
      return;
    }

    const socket = NodeNet.createConnection(endpoint);
    const chunks: Buffer[] = [];
    let bytes = 0;
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => {
      socket.destroy();
      fail();
    });
    socket.once("connect", () => socket.write(REQUEST));
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_TOKEN_BYTES) {
        socket.destroy();
        fail();
        return;
      }
      chunks.push(chunk);
    });
    socket.once("end", () => {
      if (settled) return;
      const token = Buffer.concat(chunks).toString("utf8").trim();
      if (token.length === 0) {
        fail();
        return;
      }
      settled = true;
      resolve(token);
    });
    socket.once("error", fail);
  });

export async function runCodexManagedTokenCommand(args: ReadonlyArray<string>): Promise<void> {
  try {
    if (args.length !== 1) throw new Error("invalid managed Codex credential arguments");
    const token = await readToken(args[0]!);
    process.stdout.write(token);
  } catch {
    process.stderr.write("Could not renew managed Codex credentials.\n");
    process.exitCode = 1;
  }
}
