import { TailcatAddress, TailcatNodeKey } from "@t3tools/contracts";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { TailcatAddressInvalidError } from "./errors.ts";

/**
 * Offline decoding of a tailcat address so the UI can validate a pasted code
 * and show a key fingerprint before spawning anything. The wire format is
 * `tc` + base64url(CBOR map) with single-character keys:
 *   p = server node public key (32 bytes), k = disco public key (32 bytes),
 *   i = DERP region id, r = embedded DERP regions.
 * Only the fields T3 reads are decoded; everything else is skipped.
 */
export interface DecodedTailcatAddress {
  readonly serverNodeKey: TailcatNodeKey;
  readonly serverDiscoKey: string | null;
  readonly regionId: number | null;
  readonly hasEmbeddedRegions: boolean;
}

const isAddress = Schema.is(TailcatAddress);
const isNodeKey = Schema.is(TailcatNodeKey);

export function isTailcatAddressSyntax(value: string): value is TailcatAddress {
  return isAddress(value.trim());
}

type CborValue =
  | number
  | bigint
  | string
  | Uint8Array
  | boolean
  | null
  | undefined
  | ReadonlyArray<CborValue>
  | ReadonlyMap<CborValue, CborValue>;

class CborReader {
  private offset = 0;
  private readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  private need(count: number): void {
    if (this.offset + count > this.bytes.length) {
      throw new RangeError("truncated CBOR");
    }
  }

  private readUint(size: number): number | bigint {
    this.need(size);
    let value = 0n;
    for (let index = 0; index < size; index += 1) {
      value = (value << 8n) | BigInt(this.bytes[this.offset + index]!);
    }
    this.offset += size;
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
  }

  private readArgument(additional: number): number | bigint {
    if (additional < 24) return additional;
    if (additional === 24) return this.readUint(1);
    if (additional === 25) return this.readUint(2);
    if (additional === 26) return this.readUint(4);
    if (additional === 27) return this.readUint(8);
    throw new RangeError("unsupported CBOR argument");
  }

  private toLength(value: number | bigint): number {
    if (typeof value === "bigint") {
      throw new RangeError("CBOR length too large");
    }
    return value;
  }

  read(): CborValue {
    this.need(1);
    const initial = this.bytes[this.offset]!;
    this.offset += 1;
    const major = initial >> 5;
    const additional = initial & 0x1f;
    switch (major) {
      case 0:
        return this.readArgument(additional);
      case 1: {
        const argument = this.readArgument(additional);
        return typeof argument === "bigint" ? -1n - argument : -1 - argument;
      }
      case 2: {
        const length = this.toLength(this.readArgument(additional));
        this.need(length);
        const slice = this.bytes.slice(this.offset, this.offset + length);
        this.offset += length;
        return slice;
      }
      case 3: {
        const length = this.toLength(this.readArgument(additional));
        this.need(length);
        const text = new TextDecoder().decode(
          this.bytes.subarray(this.offset, this.offset + length),
        );
        this.offset += length;
        return text;
      }
      case 4: {
        const length = this.toLength(this.readArgument(additional));
        const items: Array<CborValue> = [];
        for (let index = 0; index < length; index += 1) {
          items.push(this.read());
        }
        return items;
      }
      case 5: {
        const length = this.toLength(this.readArgument(additional));
        const map = new Map<CborValue, CborValue>();
        for (let index = 0; index < length; index += 1) {
          const key = this.read();
          const value = this.read();
          map.set(key, value);
        }
        return map;
      }
      case 6: {
        // Tags are transparent for this decoder.
        this.readArgument(additional);
        return this.read();
      }
      case 7:
        switch (additional) {
          case 20:
            return false;
          case 21:
            return true;
          case 22:
            return null;
          case 23:
            return undefined;
          default:
            throw new RangeError("unsupported CBOR simple value");
        }
      default:
        throw new RangeError("unsupported CBOR major type");
    }
  }

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }
}

function invalid(detail: string): TailcatAddressInvalidError {
  return new TailcatAddressInvalidError({ detail });
}

export function decodeTailcatAddress(
  raw: string,
): Result.Result<DecodedTailcatAddress, TailcatAddressInvalidError> {
  const value = raw.trim();
  if (!isTailcatAddressSyntax(value)) {
    return Result.fail(
      invalid(
        "This is not a tailcat address. It should start with tc followed by letters and digits.",
      ),
    );
  }
  const decodedBytes = Encoding.decodeBase64Url(value.slice(2));
  if (Result.isFailure(decodedBytes)) {
    return Result.fail(invalid("The tailcat address is not valid base64url text."));
  }
  let map: CborValue;
  try {
    const reader = new CborReader(decodedBytes.success);
    map = reader.read();
    if (!reader.done) {
      return Result.fail(invalid("The tailcat address has trailing data."));
    }
  } catch (cause) {
    return Result.fail(
      invalid(
        `The tailcat address is damaged: ${cause instanceof Error ? cause.message : "bad CBOR"}.`,
      ),
    );
  }
  if (!(map instanceof Map)) {
    return Result.fail(invalid("The tailcat address does not contain connection info."));
  }
  const serverPublic = map.get("p");
  if (!(serverPublic instanceof Uint8Array) || serverPublic.length !== 32) {
    return Result.fail(invalid("The tailcat address is missing the server key."));
  }
  const disco = map.get("k");
  const regionId = map.get("i");
  const regions = map.get("r");
  return Result.succeed({
    serverNodeKey: `nodekey:${Encoding.encodeHex(serverPublic)}` as TailcatNodeKey,
    serverDiscoKey:
      disco instanceof Uint8Array && disco.length === 32
        ? `discokey:${Encoding.encodeHex(disco)}`
        : null,
    regionId: typeof regionId === "number" ? regionId : null,
    hasEmbeddedRegions: Array.isArray(regions) && regions.length > 0,
  });
}

/** Short human-readable identity for a node key, for diagnostics and peer lists. */

export function isTailcatNodeKey(value: string): value is TailcatNodeKey {
  return isNodeKey(value.trim());
}
