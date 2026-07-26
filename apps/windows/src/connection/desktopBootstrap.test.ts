import { describe, expect, it } from "vite-plus/test";

import {
  CLIENT_LABEL,
  DesktopBootstrapError,
  type FetchLike,
  encodeTokenExchangeForm,
  exchangeBootstrapToken,
  fetchEnvironmentDescriptor,
  openLocalEnvironmentSession,
} from "./desktopBootstrap.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function recordingFetch(handler: (url: string, init: RequestInit | undefined) => Response): {
  fetch: FetchLike;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(handler(url, init));
    },
  };
}

describe("encodeTokenExchangeForm", () => {
  it("emits the RFC 8693 fields the server's schema expects", () => {
    const form = new URLSearchParams(encodeTokenExchangeForm({ subjectToken: "boot-token" }));
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
    expect(form.get("subject_token")).toBe("boot-token");
    expect(form.get("subject_token_type")).toBe(
      "urn:t3:params:oauth:token-type:environment-bootstrap",
    );
    expect(form.get("requested_token_type")).toBe("urn:ietf:params:oauth:token-type:access_token");
    expect(form.get("client_device_type")).toBe("desktop");
    expect(form.get("client_label")).toBe(CLIENT_LABEL);
  });

  it("percent-encodes tokens so a base64url '-'/'_' payload survives", () => {
    const token = "aA0-_~ +&=";
    const form = new URLSearchParams(encodeTokenExchangeForm({ subjectToken: token }));
    expect(form.get("subject_token")).toBe(token);
  });

  it("lets the caller override the session label", () => {
    const form = new URLSearchParams(
      encodeTokenExchangeForm({ subjectToken: "t", clientLabel: "Test Harness" }),
    );
    expect(form.get("client_label")).toBe("Test Harness");
  });
});

describe("exchangeBootstrapToken", () => {
  it("posts a form-encoded body and returns the access token", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse({ access_token: "bearer-abc" }));
    const token = await exchangeBootstrapToken(fetch, "http://127.0.0.1:3773", "boot");

    expect(token).toBe("bearer-abc");
    expect(calls[0]?.url).toBe("http://127.0.0.1:3773/oauth/token");
    expect(calls[0]?.init?.method).toBe("POST");
    // The endpoint is declared `asFormUrlEncoded`; sending JSON gets a 400.
    const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
    expect(headers?.["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("does not double up slashes when the base URL has a trailing one", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse({ access_token: "t" }));
    await exchangeBootstrapToken(fetch, "http://127.0.0.1:3773/", "boot");
    expect(calls[0]?.url).toBe("http://127.0.0.1:3773/oauth/token");
  });

  it("reports a rejected exchange instead of returning undefined", async () => {
    const { fetch } = recordingFetch(() => jsonResponse({ error: "invalid_grant" }, 400));
    await expect(exchangeBootstrapToken(fetch, "http://127.0.0.1:3773", "stale")).rejects.toThrow(
      DesktopBootstrapError,
    );
  });

  it("rejects a 200 whose body is missing the token", async () => {
    const { fetch } = recordingFetch(() => jsonResponse({ token: "wrong-key" }));
    await expect(exchangeBootstrapToken(fetch, "http://127.0.0.1:3773", "boot")).rejects.toThrow(
      /did not match the expected shape/,
    );
  });

  it("rejects a non-JSON body rather than throwing a bare SyntaxError", async () => {
    const { fetch } = recordingFetch(() => new Response("<html>proxy</html>", { status: 200 }));
    await expect(exchangeBootstrapToken(fetch, "http://127.0.0.1:3773", "boot")).rejects.toThrow(
      DesktopBootstrapError,
    );
  });
});

describe("fetchEnvironmentDescriptor", () => {
  it("reads the same well-known route the supervisor polls", async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse({ environmentId: "env-1", label: "Studio PC" }),
    );
    const descriptor = await fetchEnvironmentDescriptor(fetch, "http://127.0.0.1:3773");

    expect(calls[0]?.url).toBe("http://127.0.0.1:3773/.well-known/t3/environment");
    expect(descriptor).toEqual({ environmentId: "env-1", label: "Studio PC" });
  });

  it("falls back to a generic label when the server does not send one", async () => {
    const { fetch } = recordingFetch(() => jsonResponse({ environmentId: "env-1" }));
    expect((await fetchEnvironmentDescriptor(fetch, "http://127.0.0.1:3773")).label).toBe(
      "This PC",
    );
  });
});

describe("openLocalEnvironmentSession", () => {
  it("returns everything the bearer registration needs", async () => {
    const { fetch } = recordingFetch((url) =>
      url.endsWith("/oauth/token")
        ? jsonResponse({ access_token: "bearer-abc" })
        : jsonResponse({ environmentId: "env-1", label: "Studio PC" }),
    );

    const session = await openLocalEnvironmentSession(fetch, {
      httpBaseUrl: "http://127.0.0.1:3773",
      wsBaseUrl: "ws://127.0.0.1:3773",
      bootstrapToken: "boot",
    });

    expect(session).toEqual({
      environmentId: "env-1",
      label: "Studio PC",
      httpBaseUrl: "http://127.0.0.1:3773",
      wsBaseUrl: "ws://127.0.0.1:3773",
      bearerToken: "bearer-abc",
    });
  });

  it("surfaces a failing half of the handshake", async () => {
    const { fetch } = recordingFetch((url) =>
      url.endsWith("/oauth/token") ? jsonResponse({}, 401) : jsonResponse({ environmentId: "e" }),
    );
    await expect(
      openLocalEnvironmentSession(fetch, {
        httpBaseUrl: "http://127.0.0.1:3773",
        wsBaseUrl: "ws://127.0.0.1:3773",
        bootstrapToken: "boot",
      }),
    ).rejects.toThrow(DesktopBootstrapError);
  });
});
