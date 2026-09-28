import { describe, expect, it } from "vite-plus/test";

import {
  createPreviewBootstrapKeyPair,
  openPreviewBootstrapPayload,
  sealPreviewBootstrapPayload,
  type PreviewBootstrapCryptoContext,
} from "./previewBootstrapCrypto.ts";

describe("preview bootstrap encryption", () => {
  it("keeps the credential opaque and returns the encrypted session to the selected client", () => {
    const server = createPreviewBootstrapKeyPair();
    const client = createPreviewBootstrapKeyPair();
    const credential = "transient-preview-bootstrap-credential";
    const context: PreviewBootstrapCryptoContext = {
      environmentId: "environment-1",
      origin: "http://127.0.0.1:6270",
      challenge: "challenge-1",
      clientPublicKey: client.publicKey,
      serverPublicKey: server.publicKey,
    };
    const encryptedCredential = sealPreviewBootstrapPayload({
      privateKey: client.privateKey,
      peerPublicKey: server.publicKey,
      context,
      direction: "request",
      plaintext: credential,
    });

    expect(JSON.stringify(encryptedCredential)).not.toContain(credential);
    expect(
      openPreviewBootstrapPayload({
        privateKey: server.privateKey,
        peerPublicKey: client.publicKey,
        context,
        direction: "request",
        encrypted: encryptedCredential,
      }),
    ).toBe(credential);

    const encryptedSession = sealPreviewBootstrapPayload({
      privateKey: server.privateKey,
      peerPublicKey: client.publicKey,
      context,
      direction: "response",
      plaintext: "browser-session-cookie",
    });
    expect(
      openPreviewBootstrapPayload({
        privateKey: client.privateKey,
        peerPublicKey: server.publicKey,
        context,
        direction: "response",
        encrypted: encryptedSession,
      }),
    ).toBe("browser-session-cookie");
  });

  it("rejects ciphertext replayed for another origin or challenge", () => {
    const server = createPreviewBootstrapKeyPair();
    const client = createPreviewBootstrapKeyPair();
    const context: PreviewBootstrapCryptoContext = {
      environmentId: "environment-1",
      origin: "http://127.0.0.1:6270",
      challenge: "challenge-1",
      clientPublicKey: client.publicKey,
      serverPublicKey: server.publicKey,
    };
    const encrypted = sealPreviewBootstrapPayload({
      privateKey: client.privateKey,
      peerPublicKey: server.publicKey,
      context,
      direction: "request",
      plaintext: "credential",
    });

    for (const changed of [
      { ...context, origin: "http://localhost:6270" },
      { ...context, challenge: "challenge-2" },
    ]) {
      expect(() =>
        openPreviewBootstrapPayload({
          privateKey: server.privateKey,
          peerPublicKey: client.publicKey,
          context: changed,
          direction: "request",
          encrypted,
        }),
      ).toThrow();
    }
  });
});
