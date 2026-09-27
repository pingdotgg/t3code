// @effect-diagnostics nodeBuiltinImport:off - native adapter loads a packaged dylib and translates its byte responses.
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import { decode, decodeFirst } from "cborg";
import type { normalizePasskeyRequest } from "./PasskeyRequest.ts";

export type NativePasskeyRequest = ReturnType<typeof normalizePasskeyRequest>;
export type PasskeyResult =
  | { error: string }
  | {
      id: string;
      authenticatorAttachment: string;
      response: Record<string, string | number | null>;
      clientExtensionResults?: { credProps: { rk: boolean } };
    };
export type NativePasskeys = {
  available: () => boolean;
  start: (
    options: NativePasskeyRequest,
    window: Buffer,
    signal: AbortSignal,
  ) => Promise<PasskeyResult>;
};

/** Convert Apple's attestation to the WebAuthn response accessors, including SPKI public-key bytes. */
export function decodePasskeyResult(
  json: string,
  options: Pick<NativePasskeyRequest, "operation" | "credProps">,
): PasskeyResult {
  const result = JSON.parse(json) as PasskeyResult;
  if (!("error" in result) && options.operation === "create") {
    const attestation = decode(
      Buffer.from(String(result.response.attestationObject), "base64url"),
      { useMaps: true },
    ) as Map<string, Uint8Array>;
    const authData = Buffer.from(attestation.get("authData")!);
    const credentialLength = authData.readUInt16BE(53);
    // Authenticator extensions can follow the COSE key in authenticatorData.
    const [cose] = decodeFirst(authData.subarray(55 + credentialLength), { useMaps: true }) as [
      Map<number, Uint8Array | number>,
      Uint8Array,
    ];
    if (cose.get(3) !== -7) throw new Error("Unexpected platform credential algorithm.");
    const publicKey = NodeCrypto.createPublicKey({
      format: "jwk",
      key: {
        kty: "EC",
        crv: "P-256",
        x: Buffer.from(cose.get(-2) as Uint8Array).toString("base64url"),
        y: Buffer.from(cose.get(-3) as Uint8Array).toString("base64url"),
      },
    }).export({ format: "der", type: "spki" });
    result.response.authenticatorData = authData.toString("base64url");
    result.response.publicKey = publicKey.toString("base64url");
    result.response.publicKeyAlgorithm = -7;
    if (options.credProps) result.clientExtensionResults = { credProps: { rk: true } };
  }
  return result;
}

let native: Promise<NativePasskeys | undefined> | undefined;
let nextId = 0;
/** Load once, only when a preview asks for passkeys. A stock unsigned Electron stays on Chromium's path. */
export function loadNativePasskeys(paths: readonly string[]) {
  native ??= (async () => {
    const path = paths.find(NodeFS.existsSync);
    if (!path) return undefined;
    const ffi = await import("ffi-rs");
    const { DataType: T } = ffi;
    const library = "t3-preview-passkeys";
    ffi.open({ library, path });
    const callbackType = ffi.funcConstructor({ paramsType: [T.String], retType: T.Void });
    const command = (funcName: string, id: number) =>
      ffi.load({
        library,
        funcName,
        retType: T.Void,
        paramsType: [T.I32],
        paramsValue: [id],
      });
    return {
      available: () =>
        Boolean(
          ffi.load({
            library,
            funcName: "t3_passkeys_available",
            retType: T.Boolean,
            paramsType: [],
            paramsValue: [],
          }),
        ),
      start: (options, window, signal) =>
        new Promise<PasskeyResult>((resolve, reject) => {
          if (signal.aborted) {
            resolve({ error: "AbortError" });
            return;
          }
          const id = ++nextId;
          const cancel = () => command("t3_passkeys_cancel", id);
          const pointer = ffi.createPointer({
            paramsType: [callbackType],
            paramsValue: [
              (json: string) => {
                signal.removeEventListener("abort", cancel);
                try {
                  resolve(decodePasskeyResult(json, options));
                } catch (error) {
                  reject(error);
                } finally {
                  command("t3_passkeys_release", id);
                  ffi.freePointer({
                    paramsType: [callbackType],
                    paramsValue: pointer,
                    pointerType: ffi.PointerType.RsPointer,
                  });
                }
              },
            ],
          });
          try {
            ffi.load({
              library,
              funcName: "t3_passkeys_start",
              retType: T.Void,
              paramsType: [T.I32, T.BigInt, T.String, T.External],
              paramsValue: [
                id,
                window.readBigUInt64LE(),
                JSON.stringify(options),
                ...ffi.unwrapPointer(pointer),
              ],
            });
            signal.addEventListener("abort", cancel, { once: true });
          } catch (error) {
            ffi.freePointer({
              paramsType: [callbackType],
              paramsValue: pointer,
              pointerType: ffi.PointerType.RsPointer,
            });
            reject(error);
          }
        }),
    } satisfies NativePasskeys;
  })();
  return native;
}
