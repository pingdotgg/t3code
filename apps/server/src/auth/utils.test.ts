import { describe, expect, it } from "vite-plus/test";

import { deriveAuthClientMetadata, resolveSessionCookieName } from "./utils.ts";

describe("deriveAuthClientMetadata", () => {
  it("labels Electron user agents as Electron instead of Chrome", () => {
    const metadata = deriveAuthClientMetadata({
      request: {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) t3code/0.0.15 Chrome/136.0.7103.93 Electron/36.3.2 Safari/537.36",
        },
        source: {
          remoteAddress: "::ffff:127.0.0.1",
        },
      } as never,
    });

    expect(metadata).toMatchObject({
      browser: "Electron",
      deviceType: "desktop",
      ipAddress: "127.0.0.1",
      os: "macOS",
    });
  });

  it.each([
    [
      "Edge on Android",
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36 EdgA/129.0.0.0",
      "Edge",
    ],
    [
      "Edge on iOS",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/129.0.2792.84 Mobile/15E148 Safari/605.1.15",
      "Edge",
    ],
    [
      "Firefox on iOS",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/131.0 Mobile/15E148 Safari/605.1.15",
      "Firefox",
    ],
    [
      "Opera on iOS",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 OPiOS/5.0.0 Mobile/15E148 Safari/605.1.15",
      "Opera",
    ],
  ])("labels %s by its own browser token", (_name, userAgent, browser) => {
    const metadata = deriveAuthClientMetadata({
      request: { headers: { "user-agent": userAgent }, source: {} } as never,
    });

    expect(metadata.browser).toBe(browser);
  });

  it("applies client-presented display identity without replacing transport metadata", () => {
    const metadata = deriveAuthClientMetadata({
      request: {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136.0.7103.93 Electron/36.3.2 Safari/537.36",
        },
        source: {
          remoteAddress: "::ffff:192.168.213.72",
        },
      } as never,
      presented: {
        label: "T3 Code Mobile",
        deviceType: "mobile",
        os: "iOS",
      },
    });

    expect(metadata).toMatchObject({
      label: "T3 Code Mobile",
      browser: "Electron",
      deviceType: "mobile",
      ipAddress: "192.168.213.72",
      os: "iOS",
    });
    expect(metadata.userAgent).toContain("Electron/36.3.2");
  });
});

describe("session cookie isolation", () => {
  it("isolates loopback web servers by port and server state", () => {
    const first = resolveSessionCookieName({
      mode: "web",
      port: 5775,
      host: "127.0.0.1",
      instanceKey: "/tmp/t3-agent-one",
      environmentId: "environment-one",
      development: true,
    });
    const second = resolveSessionCookieName({
      mode: "web",
      port: 5775,
      host: "127.0.0.1",
      instanceKey: "/tmp/t3-agent-two",
      environmentId: "environment-two",
      development: true,
    });

    expect(first).toMatch(/^t3_session_5775_[a-f0-9]{12}$/);
    expect(second).toMatch(/^t3_session_5775_[a-f0-9]{12}$/);
    expect(first).not.toBe(second);
  });

  // regression: #8085 isolate remote web session cookies
  it("isolates remote web servers by server state", () => {
    const first = resolveSessionCookieName({
      mode: "web",
      port: 3773,
      host: "192.168.1.50",
      instanceKey: "/srv/t3-one",
      environmentId: "environment-one",
      development: false,
    });
    const second = resolveSessionCookieName({
      mode: "web",
      port: 5775,
      host: "192.168.1.50",
      instanceKey: "/srv/t3-two",
      environmentId: "environment-two",
      development: false,
    });

    expect(first).toMatch(/^t3_session_[a-f0-9]{12}$/);
    expect(second).toMatch(/^t3_session_[a-f0-9]{12}$/);
    expect(first).not.toBe(second);
  });

  it("keeps a remote web server cookie stable across port changes", () => {
    const first = resolveSessionCookieName({
      mode: "web",
      port: 8080,
      host: "0.0.0.0",
      instanceKey: "/srv/t3",
      environmentId: "environment-one",
      development: false,
    });
    const second = resolveSessionCookieName({
      mode: "web",
      port: 9090,
      host: "app.example.com",
      instanceKey: "/srv/t3",
      environmentId: "environment-one",
      development: false,
    });

    expect(first).toBe(second);
  });
});
