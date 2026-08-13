import { describe, expect, it } from "vite-plus/test";

import {
  buildPairingUrl,
  extractPairingUrlFromQrPayload,
  PairingQrPayloadEmptyError,
  parsePairingFields,
  parsePairingUrl,
} from "./pairing";

describe("buildPairingUrl", () => {
  it("uses HTTP for a schemeless IP address", () => {
    expect(buildPairingUrl("192.168.1.100:3773", "pairing-token")).toBe(
      "http://192.168.1.100:3773/#token=pairing-token",
    );
  });

  it("keeps HTTPS as the default for a schemeless hostname", () => {
    expect(buildPairingUrl("remote.example.com", "pairing-token")).toBe(
      "https://remote.example.com/#token=pairing-token",
    );
  });

  it("preserves an explicit scheme for an IP address", () => {
    expect(buildPairingUrl("https://192.168.1.100:3773", "pairing-token")).toBe(
      "https://192.168.1.100:3773/#token=pairing-token",
    );
  });

  it("treats a protocol-relative hostname as HTTPS", () => {
    expect(buildPairingUrl("//remote.example.com", "pairing-token")).toBe(
      "https://remote.example.com/#token=pairing-token",
    );
  });
});

describe("parsePairingFields", () => {
  it("extracts an embedded pairing token when the host field is committed", () => {
    expect(
      parsePairingFields("http://remote.example.com/pair#token=embedded-token", "old-code"),
    ).toEqual({
      host: "http://remote.example.com",
      code: "embedded-token",
    });
  });

  it("preserves separately entered host and code values", () => {
    expect(parsePairingFields("remote.example.com", "manual-code")).toEqual({
      host: "remote.example.com",
      code: "manual-code",
    });
  });
});

describe("extractPairingUrlFromQrPayload", () => {
  it("trims raw pairing urls from qr payloads", () => {
    expect(
      extractPairingUrlFromQrPayload("  https://remote.example.com/pair#token=pairing-token  "),
    ).toBe("https://remote.example.com/pair#token=pairing-token");
  });

  it("unwraps mobile deep links that carry an encoded pairing url", () => {
    expect(
      extractPairingUrlFromQrPayload(
        "t3code://pair?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3Dpairing-token",
      ),
    ).toBe("https://remote.example.com/pair#token=pairing-token");
  });

  it("rejects empty qr payloads", () => {
    expect(() => extractPairingUrlFromQrPayload("   ")).toThrowError(PairingQrPayloadEmptyError);
    expect(() => extractPairingUrlFromQrPayload("   ")).toThrowError(
      "Scanned QR code did not contain a pairing URL.",
    );
  });
});

describe("parsePairingUrl", () => {
  it("reads a direct pairing link into backend host fields", () => {
    expect(parsePairingUrl("http://remote.example.com/pair#token=pairing-token")).toEqual({
      host: "http://remote.example.com",
      code: "pairing-token",
    });
  });

  it("reads a schemeless local pairing link into backend host fields", () => {
    expect(parsePairingUrl("192.168.1.100:3773/#token=pairing-token")).toEqual({
      host: "http://192.168.1.100:3773",
      code: "pairing-token",
    });
  });

  it("reads a protocol-relative pairing link into backend host fields", () => {
    expect(parsePairingUrl("//remote.example.com/pair#token=pairing-token")).toEqual({
      host: "https://remote.example.com",
      code: "pairing-token",
    });
  });

  it("reads hosted pairing links into backend host fields", () => {
    expect(
      parsePairingUrl(
        "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%2F#token=pairing-token",
      ),
    ).toEqual({
      host: "https://desktop.tailnet.ts.net",
      code: "pairing-token",
    });
  });

  it("preserves protocol-relative hosts from hosted pairing links", () => {
    expect(
      parsePairingUrl(
        "https://app.t3.codes/pair?host=%2F%2Fdesktop.tailnet.ts.net%2F#token=pairing-token",
      ),
    ).toEqual({
      host: "//desktop.tailnet.ts.net",
      code: "pairing-token",
    });
  });
});
