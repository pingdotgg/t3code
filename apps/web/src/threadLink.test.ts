import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadLink } from "./threadLink";

const ref = {
  environmentId: "env_local" as EnvironmentId,
  threadId: "thr_123" as ThreadId,
} as ScopedThreadRef;

describe("resolveThreadLink", () => {
  it("uses the browser origin the client is served from", () => {
    expect(
      resolveThreadLink({
        clientOrigin: "https://app.t3.codes",
        environmentHttpBaseUrl: "http://192.168.1.4:3773",
        ref,
      }),
    ).toBe("https://app.t3.codes/env_local/thr_123");
  });

  it("falls back to the environment server when the origin is not a web origin", () => {
    expect(
      resolveThreadLink({
        clientOrigin: "t3code://app",
        environmentHttpBaseUrl: "http://127.0.0.1:3773/",
        ref,
      }),
    ).toBe("http://127.0.0.1:3773/env_local/thr_123");
  });

  it("returns null when neither the client nor the environment has a web origin", () => {
    expect(
      resolveThreadLink({ clientOrigin: "t3code://app", environmentHttpBaseUrl: null, ref }),
    ).toBeNull();
    expect(
      resolveThreadLink({ clientOrigin: null, environmentHttpBaseUrl: "not a url", ref }),
    ).toBeNull();
  });

  it("drops any path the environment base URL carries", () => {
    expect(
      resolveThreadLink({
        clientOrigin: null,
        environmentHttpBaseUrl: "https://tunnel.example.com/base/",
        ref,
      }),
    ).toBe("https://tunnel.example.com/env_local/thr_123");
  });
});
