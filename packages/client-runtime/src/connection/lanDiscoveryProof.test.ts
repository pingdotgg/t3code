// @effect-diagnostics-next-line nodeBuiltinImport:off -- Compare against Node HMAC independently.
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { verifyLanDiscoveryProof } from "./lanDiscoveryProof.ts";

const signature = Buffer.alloc(32, 0x41).toString("base64url");
const token = `cGF5bG9hZA.${signature}`;
const nonce = "ab".repeat(32);
const candidate = "http://192.168.1.23:3000/";
const expectedProof = (environmentId: string, address: string, port: number, challenge = nonce) =>
  NodeCrypto.createHmac("sha256", Buffer.from(signature, "base64url"))
    .update(JSON.stringify(["t3code-lan-proof-v1", challenge, environmentId, address, port]))
    .digest("base64url");

describe("LAN discovery proof", () => {
  it("rejects an oversized streamed response and cancels its reader", async () => {
    let cancelled = false;
    const fetchProof = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(257));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    expect(
      await verifyLanDiscoveryProof({
        token,
        nonce,
        environmentId: "environment",
        candidate,
        fetchProof,
      }),
    ).toBe(false);
    expect(cancelled).toBe(true);
  });

  it("accepts only the endpoint and fresh challenge signed by the paired session", async () => {
    const calls: RequestInit[] = [];
    const fetchProof = async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response(
        JSON.stringify({ proof: expectedProof("environment", "192.168.1.23", 3000) }),
      );
    };
    expect(
      await verifyLanDiscoveryProof({
        token,
        nonce,
        environmentId: "environment",
        candidate,
        fetchProof,
      }),
    ).toBe(true);
    expect(calls[0]).toMatchObject({
      method: "POST",
      redirect: "error",
      credentials: "omit",
      body: JSON.stringify({ payload: "cGF5bG9hZA", nonce }),
    });
    for (const input of [
      { environmentId: "other" },
      { nonce: "cd".repeat(32) },
      { candidate: "http://192.168.1.24:3000/" },
      { candidate: "http://192.168.1.23:3001/" },
    ]) {
      expect(
        await verifyLanDiscoveryProof({
          token,
          nonce,
          environmentId: "environment",
          candidate,
          fetchProof,
          ...input,
        }),
      ).toBe(false);
    }
    expect(
      await verifyLanDiscoveryProof({
        token: "dev-token",
        nonce,
        environmentId: "environment",
        candidate,
        fetchProof,
      }),
    ).toBe(false);
  });
});
