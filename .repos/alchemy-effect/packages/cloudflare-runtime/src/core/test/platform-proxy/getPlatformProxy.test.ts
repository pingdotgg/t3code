import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "@effect/vitest";
import * as Assets from "../../bindings/assets/Assets.ts";
import * as KvNamespace from "../../bindings/kv-namespace/index.ts";
import * as Text from "../../bindings/Text.ts";
import { getPlatformProxy } from "../../platform-proxy/getPlatformProxy.ts";

interface TestEnv {
  TEXT: string;
  KV: {
    put: (key: string, value: string) => Promise<void>;
    get: (key: string) => Promise<string | null>;
  };
}

it("getPlatformProxy provides working bindings from plain Node code", async () => {
  const proxy = await getPlatformProxy<TestEnv>({
    bindings: [Text.local("TEXT", "from-promise-api"), KvNamespace.local({ binding: "KV" })],
  });
  try {
    expect(proxy.env.TEXT).toBe("from-promise-api");
    await proxy.env.KV.put("key", "value");
    expect(await proxy.env.KV.get("key")).toBe("value");
    expect(proxy.cf.country).toBe("US");
    proxy.ctx.waitUntil(Promise.resolve());
    await proxy.caches.default.put("https://example.com/x", new Response("body"));
    const match = await proxy.caches.default.match("https://example.com/x");
    expect(match && (await match.text())).toBe("body");
  } finally {
    await proxy.dispose();
  }
}, 60_000);

it("dispose is idempotent and shuts the instance down", async () => {
  const proxy = await getPlatformProxy<TestEnv>({
    bindings: [Text.local("TEXT", "dispose-test"), KvNamespace.local({ binding: "KV" })],
  });
  await proxy.env.KV.put("key", "value");
  await proxy.dispose();
  await proxy.dispose();
  // concurrent double-dispose is also safe
  await Promise.all([proxy.dispose(), proxy.dispose()]);
  // the workerd instance is gone: further binding calls fail
  await expect(proxy.env.KV.get("key")).rejects.toThrow();
}, 60_000);

it("serves a static directory to an ASSETS binding", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "platform-proxy-assets-"));
  try {
    await fs.writeFile(path.join(directory, "robots.txt"), "User-agent: *\n");
    const proxy = await getPlatformProxy<{ ASSETS: { fetch: (url: string) => Promise<Response> } }>(
      { bindings: [Assets.local("ASSETS")], assets: { directory } },
    );
    try {
      const response = await proxy.env.ASSETS.fetch("https://example.com/robots.txt");
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("User-agent: *\n");
    } finally {
      await proxy.dispose();
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 60_000);

it("starts with an ASSETS binding whose static directory doesn't exist yet", async () => {
  const directory = path.join(os.tmpdir(), "platform-proxy-assets-missing");
  await fs.rm(directory, { recursive: true, force: true });
  const proxy = await getPlatformProxy<{ ASSETS: { fetch: (url: string) => Promise<Response> } }>({
    bindings: [Assets.local("ASSETS")],
    assets: { directory },
  });
  try {
    const response = await proxy.env.ASSETS.fetch("https://example.com/robots.txt");
    expect(response.status).toBe(404);
  } finally {
    await proxy.dispose();
  }
}, 60_000);
