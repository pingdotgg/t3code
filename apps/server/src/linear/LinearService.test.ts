import { assert, it } from "@effect/vitest";
import * as NodeBuffer from "node:buffer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerConfig from "../config.ts";
import * as Linear from "./LinearService.ts";
import { linearIssueFilter } from "./linearOperations.ts";

const viewer = { id: "viewer", name: "Panos", avatarUrl: null };
function testLayer(
  answer: (
    authorization: string | undefined,
    request: HttpClientRequest.HttpClientRequest,
  ) => Response,
) {
  return Linear.layer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "linear-test-" })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(Layer.succeed(HostProcess.Environment, { LINEAR_API_KEY: "environment-secret" })),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() =>
            HttpClientResponse.fromWeb(request, answer(request.headers.authorization, request)),
          ),
        ),
      ),
    ),
  );
}

it.effect(
  "validates a replacement key before persisting it, disconnects without falling back, and restores the environment key",
  () =>
    Effect.gen(function* () {
      const service = yield* Linear.LinearService;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      assert.deepEqual(yield* service.connection(), { connected: true, source: "environment" });
      const rejected = yield* service
        .configure({ kind: "save", apiKey: "bad-secret" })
        .pipe(Effect.flip);
      assert.equal(rejected.reason, "unauthorized");
      assert.equal(yield* fs.exists(`${config.secretsDir}/linear.json`), false);
      assert.deepEqual(yield* service.configure({ kind: "save", apiKey: "saved-secret" }), {
        connected: true,
        source: "saved",
      });
      const info = yield* fs.stat(`${config.secretsDir}/linear.json`);
      assert.equal(info.mode & 0o777, 0o600);
      assert.deepEqual(yield* service.configure({ kind: "disconnect" }), {
        connected: false,
        source: "disconnected",
      });
      assert.equal(
        (yield* service.issue({ id: "issue" }).pipe(Effect.flip)).reason,
        "disconnected",
      );
      assert.deepEqual(yield* service.configure({ kind: "environment" }), {
        connected: true,
        source: "environment",
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        testLayer((authorization) =>
          authorization === "bad-secret"
            ? Response.json({}, { status: 401 })
            : Response.json({ data: { result: viewer } }),
        ),
      ),
    ),
);

it.effect("treats partial GraphQL answers as failures and never retries a write", () => {
  let calls = 0;
  return Effect.gen(function* () {
    const service = yield* Linear.LinearService;
    const result = yield* service
      .mutate({ kind: "commentCreate", input: { issueId: "issue", body: "hello" } })
      .pipe(Effect.flip);
    assert.equal(result.reason, "rate-limit");
    assert.equal(calls, 1);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      testLayer(() => {
        calls++;
        return Response.json({
          data: { result: { success: true, entity: { id: "created" } } },
          errors: [{ extensions: { code: "RATELIMITED" } }],
        });
      }),
    ),
  );
});

it.effect("rejects unsuccessful mutations and malformed API answers", () => {
  let calls = 0;
  return Effect.gen(function* () {
    const service = yield* Linear.LinearService;
    assert.equal(
      (yield* service.mutate({ kind: "issueArchive", id: "issue" }).pipe(Effect.flip)).reason,
      "api",
    );
    assert.equal(
      (yield* service.issue({ id: "issue" }).pipe(Effect.flip)).reason,
      "invalid-response",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      testLayer(() =>
        Response.json({ data: { result: ++calls === 1 ? { success: false } : { id: "issue" } } }),
      ),
    ),
  );
});

it.effect("loads every directory page and rejects a repeated cursor", () => {
  let calls = 0;
  const state = { id: "state", name: "Todo", color: "#888", type: "unstarted" };
  const label = { id: "label", name: "Bug", color: "#f00" };
  return Effect.gen(function* () {
    const service = yield* Linear.LinearService;
    const context = yield* service.teamContext({ id: "team" });
    assert.equal(context.states.length, 2);
    assert.equal(context.labels.length, 1);
    assert.equal(calls, 5);
    assert.equal(
      (yield* service.teamContext({ id: "team" }).pipe(Effect.flip)).reason,
      "invalid-response",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      testLayer(() => {
        calls++;
        const nodes = calls <= 2 || calls > 5 ? [state] : calls === 3 ? [label] : [];
        return Response.json({
          data: {
            result: {
              items: {
                nodes,
                pageInfo: { hasNextPage: calls === 1 || calls > 5, endCursor: "cursor" },
              },
            },
          },
        });
      }),
    ),
  );
});

it("combines user, team, project and search filters without interpolating query text", () => {
  assert.deepEqual(
    linearIssueFilter(
      { view: "mine", teamId: "team", projectId: "project", stateId: "state", query: 'text"}' },
      "viewer",
    ),
    {
      team: { id: { eq: "team" } },
      project: { id: { eq: "project" } },
      assignee: { id: { eq: "viewer" } },
      state: { id: { eq: "state" } },
    },
  );
  assert.deepEqual(linearIssueFilter({ view: "active" }, "viewer"), {
    state: { type: { in: ["unstarted", "started"] } },
  });
});

it.effect(
  "uploads private raw bytes with signed storage headers and never forwards the API key",
  () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      const service = yield* Linear.LinearService;
      assert.deepEqual(
        yield* service.upload({ filename: "proof.txt", contentType: "text/plain", base64: "aGk=" }),
        { assetUrl: "https://uploads.linear.app/proof.txt" },
      );
      assert.equal(requests.length, 2);
      assert.equal(requests[0]?.headers.authorization, "environment-secret");
      assert.equal(requests[1]?.method, "PUT");
      assert.equal(requests[1]?.headers.authorization, undefined);
      assert.equal(requests[1]?.headers["x-upload-proof"], "signed");
      const body = requests[1]?.body;
      assert.equal(body?._tag, "Uint8Array");
      if (body?._tag === "Uint8Array") assert.equal(new TextDecoder().decode(body.body), "hi");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        testLayer((_authorization, request) => {
          requests.push(request);
          return request.method === "POST"
            ? Response.json({
                data: {
                  result: {
                    success: true,
                    uploadFile: {
                      uploadUrl: "https://storage.example.test/signed",
                      assetUrl: "https://uploads.linear.app/proof.txt",
                      headers: [{ key: "x-upload-proof", value: "signed" }],
                    },
                  },
                },
              })
            : new Response(null, { status: 200 });
        }),
      ),
    );
  },
);
it.effect("rejects malformed upload bytes before requesting storage", () => {
  let calls = 0;
  return Effect.gen(function* () {
    const service = yield* Linear.LinearService;
    const error = yield* service
      .upload({ filename: "proof.txt", contentType: "text/plain", base64: "not-base64" })
      .pipe(Effect.flip);
    assert.equal(error.reason, "invalid-response");
    assert.equal(calls, 0);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      testLayer(() => {
        calls++;
        return new Response(null, { status: 500 });
      }),
    ),
  );
});

it.effect.each([4, 8])("uploads a valid %s MiB file without a validator defect", (mebibytes) => {
  const size = mebibytes * 1024 * 1024;
  const bytes = NodeBuffer.Buffer.alloc(size, 42);
  let ticketRequested = false;
  let uploaded = false;
  return Effect.gen(function* () {
    const service = yield* Linear.LinearService;
    yield* service.upload({
      filename: "proof.bin",
      contentType: "application/octet-stream",
      base64: bytes.toString("base64"),
    });
    assert.isTrue(ticketRequested);
    assert.isTrue(uploaded);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      testLayer((_authorization, request) => {
        if (request.method === "POST") {
          ticketRequested = true;
          assert.equal(request.body._tag, "Uint8Array");
          if (request.body._tag === "Uint8Array") {
            const payload = JSON.parse(new TextDecoder().decode(request.body.body));
            assert.equal(payload.variables.size, size);
          }
          return Response.json({
            data: {
              result: {
                success: true,
                uploadFile: {
                  uploadUrl: "https://storage.example.test/signed",
                  assetUrl: "https://uploads.linear.app/proof.bin",
                  headers: [],
                },
              },
            },
          });
        }
        uploaded = true;
        assert.equal(request.body._tag, "Uint8Array");
        if (request.body._tag === "Uint8Array") {
          assert.equal(request.body.body.length, size);
          assert.deepEqual(request.body.body, bytes);
        }
        return new Response(null, { status: 200 });
      }),
    ),
  );
});

it.effect("rejects decoded uploads over 8 MiB before requesting storage", () => {
  let calls = 0;
  return Effect.gen(function* () {
    const service = yield* Linear.LinearService;
    const error = yield* service
      .upload({
        filename: "too-large.bin",
        contentType: "application/octet-stream",
        base64: NodeBuffer.Buffer.alloc(8 * 1024 * 1024 + 1, 42).toString("base64"),
      })
      .pipe(Effect.flip);
    assert.equal(error.reason, "invalid-response");
    assert.equal(calls, 0);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      testLayer(() => {
        calls++;
        return new Response(null, { status: 500 });
      }),
    ),
  );
});
