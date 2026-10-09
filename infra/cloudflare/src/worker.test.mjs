import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import { createGateway } from "./worker.ts";
import { parseOrigin } from "./origin.ts";

function database(origin) {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  db.exec(NodeFS.readFileSync(new URL("../migrations/0001_gateway.sql", import.meta.url), "utf8"));
  if (origin)
    db.prepare("INSERT INTO gateway_config (id, upstream_origin) VALUES (1, ?)").run(origin);
  return { DB: { prepare: (sql) => ({ first: async () => db.prepare(sql).get() ?? null }) } };
}

NodeTest.test("migration restricts the gateway to one upstream", async () => {
  const env = database("https://backend.example");
  await NodeAssert.rejects(
    env.DB.prepare(
      "INSERT INTO gateway_config (id, upstream_origin) VALUES (2, 'https://other.example') RETURNING *",
    ).first(),
  );
});

NodeTest.test(
  "forwards streamed bodies, auth, cookies and queries to the configured origin",
  async () => {
    const gateway = createGateway(async (request) => {
      NodeAssert.equal(request.url, "https://backend.example/api/projects?cursor=a%2Fb");
      NodeAssert.equal(request.headers.get("authorization"), "Bearer test");
      NodeAssert.equal(request.headers.get("cookie"), "session=test");
      NodeAssert.equal(request.headers.get("x-forwarded-host"), "app.example");
      NodeAssert.equal(request.headers.get("x-forwarded-proto"), "https");
      NodeAssert.equal(request.headers.get("x-forwarded-for"), "192.0.2.1");
      NodeAssert.equal(request.headers.get("forwarded"), null);
      NodeAssert.equal(await request.text(), '{"name":"project"}');
      return new Response("ok", {
        headers: { "set-cookie": "session=new; Secure; HttpOnly; Path=/" },
      });
    });
    const response = await gateway.fetch(
      new Request("https://app.example/api/projects?cursor=a%2Fb", {
        method: "POST",
        body: '{"name":"project"}',
        headers: {
          authorization: "Bearer test",
          cookie: "session=test",
          "cf-connecting-ip": "192.0.2.1",
          "x-forwarded-host": "evil.example",
          "x-forwarded-for": "evil",
          forwarded: "host=evil.example",
        },
      }),
      database("https://backend.example"),
    );
    NodeAssert.equal(await response.text(), "ok");
    NodeAssert.equal(response.headers.get("set-cookie"), "session=new; Secure; HttpOnly; Path=/");
    NodeAssert.equal(response.headers.get("cache-control"), "no-store");
  },
);

NodeTest.test("double-slash paths cannot replace the upstream authority", async () => {
  const gateway = createGateway(async (request) => {
    NodeAssert.equal(new URL(request.url).origin, "https://backend.example");
    NodeAssert.equal(new URL(request.url).pathname, "//evil.example/ws");
    return new Response("ok");
  });
  NodeAssert.equal(
    (
      await gateway.fetch(
        new Request("https://app.example//evil.example/ws"),
        database("https://backend.example"),
      )
    ).status,
    200,
  );
});

NodeTest.test("WebSocket upgrade response passes through unchanged", async () => {
  // Node cannot construct a Workers 101 Response. Represent it at the fetch
  // boundary; Wrangler integration separately exercises the real upgrade.
  const upgraded = { status: 101, webSocket: {} };
  const gateway = createGateway(async (request) => {
    NodeAssert.equal(request.headers.get("upgrade"), "websocket");
    NodeAssert.equal(request.url, "https://backend.example/ws?ticket=test");
    return upgraded;
  });
  NodeAssert.equal(
    await gateway.fetch(
      new Request("https://app.example/ws?ticket=test", {
        headers: { upgrade: "websocket" },
      }),
      database("https://backend.example"),
    ),
    upgraded,
  );
});

NodeTest.test("rewrites upstream redirects but preserves external OAuth redirects", async () => {
  for (const [location, expected] of [
    ["https://backend.example/connect-agent?code=x", "https://app.example/connect-agent?code=x"],
    ["/connect-agent?code=x", "https://app.example/connect-agent?code=x"],
    ["http://localhost:1234/callback?code=x", "http://localhost:1234/callback?code=x"],
  ]) {
    const gateway = createGateway(async (request) => {
      NodeAssert.equal(request.redirect, "manual");
      return new Response(null, { status: 302, headers: { location } });
    });
    const response = await gateway.fetch(
      new Request("https://app.example/oauth/token"),
      database("https://backend.example"),
    );
    NodeAssert.equal(response.headers.get("location"), expected);
  }
});

NodeTest.test(
  "unconfigured, invalid, recursive and unavailable databases fail closed",
  async () => {
    const gateway = createGateway(() => {
      throw new Error("Must not fetch");
    });
    for (const origin of [
      undefined,
      "https://app.example",
      "http://backend.example",
      "https://backend.example/base",
    ]) {
      NodeAssert.equal(
        (await gateway.fetch(new Request("https://app.example/"), database(origin))).status,
        503,
      );
    }
    NodeAssert.equal(
      (
        await gateway.fetch(new Request("https://app.example/"), {
          DB: {
            prepare() {
              throw new Error("private database error");
            },
          },
        })
      ).status,
      503,
    );
  },
);

NodeTest.test("unreachable upstream returns a generic 502", async () => {
  const response = await createGateway(async () => {
    throw new Error("private network error");
  }).fetch(new Request("https://app.example/"), database("https://backend.example"));
  NodeAssert.equal(response.status, 502);
  NodeAssert.deepEqual(await response.json(), { error: "T3 server is unreachable." });
});

NodeTest.test("HTTP loopback origins are accepted only for local development", () => {
  NodeAssert.equal(parseOrigin("http://127.0.0.1:3773", true).origin, "http://127.0.0.1:3773");
  for (const origin of [
    "http://127.0.0.1:3773",
    "https://user:pass@example.com",
    "https://example.com/base",
    "https://example.com?",
    "https://example.com#",
  ]) {
    NodeAssert.throws(() => parseOrigin(origin));
  }
});
