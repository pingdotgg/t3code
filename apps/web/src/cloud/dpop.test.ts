import { verifyDpopProof } from "@t3tools/shared/dpop";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";

import { browserCryptoLayer, createBrowserDpopProof, generateBrowserDpopKey } from "./dpop";

describe("browser DPoP proofs", () => {
  it("signs relay resource proofs with an access-token hash", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const issuedAt = Math.floor(Date.now() / 1_000);
    const proofKey = await Effect.runPromise(generateBrowserDpopKey);
    const proof = await Effect.runPromise(
      createBrowserDpopProof({
        method: "POST",
        url: "https://relay.example.test/v1/environments/env-1/connect?ignored=true",
        accessToken: "relay-access-token",
        proofKey,
      }).pipe(Effect.provide(browserCryptoLayer)),
    );

    expect(
      verifyDpopProof({
        proof: proof.proof,
        method: "POST",
        url: "https://relay.example.test/v1/environments/env-1/connect",
        expectedThumbprint: proof.thumbprint,
        expectedAccessToken: "relay-access-token",
        nowEpochSeconds: issuedAt,
      }),
    ).toMatchObject({ ok: true });
  });
});
