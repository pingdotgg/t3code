import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  stage: "test",
});

const stack = beforeAll(deploy(Stack), { timeout: 180_000 });

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 180_000,
});

type Client = HttpClient.HttpClient;

// A fresh workers.dev URL serves Cloudflare's "nothing here yet" 404 page
// until the new route propagates (often 30s+, occasionally over a minute for
// a just-enabled subdomain), and can also return connection errors or edge
// 52x cold-start responses. A 404 is therefore ambiguous - it may be the edge
// placeholder, not the Worker. The only response that proves the Worker code
// is executing is a 401 to a bad-token PUT (auth runs before any body/header
// validation and before any binding work, so repeating it is side-effect
// free). `client.execute` only fails the Effect on connection errors, so
// retry those and repeat until the 401 shows up. Callers must assert the
// returned status is 401 so a propagation stall fails loudly here instead of
// as a confusing 404 on the next assertion.
const warmUp = (client: Client, url: string) =>
  client
    .execute(
      HttpClientRequest.put(`${url}/projects/_warmup/packages`).pipe(
        HttpClientRequest.bearerToken("warmup-not-the-token"),
      ),
    )
    .pipe(
      Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 10 }),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (res) => res.status === 401,
        times: 90,
      }),
    );

const upload = (
  client: Client,
  url: string,
  token: string,
  project: string,
  tags: string[],
  content: string,
) =>
  client.execute(
    HttpClientRequest.put(`${url}/projects/${project}/packages`).pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setHeader("X-Tags", JSON.stringify(tags)),
      HttpClientRequest.setBody(HttpBody.text(content)),
    ),
  );

const getPackage = (
  client: Client,
  url: string,
  project: string,
  resourceId: string,
) => client.get(`${url}/projects/${project}/packages/${resourceId}`);

const getTag = (client: Client, url: string, project: string, tag: string) =>
  client.get(`${url}/projects/${project}/tags/${tag}`);

const deleteTag = (
  client: Client,
  url: string,
  token: string,
  project: string,
  tag: string,
) =>
  client.execute(
    HttpClientRequest.make("DELETE")(
      `${url}/projects/${project}/tags/${tag}`,
    ).pipe(HttpClientRequest.bearerToken(token)),
  );

// Tag lookups go through Workers KV, which is eventually consistent, and the
// edge can return a transient 5xx. Poll the request until it reaches the
// expected status (or give up after ~30s) so assertions test the converged
// state rather than racing the write.
const pollUntilStatus = <A extends { readonly status: number }, E, R>(
  request: Effect.Effect<A, E, R>,
  status: number,
): Effect.Effect<A, E, R> =>
  request.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (res) => res.status === status,
      times: 30,
    }),
  );

/**
 * Regression guard for https://github.com/alchemy-run/alchemy/pull/598
 *
 * Exercises the real `@alchemy.run/pr-package` Worker. The bearer token is
 * symmetric:
 *
 *  - Stack output: `authToken.text` is an `Output<Redacted<string>>`. It must
 *    be unwrapped via `Output.map(Redacted.value)` before being returned -
 *    otherwise it JSON-serializes to the literal string "<redacted>".
 *  - Worker check: `Cloudflare.Secret.bind(...)` resolves to `Redacted<string>`.
 *    The handler must unwrap with `Redacted.value(expected)` - otherwise it
 *    compares the request against "Bearer <redacted>".
 *
 * Two bugs that cancelled: a publisher reading the broken `<redacted>` output
 * would send `Bearer <redacted>`, which the broken worker check also produced,
 * so they matched. This suite breaks that camouflage:
 *
 *  - The output must be the real token, not "<redacted>".
 *  - A request carrying the literal "<redacted>" must be rejected.
 */
test(
  "stack output emits the real token, not the literal <redacted>",
  Effect.gen(function* () {
    const { authToken } = yield* stack;
    expect(authToken).toBeString();
    expect(authToken).not.toBe("<redacted>");
    // Random defaults to 32 bytes -> 64 hex chars.
    expect(authToken).toMatch(/^[0-9a-f]{64}$/);
  }),
);

