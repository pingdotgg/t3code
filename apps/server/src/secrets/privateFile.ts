// @effect-diagnostics nodeBuiltinImport:off -- Native open flags and handle stat enforce private regular-file input.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { SecretDeliveryError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";

const MAX_BYTES = 65536;
const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = NodeFS.constants;
// Windows builds of Node export no O_NOFOLLOW. There, libuv's UV_FS_O_EXLOCK (uv/win.h) opens
// with share mode 0, so no other process can open, write, rename or replace the file meanwhile.
const WINDOWS_EXCLUSIVE_LOCK = 0x10000000;
const OPEN_FLAGS =
  O_NOFOLLOW === undefined ? O_RDONLY | WINDOWS_EXCLUSIVE_LOCK : O_RDONLY | O_NOFOLLOW | O_NONBLOCK;

// SYSTEM and Administrators can read every file; OpenSSH for Windows trusts the same set on
// private keys. An elevated user's new files are owned by Administrators.
const WINDOWS_TRUSTED_SIDS = ["S-1-5-18", "S-1-5-32-544"];
const decodeWindowsSecurity = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      user: Schema.String,
      owner: Schema.String,
      dacl: Schema.NullOr(
        Schema.Array(Schema.Struct({ type: Schema.String, sid: Schema.NullOr(Schema.String) })),
      ),
    }),
  ),
);
// Windows PowerShell 5.1 ships with Windows. The raw DACL lists every ACE, even types .NET access
// rules skip; a null DACL grants everyone. Assigning `@()` directly keeps one ACE an array.
const WINDOWS_SECURITY_QUERY = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "$sd = New-Object System.Security.AccessControl.RawSecurityDescriptor -ArgumentList (Get-Acl -LiteralPath $env:T3_PRIVATE_FILE).GetSecurityDescriptorBinaryForm(), 0",
  "$dacl = $null",
  "if ($null -ne $sd.DiscretionaryAcl) { $dacl = @($sd.DiscretionaryAcl | ForEach-Object { @{ type = [string]$_.AceType; sid = $_.SecurityIdentifier.Value } }) }",
  "ConvertTo-Json -Compress -InputObject @{ user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; owner = $sd.Owner.Value; dacl = $dacl }",
].join("; ");

const invalidFile = () => new SecretDeliveryError({ reason: "invalid_file" });
const attempt = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: invalidFile });

/**
 * Reads a sent file as exact UTF-8: absolute, canonical, link-free, singly linked, at most 64 KiB,
 * unchanged during the read, and private: owner uid and mode on POSIX; on Windows, owner and allow
 * ACEs limited to the server user, SYSTEM and Administrators.
 */
export const makeReader = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const uid = yield* HostProcess.UserId;
  const runner = yield* ProcessRunner.ProcessRunner;

  const isWindowsPrivate = Effect.fn("PrivateFile.isWindowsPrivate")(function* (path: string) {
    const result = yield* runner.run({
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SECURITY_QUERY],
      env: { T3_PRIVATE_FILE: path },
      timeout: "30 seconds",
      maxOutputBytes: MAX_BYTES,
    });
    if (result.code !== 0) return false;
    const { user, owner, dacl } = yield* decodeWindowsSecurity(result.stdout.trim());
    const trusted = new Set([user, ...WINDOWS_TRUSTED_SIDS]);
    return (
      trusted.has(owner) &&
      dacl !== null &&
      dacl.every(
        (ace) => ace.type.startsWith("AccessDenied") || (ace.sid !== null && trusted.has(ace.sid)),
      )
    );
  });

  return Effect.fn("PrivateFile.read")(function* (filePath: string) {
    const path = NodePath.resolve(filePath);
    if (!NodePath.isAbsolute(filePath) || (yield* attempt(() => NodeFSP.realpath(path))) !== path)
      return yield* invalidFile();
    return yield* Effect.acquireUseRelease(
      attempt(() => NodeFSP.open(path, OPEN_FLAGS)),
      Effect.fnUntraced(function* (file) {
        const before = yield* attempt(() => file.stat());
        if (
          !before.isFile() ||
          before.nlink !== 1 ||
          before.size === 0 ||
          before.size > MAX_BYTES ||
          !(platform === "win32"
            ? yield* isWindowsPrivate(path)
            : before.uid === uid && (before.mode & 0o077) === 0)
        )
          return yield* invalidFile();
        // One spare byte detects a file that grew past the cap after the stat.
        const bytes = Buffer.alloc(MAX_BYTES + 1);
        let size = 0;
        while (size < bytes.length) {
          const { bytesRead } = yield* attempt(() =>
            file.read(bytes, size, bytes.length - size, null),
          );
          if (bytesRead === 0) break;
          size += bytesRead;
        }
        const after = yield* attempt(() => file.stat());
        const linked = yield* attempt(() => NodeFSP.lstat(path));
        if (
          size > MAX_BYTES ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs ||
          linked.ino !== before.ino ||
          linked.dev !== before.dev ||
          (yield* attempt(() => NodeFSP.realpath(path))) !== path
        )
          return yield* invalidFile();
        return yield* Effect.try({
          try: () =>
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
              bytes.subarray(0, size),
            ),
          catch: invalidFile,
        });
      }),
      (file) => Effect.promise(() => file.close().catch(() => undefined)),
    );
  }, Effect.mapError(invalidFile));
});
