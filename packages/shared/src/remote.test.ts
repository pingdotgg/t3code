import { describe, expect, it } from "vite-plus/test";

import {
  buildP2pPairingUrl,
  isP2pPairingUrl,
  parseP2pPairingUrl,
  RemoteBackendUrlInvalidError,
  RemoteBackendUrlMissingError,
  RemotePairingTokenMissingError,
  RemotePairingUrlInvalidError,
  resolveRemotePairingTarget,
} from "./remote.ts";

const P2P_KEY = "qrqydpuhgpq7zhwyrjk8x9pxffi44wpzxxos7rpxgiakyuf8q99o";

describe("p2p pairing urls", () => {
  it("round-trips a p2p pairing url with a bootstrap list", () => {
    const url = buildP2pPairingUrl({
      publicKeyZ32: P2P_KEY,
      credential: "pairing-token",
      bootstrap: ["10.0.0.1:49737", "10.0.0.2:49737"],
    });
    expect(isP2pPairingUrl(url)).toBe(true);
    expect(parseP2pPairingUrl(url)).toEqual({
      credential: "pairing-token",
      publicKeyZ32: P2P_KEY,
      bootstrap: ["10.0.0.1:49737", "10.0.0.2:49737"],
    });
  });

  it("round-trips a p2p pairing url without bootstrap nodes", () => {
    const url = buildP2pPairingUrl({ publicKeyZ32: P2P_KEY, credential: "pairing-token" });
    expect(parseP2pPairingUrl(url)).toEqual({
      credential: "pairing-token",
      publicKeyZ32: P2P_KEY,
      bootstrap: [],
    });
  });

  it("returns null for non-p2p inputs so callers fall through", () => {
    expect(parseP2pPairingUrl("https://remote.example.com/pair#token=x")).toBeNull();
    expect(parseP2pPairingUrl("not a url")).toBeNull();
  });

  it("rejects a malformed p2p key", () => {
    expect(() => parseP2pPairingUrl("t3+p2p://short-key/#token=x")).toThrow(
      RemotePairingUrlInvalidError,
    );
    expect(() => parseP2pPairingUrl(`t3+p2p://${"0".repeat(52)}/#token=x`)).toThrow(
      RemotePairingUrlInvalidError,
    );
  });

  it("rejects a p2p pairing url without a token", () => {
    expect(() => parseP2pPairingUrl(`t3+p2p://${P2P_KEY}/`)).toThrow(
      RemotePairingTokenMissingError,
    );
  });

  it("keeps rejecting p2p urls in the ordinary pairing resolver", () => {
    expect(() =>
      resolveRemotePairingTarget({ pairingUrl: `t3+p2p://${P2P_KEY}/#token=x` }),
    ).toThrow(RemotePairingUrlInvalidError);
  });
});