test(
  "valid token is accepted; invalid / missing / <redacted> are rejected",
  Effect.gen(function* () {
    const { url, authToken } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    // `PUT /projects/:pkg/packages` is bearer-protected by the pr-package
    // handler (auth runs before any body/header validation).
    const packagesUrl = `${url}/projects/test-pkg/packages`;
    const put = (token?: string) => {
      let req = HttpClientRequest.put(packagesUrl).pipe(
        HttpClientRequest.setHeader("X-Tags", JSON.stringify(["v1"])),
        HttpClientRequest.setBody(HttpBody.text("hello-package-body")),
      );
      if (token !== undefined) {
        req = req.pipe(HttpClientRequest.bearerToken(token));
      }
      return client.execute(req);
    };

    // Warm up through edge propagation and assert the Worker actually
    // answered (401) - if the route never propagated we want to fail here,
    // not with a baffling 404 on the valid-token assertion below.
    const warmed = yield* warmUp(client, url);
    expect(warmed.status).toBe(401);

    // Valid token -> 200 with a resourceId. The first real write can hit a
    // cold R2/DO binding and 500, so poll until it converges.
    const ok = yield* pollUntilStatus(put(authToken), 200);
    expect(ok.status).toBe(200);
    const body = (yield* ok.json) as { resourceId: string };
    expect(body.resourceId).toBeString();

    // Invalid token -> 401.
    const bad = yield* put("not-the-token");
    expect(bad.status).toBe(401);

    // No Authorization header -> 401.
    const none = yield* put(undefined);
    expect(none.status).toBe(401);

    // The literal "<redacted>" (what both old bugs produced) -> 401.
    // Pre-fix this matched and returned 200.
    const redacted = yield* put("<redacted>");
    expect(redacted.status).toBe(401);

    // Clean up the uploaded object so afterAll's destroy() can delete the R2
    // bucket - deleting the only tag orphans and removes the stored package.
    const del = yield* client.execute(
      HttpClientRequest.make("DELETE")(`${url}/projects/test-pkg/tags/v1`).pipe(
        HttpClientRequest.bearerToken(authToken),
      ),
    );
    expect(del.status).toBe(200);
  }),
  // Warmup alone can legitimately take ~90s on a fresh workers.dev route.
  { timeout: 180_000 },
);

test(
  "uploads a bundle and serves the exact bytes back for download",
  Effect.gen(function* () {
    const { url, authToken } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    expect((yield* warmUp(client, url)).status).toBe(401);

    const project = "download-test";
    const content = "fake-tarball-contents- -12345";

    // Upload a bundle under a single tag (retry through cold-binding 5xx).
    const put = yield* pollUntilStatus(
      upload(client, url, authToken, project, ["1.0.0"], content),
      200,
    );
    expect(put.status).toBe(200);
    const { resourceId } = (yield* put.json) as { resourceId: string };
    expect(resourceId).toBeString();

    // Download directly by resourceId - the stored bytes round-trip exactly.
    const dl = yield* pollUntilStatus(
      getPackage(client, url, project, resourceId),
      200,
    );
    expect(dl.status).toBe(200);
    expect(yield* dl.text).toBe(content);

    // Download via the tag: the route 302-redirects to the package and the
    // client follows it, so the tag serves the same bytes. KV may lag the
    // upload, so poll until the tag resolves.
    const viaTag = yield* pollUntilStatus(
      getTag(client, url, project, "1.0.0"),
      200,
    );
    expect(yield* viaTag.text).toBe(content);

    // Cleanup: dropping the only tag removes the bundle (see GC test below).
    const del = yield* deleteTag(client, url, authToken, project, "1.0.0");
    expect(del.status).toBe(200);
    const gone = yield* pollUntilStatus(
      getPackage(client, url, project, resourceId),
      404,
    );
    expect(gone.status).toBe(404);
  }),
  { timeout: 180_000 },
);

test(
  "a bundle is garbage-collected once its last tag pointer is removed",
  Effect.gen(function* () {
    const { url, authToken } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    expect((yield* warmUp(client, url)).status).toBe(401);

    const project = "gc-test";
    const content = "gc-bundle-body";

    // One bundle, two tags pointing at it (retry through cold-binding 5xx).
    const put = yield* pollUntilStatus(
      upload(client, url, authToken, project, ["1.0.0", "latest"], content),
      200,
    );
    expect(put.status).toBe(200);
    const { resourceId } = (yield* put.json) as { resourceId: string };

    // The bundle is downloadable (R2 is read-after-write consistent).
    const present = yield* pollUntilStatus(
      getPackage(client, url, project, resourceId),
      200,
    );
    expect(present.status).toBe(200);

    // Remove one of the two tags - the removed tag stops resolving, but the
    // bundle survives because "latest" still points at it.
    expect(
      (yield* deleteTag(client, url, authToken, project, "1.0.0")).status,
    ).toBe(200);
    const removedTag = yield* pollUntilStatus(
      getTag(client, url, project, "1.0.0"),
      404,
    );
    expect(removedTag.status).toBe(404);
    expect((yield* getPackage(client, url, project, resourceId)).status).toBe(
      200,
    );

    // Remove the last tag - the bundle is garbage-collected.
    expect(
      (yield* deleteTag(client, url, authToken, project, "latest")).status,
    ).toBe(200);
    const collected = yield* pollUntilStatus(
      getPackage(client, url, project, resourceId),
      404,
    );
    expect(collected.status).toBe(404);
  }),
  { timeout: 180_000 },
);
