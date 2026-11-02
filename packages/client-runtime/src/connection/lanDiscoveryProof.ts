import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { LanDiscoveryProof, lanDiscoveryProofMessage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const isLanDiscoveryProof = Schema.is(LanDiscoveryProof);

export function parseLanDiscoveryCandidate(candidate: string): URL | null {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  const address = url.hostname;
  const octets = address.split(".").map(Number);
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !/^\d+\.\d+\.\d+\.\d+$/.test(address) ||
    octets.length !== 4 ||
    octets.some((n) => n < 0 || n > 255) ||
    !(
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    )
  )
    return null;
  return url;
}

export async function verifyLanDiscoveryProof(input: {
  readonly token: string;
  readonly nonce: string;
  readonly environmentId: string;
  readonly candidate: string;
  readonly fetchProof: (url: string, init: RequestInit) => Promise<Response>;
  readonly signal?: AbortSignal;
}): Promise<boolean> {
  const parts = input.token.split(".");
  if (
    parts.length !== 2 ||
    !/^[A-Za-z0-9_-]{1,4096}$/.test(parts[0]!) ||
    !/^[A-Za-z0-9_-]{43}$/.test(parts[1]!) ||
    !/^[a-f0-9]{64}$/.test(input.nonce)
  )
    return false;
  const key = Result.getOrUndefined(Base64Url.decode(parts[1]!));
  if (key?.length !== 32) return false;
  const url = parseLanDiscoveryCandidate(input.candidate);
  if (url === null) return false;
  const address = url.hostname;
  const port = Number(url.port || 80);
  try {
    const response = await input.fetchProof(new URL("/api/lan-discovery/proof", url).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: parts[0], nonce: input.nonce }),
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (
      !response.ok ||
      response.redirected ||
      Number(response.headers.get("content-length") ?? "0") > 256
    )
      return false;
    const reader = response.body?.getReader();
    if (!reader) return false;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 256) return false;
        chunks.push(chunk.value);
      }
    } finally {
      void reader.cancel().catch(() => undefined);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const text = new TextDecoder().decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (!isLanDiscoveryProof(parsed)) return false;
    const received = Result.getOrUndefined(Base64Url.decode(parsed.proof));
    if (received?.length !== 32) return false;
    const expected = hmac(
      sha256,
      key,
      new TextEncoder().encode(
        lanDiscoveryProofMessage(input.nonce, input.environmentId, address, port),
      ),
    );
    let difference = 0;
    for (let i = 0; i < expected.length; i++) difference |= expected[i]! ^ received[i]!;
    return difference === 0;
  } catch {
    return false;
  }
}

export function makeLanDiscoveryVerifier(input: {
  readonly randomBytes: (length: number) => Uint8Array;
  readonly fetchProof: (url: string, init: RequestInit) => Promise<Response>;
}) {
  return {
    verify: (challenge: {
      readonly token: string;
      readonly environmentId: string;
      readonly candidate: string;
    }) =>
      Effect.tryPromise({
        try: (signal) => {
          const nonce = [...input.randomBytes(32)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
          return verifyLanDiscoveryProof({
            ...challenge,
            nonce,
            signal,
            fetchProof: input.fetchProof,
          });
        },
        catch: () => false,
      }).pipe(
        Effect.orElseSucceed(() => false),
        Effect.timeoutOrElse({ duration: 2500, orElse: () => Effect.succeed(false) }),
      ),
  };
}