describe("remote", () => {
  it("derives backend urls and token from a pairing url", () => {
    expect(
      resolveRemotePairingTarget({
        pairingUrl: "https://remote.example.com/pair#token=pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("accepts pairing urls that still use a query token", () => {
    expect(
      resolveRemotePairingTarget({
        pairingUrl: "https://remote.example.com/pair?token=pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("derives backend urls from hosted app pairing links", () => {
    expect(
      resolveRemotePairingTarget({
        pairingUrl:
          "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%3A44342%2F#token=pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://desktop.tailnet.ts.net:44342/",
      wsBaseUrl: "wss://desktop.tailnet.ts.net:44342/",
    });
  });

  it("derives backend urls from a host and pairing code", () => {
    expect(
      resolveRemotePairingTarget({
        host: "https://remote.example.com",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("treats a protocol-relative host as https", () => {
    expect(
      resolveRemotePairingTarget({
        host: "//remote.example.com",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("preserves the port when normalizing a protocol-relative host", () => {
    expect(
      resolveRemotePairingTarget({
        host: "//remote.example.com:3000",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com:3000/",
      wsBaseUrl: "wss://remote.example.com:3000/",
    });
  });

  it("normalizes a protocol-relative host from a hosted pairing link", () => {
    expect(
      resolveRemotePairingTarget({
        pairingUrl: "https://app.t3.codes/pair?host=%2F%2Fremote.example.com#token=pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("collapses extra leading slashes instead of producing an empty host", () => {
    expect(
      resolveRemotePairingTarget({
        host: "///example.com",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://example.com/",
      wsBaseUrl: "wss://example.com/",
    });
  });

  it("does not double-prepend https when the host already carries a scheme", () => {
    expect(
      resolveRemotePairingTarget({
        host: "//https://example.com",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://example.com/",
      wsBaseUrl: "wss://example.com/",
    });
  });

  it("preserves host ports when normalizing a bare host input", () => {
    expect(
      resolveRemotePairingTarget({
        host: "myserver.com:3000",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://myserver.com:3000/",
      wsBaseUrl: "wss://myserver.com:3000/",
    });
  });

  it("rejects unsupported direct pairing URL protocols", () => {
    let pairingUrlError: unknown;
    try {
      resolveRemotePairingTarget({
        pairingUrl: "ftp://remote.example.com/pair#token=pairing-token",
      });
    } catch (cause) {
      pairingUrlError = cause;
    }

    expect(pairingUrlError).toBeInstanceOf(RemotePairingUrlInvalidError);
    expect(pairingUrlError).toMatchObject({ protocol: "ftp:" });
    expect((pairingUrlError as RemotePairingUrlInvalidError).cause).toBeUndefined();
  });

  it("rejects unsupported hosted pairing backend protocols", () => {
    let hostError: unknown;
    try {
      resolveRemotePairingTarget({
        pairingUrl:
          "https://app.t3.codes/pair?host=ftp%3A%2F%2Fremote.example.com#token=pairing-token",
      });
    } catch (cause) {
      hostError = cause;
    }

    expect(hostError).toBeInstanceOf(RemoteBackendUrlInvalidError);
    expect(hostError).toMatchObject({ source: "hosted-pairing-host", protocol: "ftp:" });
    expect((hostError as RemoteBackendUrlInvalidError).cause).toBeUndefined();
  });

  it("rejects unsupported direct host protocols", () => {
    let hostError: unknown;
    try {
      resolveRemotePairingTarget({
        host: "ftp://remote.example.com",
        pairingCode: "pairing-token",
      });
    } catch (cause) {
      hostError = cause;
    }

    expect(hostError).toBeInstanceOf(RemoteBackendUrlInvalidError);
    expect(hostError).toMatchObject({ source: "direct-host", protocol: "ftp:" });
    expect((hostError as RemoteBackendUrlInvalidError).cause).toBeUndefined();
  });

  it("uses distinct structural errors for missing pairing inputs", () => {
    expect(() => resolveRemotePairingTarget({})).toThrowError(RemoteBackendUrlMissingError);
    expect(() =>
      resolveRemotePairingTarget({ pairingUrl: "https://remote.example.com/pair" }),
    ).toThrowError(RemotePairingTokenMissingError);
    expect(() =>
      resolveRemotePairingTarget({
        host: "https://user:secret@remote.example.com/path?token=sensitive#fragment",
      }),
    ).toThrowError(
      expect.objectContaining({
        _tag: "RemotePairingCodeMissingError",
        host: "remote.example.com",
      }),
    );
  });

  it("preserves URL parsing causes with their input source", () => {
    let pairingUrlError: unknown;
    try {
      resolveRemotePairingTarget({ pairingUrl: "not a url" });
    } catch (cause) {
      pairingUrlError = cause;
    }
    expect(pairingUrlError).toBeInstanceOf(RemotePairingUrlInvalidError);
    expect((pairingUrlError as RemotePairingUrlInvalidError).cause).toBeInstanceOf(TypeError);

    let hostError: unknown;
    try {
      resolveRemotePairingTarget({ host: "https://[invalid", pairingCode: "pairing-token" });
    } catch (cause) {
      hostError = cause;
    }
    expect(hostError).toBeInstanceOf(RemoteBackendUrlInvalidError);
    expect(hostError).toMatchObject({ source: "direct-host" });
    expect((hostError as RemoteBackendUrlInvalidError).cause).toBeInstanceOf(TypeError);
  });
});
