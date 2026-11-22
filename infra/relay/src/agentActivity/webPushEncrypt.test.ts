import { describe, expect, it } from "@effect/vitest";

import { encryptWebPush, fromBase64Url } from "./webPushEncrypt.ts";

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

// RFC 8291 section 5 example subscription and sender key.
const receiver = {
  p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  private: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
};

const importPrivate = async (privateKey: string, publicKey: string) => {
  const point = fromBase64Url(publicKey);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: privateKey,
    x: toBase64Url(point.slice(1, 33)),
    y: toBase64Url(point.slice(33, 65)),
  };
  return {
    privateKey: await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    ),
    publicKey: await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
      { name: "ECDH", namedCurve: "P-256" },
      true,
      [],
    ),
  };
};

describe("encryptWebPush", () => {
  it("matches the RFC 8291 example", async () => {
    const body = await encryptWebPush({
      plaintext: new TextEncoder().encode("When I grow up, I want to be a watermelon"),
      p256dh: receiver.p256dh,
      auth: receiver.auth,
      ephemeral: await importPrivate(
        "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
        "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
      ),
      salt: fromBase64Url("DGv6ra1nlYgDCS1FRnbzlw"),
    });
    expect(toBase64Url(body)).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("rejects a message that cannot fit in one record", async () => {
    await expect(
      encryptWebPush({
        plaintext: new Uint8Array(4096),
        p256dh: receiver.p256dh,
        auth: receiver.auth,
      }),
    ).rejects.toThrow("Message too large");
  });
});
