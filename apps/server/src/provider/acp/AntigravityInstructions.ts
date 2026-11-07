// Nonblocking descriptor reads prevent special files from hanging session startup.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

const INSTRUCTION_MAX_BYTES = 256 * 1024;

export const readAntigravityInstructions = Effect.fn("AntigravityInstructions.read")(
  (filePath: string) =>
    Effect.tryPromise({
      try: async () => {
        try {
          const info = await NodeFSP.stat(filePath);
          if (!info.isFile() || info.size > INSTRUCTION_MAX_BYTES) {
            throw new Error("Instructions must be a regular file of at most 256 KiB.");
          }
          // Nonblocking open and descriptor validation also cover replacement by a FIFO after stat.
          const file = await NodeFSP.open(
            filePath,
            NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK,
          );
          try {
            const opened = await file.stat();
            if (!opened.isFile() || opened.size > INSTRUCTION_MAX_BYTES) {
              throw new Error("Instructions must be a regular file of at most 256 KiB.");
            }
            const buffer = Buffer.alloc(INSTRUCTION_MAX_BYTES + 1);
            let size = 0;
            while (size < buffer.length) {
              const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
              if (bytesRead === 0) break;
              size += bytesRead;
            }
            if (size > INSTRUCTION_MAX_BYTES) {
              throw new Error("Instructions exceed 256 KiB.");
            }
            return buffer.toString("utf8", 0, size);
          } finally {
            await file.close();
          }
        } catch (cause) {
          if (
            typeof cause === "object" &&
            cause !== null &&
            "code" in cause &&
            cause.code === "ENOENT"
          )
            return undefined;
          throw cause;
        }
      },
      catch: (cause) =>
        new EffectAcpErrors.AcpTransportError({
          detail: `Could not read Antigravity instructions at '${filePath}' (regular files up to 256 KiB only).`,
          cause,
        }),
    }),
);
