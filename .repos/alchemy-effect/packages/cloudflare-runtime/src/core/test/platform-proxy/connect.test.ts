import { expect, it } from "@effect/vitest";
import * as KvNamespace from "../../bindings/kv-namespace/index.ts";
import * as Text from "../../bindings/Text.ts";
import { connect } from "../../platform-proxy/connect.ts";
import { getPlatformProxy } from "../../platform-proxy/getPlatformProxy.ts";

interface TestEnv {
  TEXT: string;
  KV: {
    put: (key: string, value: string) => Promise<void>;
    get: (key: string) => Promise<string | null>;
  };
}

it("connect() rebuilds working proxies from plain connect info", async () => {
  const proxy = await getPlatformProxy<TestEnv>({
    bindings: [
      Text.local("TEXT", "from-connect"),
      KvNamespace.local({ binding: "KV" }),
    ],
  });
  try {
    expect(proxy.connectInfo.url).toBe(proxy.url.href);
    expect(proxy.connectInfo.token).toMatch(/^[0-9a-f-]{36}$/);

    // A second, independent client from the two plain strings alone.
    const client = await connect<TestEnv>({ ...proxy.connectInfo });
    expect(client.env.TEXT).toBe("from-connect");

    // KV round-trip — and binding state is SHARED with the owning instance.
    await client.env.KV.put("key", "value");
    expect(await client.env.KV.get("key")).toBe("value");
    expect(await proxy.env.KV.get("key")).toBe("value");

    // Caches round-trip (also shared with the owning instance).
    await client.caches.default.put(
      "https://example.com/connect",
      new Response("cached"),
    );
    const match = await client.caches.default.match(
      "https://example.com/connect",
    );
    expect(match && (await match.text())).toBe("cached");
    const shared = await proxy.caches.default.match(
      "https://example.com/connect",
    );
    expect(shared && (await shared.text())).toBe("cached");

    // cf/ctx mocks match the instance's contract.
    expect(client.cf.country).toBe("US");
    client.ctx.waitUntil(Promise.resolve());
  } finally {
    await proxy.dispose();
  }
}, 60_000);

it("connect() fails fast and descriptively once the instance is disposed", async () => {
  const proxy = await getPlatformProxy<TestEnv>({
    bindings: [
      Text.local("TEXT", "gone"),
      KvNamespace.local({ binding: "KV" }),
    ],
  });
  const info = proxy.connectInfo;
  await proxy.dispose();
  const start = Date.now();
  await expect(connect(info)).rejects.toThrow(
    /could not reach the proxy worker/,
  );
  // No retry loop: unreachable means a single fast failure.
  expect(Date.now() - start).toBeLessThan(5_000);
}, 60_000);
