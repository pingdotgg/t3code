import { describe, expect, it } from "vite-plus/test";
import { createNativeClerkTransport } from "./nativeClerkTransport";

function setup() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  return {
    values,
    transport: createNativeClerkTransport({
      frontendApi: "https://clerk.example.test",
      origin: "http://localhost:3773",
      storage,
      storageKey: "home-account",
    }),
  };
}

describe("Clerk native browser transport", () => {
  it("keeps the user's client JWT across requests without confusing it with environment auth", () => {
    const { transport, values } = setup();
    transport.afterResponse(
      {},
      new Response("{}", { headers: { "x-t3-clerk-client": "Bearer client-jwt" } }),
    );
    expect(values.get("home-account")).toBe("client-jwt");
    const request = {
      url: new URL(
        "https://clerk.example.test/v1/client/sessions/session-1/tokens/t3-relay?_method=POST",
      ),
      headers: new Headers({ authorization: "Bearer wrong-auth" }),
      credentials: "omit" as RequestCredentials,
    };
    transport.beforeRequest(request);
    expect(request.url.origin).toBe("http://localhost:3773");
    expect(request.url.pathname).toBe("/api/connect/native-auth");
    expect(request.url.searchParams.get("path")).toBe(
      "/v1/client/sessions/session-1/tokens/t3-relay",
    );
    expect(request.url.searchParams.get("search")).toBe("?_method=POST");
    expect(request.headers.get("authorization")).toBeNull();
    expect(request.headers.get("x-t3-clerk-client")).toBe("client-jwt");
    expect(request.credentials).toBe("include");
  });
  it("persists rotated credentials for the next request and isolates another environment", () => {
    const { transport, values } = setup();
    values.set("other-account", "other-client");
    transport.afterResponse(
      {},
      new Response("{}", { headers: { "x-t3-clerk-client": "new-client" } }),
    );
    const request = {
      url: new URL("https://clerk.example.test/v1/client"),
      headers: new Headers(),
    };
    transport.beforeRequest(request);
    expect(request.headers.get("x-t3-clerk-client")).toBe("new-client");
    expect(values.get("other-account")).toBe("other-client");
  });
  it("never attaches credentials to a different issuer", () => {
    const { transport, values } = setup();
    values.set("home-account", "secret");
    const request = { url: new URL("https://other.test/v1/client"), headers: new Headers() };
    expect(() => transport.beforeRequest(request)).toThrow("Unexpected");
    expect(request.headers.get("x-t3-clerk-client")).toBeNull();
  });
});
