import { expect, it } from "vite-plus/test";

import { verifyGitHubSignature } from "./signature.ts";

it("accepts a valid sha256 github webhook signature", async () => {
  const body = new TextEncoder().encode('{"zen":"keep it logically awesome"}');
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("webhook-secret"),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, body.buffer as ArrayBuffer));
  const signature = `sha256=${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  )}`;

  await expect(
    verifyGitHubSignature(body.buffer as ArrayBuffer, signature, "webhook-secret"),
  ).resolves.toBe(true);
});
