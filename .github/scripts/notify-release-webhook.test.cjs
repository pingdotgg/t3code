const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const test = require("node:test");
const { notifyRelease } = require("./notify-release-webhook.cjs");

function fixture(overrides = {}) {
  const release = {
    id: 42,
    tag_name: "v0.1.10-nightly.20261112.4580",
    draft: false,
    published_at: "2026-11-12T10:48:42Z",
    html_url: "https://github.com/example/app/releases/tag/v0.1.10-nightly.20261112.4580",
    ...overrides,
  };
  return {
    github: { rest: { repos: { getReleaseByTag: async () => ({ data: release }) } } },
    repo: { owner: "example", repo: "app" },
    tag: release.tag_name,
    sha: "a".repeat(40),
    channel: "nightly",
    url: "https://example.invalid/notify?token=private",
    secret: "test-signing-key",
  };
}

test("signs the exact publication payload and uses a stable delivery ID across retries and reruns", async () => {
  const options = fixture();
  const deliveries = [];
  const request = async (_url, init) => {
    deliveries.push(init);
    return new Response(null, { status: deliveries.length === 1 ? 503 : 202 });
  };
  await notifyRelease({ ...options, request });
  await notifyRelease({ ...options, request });
  assert.equal(deliveries.length, 3);
  for (const delivery of deliveries) {
    assert.equal(delivery.redirect, "error");
    assert.equal(delivery.headers["X-T3-Delivery"], "example/app:release:42");
    assert.equal(
      delivery.headers["X-Hub-Signature-256"],
      "sha256=" + crypto.createHmac("sha256", options.secret).update(delivery.body).digest("hex"),
    );
    assert.deepEqual(JSON.parse(delivery.body), {
      schema_version: 1,
      event: "release.published",
      repository: "example/app",
      channel: "nightly",
      tag: options.tag,
      commit_sha: options.sha,
      release_id: 42,
      release_url: "https://github.com/example/app/releases/tag/" + options.tag,
      published_at: "2026-11-12T10:48:42Z",
    });
  }
});

test("disabled configuration makes no network requests", async () => {
  const noNetwork = async () => assert.fail("No request expected");
  assert.deepEqual(await notifyRelease({ url: "", request: noNetwork }), { status: "disabled" });
});

test("real HTTP delivery preserves the signature and fetch never follows a redirect", async () => {
  const received = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push({ path: request.url, signature: request.headers["x-hub-signature-256"], body });
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: "/must-not-receive-the-signature" });
    } else {
      response.writeHead(202);
    }
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    // The local fixture uses HTTP; production configuration still requires HTTPS.
    const request = (url, init) => fetch(new URL(url.pathname, origin), init);
    const options = fixture();
    await notifyRelease({ ...options, request });
    assert.equal(
      received[0].signature,
      "sha256=" +
        crypto.createHmac("sha256", options.secret).update(received[0].body).digest("hex"),
    );
    await assert.rejects(
      notifyRelease({ ...options, url: "https://example.invalid/redirect", request }),
      /transport failed after three attempts/,
    );
    assert.deepEqual(
      received.map((entry) => entry.path),
      ["/notify", "/redirect", "/redirect", "/redirect"],
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("refuses unsafe configuration and unpublished releases before delivery", async () => {
  for (const options of [
    { ...fixture(), url: "http://example.invalid" },
    { ...fixture(), url: "invalid-endpoint-with-private-token" },
    { ...fixture(), secret: "" },
    { ...fixture(), url: "https://user:password@example.invalid" },
    fixture({ draft: true }),
    fixture({ published_at: null }),
    { ...fixture(), tag: "different-tag" },
    { ...fixture(), sha: "main" },
  ]) {
    let attempts = 0;
    await assert.rejects(
      notifyRelease({
        ...options,
        request: async () => {
          attempts++;
          assert.fail("No delivery expected");
        },
      }),
    );
    assert.equal(attempts, 0);
  }
});

test("bounds failed retries, avoids retrying permanent refusals and redacts transport failures", async () => {
  for (const [status, expectedAttempts] of [
    [429, 3],
    [500, 3],
    [401, 1],
    [302, 1],
  ]) {
    let attempts = 0;
    await assert.rejects(
      notifyRelease({
        ...fixture(),
        request: async () => {
          attempts++;
          return new Response(null, { status });
        },
      }),
      new RegExp(`HTTP ${status}`),
    );
    assert.equal(attempts, expectedAttempts);
  }
  let attempts = 0;
  await assert.rejects(
    notifyRelease({
      ...fixture(),
      request: async () => {
        attempts++;
        throw new Error("https://example.invalid/notify?token=private");
      },
    }),
    (error) => error.message === "Release webhook transport failed after three attempts",
  );
  assert.equal(attempts, 3);
});
