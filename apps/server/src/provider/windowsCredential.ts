import * as NodeModule from "node:module";

// A single-executable server resolves packages on disk only through `require`.
const requireForFfi = NodeModule.createRequire(import.meta.url);

const CRED_TYPE_GENERIC = 1;
const ERROR_NOT_FOUND = 1168;
// x64 and arm64 CREDENTIALW: CredentialBlobSize is a DWORD at 32, CredentialBlob a pointer at 40.
const CREDENTIAL_SIZE = 48;

/**
 * Reads a generic Credential Manager entry's raw blob, or `undefined` when it does not exist.
 * Read-only: @napi-rs/keyring's `withTarget` writes an empty secret before it reads.
 */
export function readWindowsGenericCredential(
  target: string,
  architecture: string,
): Uint8Array | undefined {
  if (architecture !== "x64" && architecture !== "arm64") {
    throw new Error(`no credential access on ${architecture}`);
  }
  const { DataType, load, open } = requireForFfi("ffi-rs") as typeof import("ffi-rs");
  open({ library: "t3-advapi32", path: "advapi32.dll" });
  open({ library: "t3-kernel32", path: "kernel32.dll" });
  const copy = (into: Buffer, from: bigint) =>
    load({
      library: "t3-kernel32",
      funcName: "RtlMoveMemory",
      retType: DataType.Void,
      paramsType: [DataType.U8Array, DataType.BigInt, DataType.BigInt],
      paramsValue: [into, from, BigInt(into.length)],
    });

  const out = Buffer.alloc(8);
  const read = load({
    library: "t3-advapi32",
    funcName: "CredReadW",
    retType: DataType.I32,
    paramsType: [DataType.WString, DataType.U32, DataType.U32, DataType.U8Array],
    paramsValue: [target, CRED_TYPE_GENERIC, 0, out],
    errno: true as const,
  });
  if (read.value === 0) {
    if (read.errnoCode === ERROR_NOT_FOUND) return undefined;
    throw new Error(`CredReadW failed: Windows error ${read.errnoCode}`);
  }
  const credential = out.readBigUInt64LE();
  try {
    const header = Buffer.alloc(CREDENTIAL_SIZE);
    copy(header, credential);
    const size = header.readUInt32LE(32);
    if (size === 0) return undefined;
    const blob = Buffer.alloc(size);
    copy(blob, header.readBigUInt64LE(40));
    return blob;
  } finally {
    load({
      library: "t3-advapi32",
      funcName: "CredFree",
      retType: DataType.Void,
      paramsType: [DataType.BigInt],
      paramsValue: [credential],
    });
  }
}
