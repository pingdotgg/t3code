// @effect-diagnostics nodeBuiltinImport:off - Owner-only pipe/Unix socket paths for server-owned listeners.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Stay below macOS's 104-byte and Linux's 108-byte sockaddr_un limits, including NUL.
const UNIX_SOCKET_PATH_BYTES = 100;

class PrivateIpcEndpointError extends Schema.TaggedError<PrivateIpcEndpointError>()(
  "PrivateIpcEndpointError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Could not reserve a private IPC endpoint.";
  }
}

/** Reserves a random pipe name, or a socket path inside a fresh 0700 directory removed on release. */
export const acquirePrivateIpcEndpoint = Effect.fn("PrivateIpcEndpoint.acquire")(function* (
  prefix: string,
) {
  const platform = yield* HostProcess.Platform;
  const uid = yield* HostProcess.UserId;
  const owned = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        if (platform === "win32")
          return { endpoint: `\\\\.\\pipe\\${prefix}-${NodeCrypto.randomUUID()}` };
        if (uid === undefined) throw new Error("Missing IPC owner");
        const acquireDirectory = async (candidate: string) => {
          const parent = await NodeFSP.realpath(candidate);
          const stat = await NodeFSP.lstat(parent);
          if (
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            !(
              (stat.uid === uid && (stat.mode & 0o022) === 0) ||
              (stat.uid === 0 && ((stat.mode & 0o022) === 0 || (stat.mode & 0o1000) !== 0))
            )
          )
            throw new Error("Untrusted IPC parent");
          const directory = await NodeFSP.mkdtemp(NodePath.join(parent, `${prefix}-`));
          try {
            await NodeFSP.chmod(directory, 0o700);
            const created = await NodeFSP.lstat(directory);
            if (
              !created.isDirectory() ||
              created.isSymbolicLink() ||
              created.uid !== uid ||
              (created.mode & 0o777) !== 0o700
            )
              throw new Error("Unprotected IPC directory");
            const endpoint = NodePath.join(directory, "s");
            if (Buffer.byteLength(endpoint) > UNIX_SOCKET_PATH_BYTES)
              throw new Error("IPC path too long");
            return { endpoint, directory, created };
          } catch (error) {
            await NodeFSP.rmdir(directory);
            throw error;
          }
        };
        return acquireDirectory(NodeOS.tmpdir()).catch(() => acquireDirectory("/tmp"));
      },
      catch: (cause) => new PrivateIpcEndpointError({ cause }),
    }),
    (owned) =>
      Effect.promise(async () => {
        if (!("directory" in owned)) return;
        // Never recursively remove a replaced directory or another process's files.
        const current = await NodeFSP.lstat(owned.directory).catch(() => undefined);
        if (
          current &&
          current.dev === owned.created.dev &&
          current.ino === owned.created.ino &&
          !current.isSymbolicLink()
        )
          await NodeFSP.rmdir(owned.directory).catch(() => undefined);
      }),
  );
  return owned.endpoint;
});
