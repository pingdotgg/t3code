import { afterEach, describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import { DeviceId, ProjectId, ThreadId, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DeviceAgentAccess from "./DeviceAgentAccess.ts";
import * as DeviceService from "./DeviceService.ts";
import * as AgentDeviceProxy from "./AgentDeviceProxy.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const fixture = () => {
  let readinessGate: Effect.Effect<void> = Effect.void;
  let readinessAvailable = true;
  let permitted = true;
  let support = true;
  let threadState: "present" | "deleted" | "missing" = "present";
  let projectState: "present" | "deleted" | "missing" = "present";
  let origin = "http://local-daemon.example";
  let now = 0;
  let artifactIds: ReadonlyArray<string> | undefined;
  const requests: Array<{
    url: string;
    token: string | undefined;
    headers: Readonly<Record<string, string>>;
  }> = [];
  const hostRequests: string[] = [];
  const payloads: Array<Record<string, unknown>> = [];
  const attempts = new Map<string, string>();
  let uploaded = 0;
  let cachedUploadId: string | undefined;
  let directUploadStatus = 200;
  let ndjson = false;
  let rpcStream: ReadableStream<Uint8Array> | undefined;
  let retireOnDiscovery = false;
  let retireDiscoveredDevice: (hostId: string) => Effect.Effect<void> = () => Effect.void;
  const project = ProjectId.make("project-1");
  const access = DeviceAgentAccess.layer.pipe(
    Layer.provide(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadShell: (id) =>
          Effect.sync(() =>
            threadState === "missing" && id !== "thread-2"
              ? null
              : ({
                  projectId: id === "thread-2" ? ProjectId.make("project-2") : project,
                  deletedAt: threadState === "deleted" && id !== "thread-2" ? "2026-01-01" : null,
                } as NonNullable<
                  Effect.Success<
                    ReturnType<ProjectionStore.ProjectionStoreV2["Service"]["getThreadShell"]>
                  >
                >),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: (id) =>
          Effect.sync(() =>
            projectState === "missing" && id === project
              ? Option.none()
              : Option.some({
                  deletedAt: projectState === "deleted" && id === project ? "2026-01-01" : null,
                } as ProjectStore.ProjectRow),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.sync(() => ({
          ...DEFAULT_SERVER_SETTINGS,
          enableDeviceSupport: support,
          enableAgentDeviceAccess: false,
          projectSettingsOverrides: {
            [project]: { enableAgentDeviceAccess: permitted },
            "project-2": { enableAgentDeviceAccess: true },
          },
        })),
      }),
    ),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(
      Layer.succeed(Clock.Clock, {
        ...Clock.Clock.defaultValue(),
        currentTimeMillisUnsafe: () => now,
      }),
    ),
  );
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push({
        url: request.url,
        token: request.headers["x-agent-device-token"],
        headers: request.headers,
      });
      const payload =
        request.body._tag === "Uint8Array"
          ? (JSON.parse(new TextDecoder().decode(request.body.body)) as Record<string, unknown>)
          : undefined;
      if (payload) payloads.push(payload);
      let body = "ok";
      let contentType = "text/plain";
      if (request.url.endsWith("/upload/preflight")) {
        const attempt = String(payload?.uploadAttemptId);
        const id = cachedUploadId ?? attempts.get(attempt) ?? `upload-${attempts.size + 1}`;
        attempts.set(attempt, id);
        body = JSON.stringify({
          ok: true,
          uploadId: id,
          cacheHit: cachedUploadId !== undefined,
          upload: {
            url: `${origin}/upload/direct/${id}`,
            headers: {
              authorization: "Bearer raw-daemon-token",
              "x-agent-device-token": "raw-daemon-token",
              "content-type": "application/zip",
            },
          },
        });
      } else if (request.url.endsWith("/upload") || request.url.endsWith("/upload/finalize")) {
        body = JSON.stringify({ ok: true, uploadId: `uploaded-${++uploaded}` });
      } else if (request.url.endsWith("/rpc")) {
        const params = payload?.params as { session: string };
        const response = {
          jsonrpc: "2.0",
          id: "request-1",
          result: {
            ok: true,
            data: {
              artifacts: (
                artifactIds ?? [params.session === "session-thread-2" ? "artifact-2" : "artifact-1"]
              ).map((artifactId) => ({
                artifactId,
                field: "path",
                fileName: "screenshot.png",
              })),
            },
          },
        };
        body = ndjson
          ? `${JSON.stringify({ type: "progress", event: { message: "Capturing" } })}\n${JSON.stringify({ type: "response", response })}\n`
          : JSON.stringify(response);
        contentType = ndjson ? "application/x-ndjson" : "application/json";
      } else if (request.url.endsWith("/artifacts") || request.url.endsWith("/artifacts/")) {
        body = JSON.stringify({
          artifacts: [
            { id: "artifact-1", filename: "one.png" },
            { id: "artifact-2", filename: "two.png" },
            { id: "external-artifact", filename: "outside.png" },
          ],
        });
      }
      return HttpClientResponse.fromWeb(
        request,
        new Response(request.url.endsWith("/rpc") && rpcStream ? rpcStream : body, {
          status: request.url.includes("/upload/direct/")
            ? directUploadStatus
            : request.url.includes("/artifacts/") && request.headers.range
              ? 206
              : 200,
          headers: {
            "content-type": contentType,
            ...(request.url.includes("/artifacts/") && request.headers.range
              ? { "content-range": "bytes 0-1/8" }
              : {}),
          },
        }),
      );
    }),
  );
  const issueRoute = HttpRouter.add(
    "POST",
    "/issue",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = HttpServerRequest.toURL(request);
      const service = yield* DeviceAgentAccess.DeviceAgentAccess;
      retireDiscoveredDevice = (hostId) => service.retireDevice(hostId, DeviceId.make("device-1"));
      const threadId = ThreadId.make(
        Option.isSome(url) ? (url.value.searchParams.get("thread") ?? "thread-1") : "thread-1",
      );
      return yield* HttpServerResponse.json({
        token: yield* service.issue({
          threadId,
          hostId: "host-1",
          deviceId: DeviceId.make("device-1"),
          session: `session-${threadId}`,
        }),
      });
    }).pipe(
      Effect.catchTags({
        DeviceAgentAccessDenied: () =>
          Effect.succeed(HttpServerResponse.text("Forbidden", { status: 403 })),
      }),
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    Layer.mergeAll(
      AgentDeviceProxy.layer,
      issueRoute,
      HttpRouter.add(
        "POST",
        "/retire-host",
        Effect.gen(function* () {
          const access = yield* DeviceAgentAccess.DeviceAgentAccess;
          yield* access.retireHost("host-1");
          return HttpServerResponse.empty();
        }),
      ),
    ).pipe(
      Layer.provideMerge(access),
      Layer.provideMerge(
        Layer.mock(DeviceService.DeviceService)({
          refreshAgentDevice: (ready) =>
            Effect.suspend(() =>
              retireOnDiscovery ? retireDiscoveredDevice(ready.hostId) : Effect.void,
            ),
          agentReadinessIfSupported: (host) =>
            readinessGate.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  hostRequests.push(host ?? "local");
                  if (!readinessAvailable) return null;
                  return {
                    hostId: host,
                    agentDevice: { baseUrl: origin, token: "raw-daemon-token" },
                  } as DeviceService.DeviceAgentReadiness;
                }),
              ),
            ),
        }),
      ),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  const issueResponse = (thread = "thread-1") =>
    handler(new Request(`http://t3.example/issue?thread=${thread}`, { method: "POST" }));
  const issue = async (thread = "thread-1") => {
    const response = await issueResponse(thread);
    return ((await response.json()) as { token: string }).token;
  };
  const call = (token: string, path = "/rpc", method = "POST", body?: string) =>
    handler(
      new Request(`http://t3.example/api/agent-device${path}`, {
        method,
        headers: {
          host: "t3.example",
          "x-agent-device-token": token,
          "content-type": "application/json",
        },
        ...(method === "GET"
          ? {}
          : {
              body:
                body ??
                (path === "/upload/preflight"
                  ? JSON.stringify({
                      uploadAttemptId: "attempt-1",
                      sha256: "0".repeat(64),
                      fileName: "app.zip",
                      sizeBytes: 5,
                      artifactType: "file",
                    })
                  : path === "/upload/finalize"
                    ? JSON.stringify({ uploadId: "upload-1" })
                    : JSON.stringify({
                        jsonrpc: "2.0",
                        id: "request-1",
                        method: "agent_device.command",
                        params: {
                          session: "session-thread-1",
                          command: "snapshot",
                          flags: { udid: "device-1" },
                        },
                      })),
            }),
      }),
    );
  return {
    issue,
    issueResponse,
    call,
    handler,
    pauseReadiness: (gate: Effect.Effect<void>) => {
      readinessGate = gate;
    },
    noReadiness: () => {
      readinessAvailable = false;
    },
    retireHost: () => handler(new Request("http://t3.example/retire-host", { method: "POST" })),
    retireOnDiscovery: () => {
      retireOnDiscovery = true;
    },
    requests,
    hostRequests,
    payloads,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    directUploadStatus: (status: number) => {
      directUploadStatus = status;
    },
    cachedUpload: (id: string) => {
      cachedUploadId = id;
    },
    artifacts: (ids: ReadonlyArray<string>) => {
      artifactIds = ids;
    },
    capture: (token: string, session = "session-thread-1") =>
      call(
        token,
        "/rpc",
        "POST",
        JSON.stringify({
          jsonrpc: "2.0",
          id: "request-1",
          method: "agent_device.command",
          params: { session, command: "snapshot", flags: { udid: "device-1" } },
        }),
      ),
    streamRpc: (stream: ReadableStream<Uint8Array>) => {
      rpcStream = stream;
      ndjson = true;
    },
    ndjson: () => {
      ndjson = true;
    },
    revoke: () => {
      permitted = false;
    },
    grant: () => {
      permitted = true;
    },
    disable: () => {
      support = false;
    },
    thread: (value: typeof threadState) => {
      threadState = value;
    },
    project: (value: typeof projectState) => {
      projectState = value;
    },
    remote: () => {
      origin = "http://ssh-forward.example";
    },
  };
};

describe("thread-scoped device CLI proxy", () => {
  effectIt.effect(
    "denies a retired host credential that was waiting for replacement readiness",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const token = yield* Effect.promise(() => f.issue());
        const started = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        f.pauseReadiness(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(resume)),
            Effect.asVoid,
          ),
        );
        const pending = f.call(token);
        yield* Deferred.await(started);
        yield* Effect.promise(() => f.retireHost());
        const fresh = yield* Effect.promise(() => f.issue());
        expect(fresh).not.toBe(token);
        f.remote();
        yield* Deferred.succeed(resume, undefined);
        expect((yield* Effect.promise(() => pending)).status).toBe(403);
        expect(f.requests).toHaveLength(0);
        expect((yield* Effect.promise(() => f.call(fresh))).status).toBe(200);
        expect(f.requests).toHaveLength(1);
      }),
  );
  it("rechecks a copied credential after project revocation without touching unrelated access", async () => {
    const f = fixture();
    const token = await f.issue();
    const other = await f.issue("thread-2");
    expect((await f.call(token)).status).toBe(200);
    expect(f.requests).toMatchObject([
      { url: "http://local-daemon.example/rpc", token: "raw-daemon-token" },
    ]);
    f.revoke();
    for (const [path, method] of [
      ["/rpc", "POST"],
      ["/health", "GET"],
      ["/upload/preflight", "POST"],
      ["/upload/direct/upload-1", "PUT"],
      ["/artifacts/artifact-1", "GET"],
    ])
      expect((await f.call(token, path, method)).status).toBe(403);
    expect(f.requests).toHaveLength(1);
    expect(f.hostRequests).toHaveLength(1);
    expect((await f.call(other, "/health", "GET")).status).toBe(200);
    expect(f.requests).toHaveLength(2);
  });
  it.each(["missing", "deleted"] as const)(
    "denies %s threads and projects before forwarding",
    async (state) => {
      const f = fixture();
      const token = await f.issue();
      f.thread(state);
      expect((await f.call(token)).status).toBe(403);
      f.thread("present");
      const projectToken = await f.issue();
      f.project(state);
      expect((await f.call(projectToken)).status).toBe(403);
      expect(f.requests).toEqual([]);
    },
  );
  it("denies disabled support and refuses another session or device", async () => {
    const f = fixture();
    const token = await f.issue();
    for (const params of [
      { session: "other", command: "snapshot" },
      { session: "session-thread-1", command: "open", flags: { udid: "another-device" } },
    ])
      expect(
        (
          await f.call(
            token,
            "/rpc",
            "POST",
            JSON.stringify({ jsonrpc: "2.0", method: "agent_device.command", params }),
          )
        ).status,
      ).toBe(403);
    f.disable();
    expect((await f.call(token)).status).toBe(403);
    expect(f.requests).toEqual([]);
  });
  it("keeps SSH upload URLs and credentials behind the proxy through upload and artifact download", async () => {
    const f = fixture();
    f.remote();
    const token = await f.issue();
    const response = await f.call(token, "/upload/preflight");
    const body = await response.text();
    expect(body).not.toContain("raw-daemon-token");
    expect(body).not.toContain("ssh-forward.example");
    const descriptor = JSON.parse(body) as {
      upload: { url: string; headers: Record<string, string> };
    };
    expect(descriptor.upload.url).toBe("http://t3.example/api/agent-device/upload/direct/upload-1");
    expect(
      (
        await f.handler(
          new Request(descriptor.upload.url, {
            method: "PUT",
            headers: descriptor.upload.headers,
            body: "bytes",
          }),
        )
      ).status,
    ).toBe(200);
    await (await f.call(token)).text();
    for (const [path, method] of [
      ["/upload", "POST"],
      ["/upload/finalize", "POST"],
      ["/artifacts", "GET"],
      ["/artifacts/artifact-1", "GET"],
      ["/sessions/session-thread-1/requests/request-1/diagnostics", "GET"],
    ])
      expect((await f.call(token, path, method)).status).toBe(200);
    expect(
      f.requests.every(
        (r) => r.url.startsWith("http://ssh-forward.example/") && r.token === "raw-daemon-token",
      ),
    ).toBe(true);
  });
});

it.each(["agent_device.command", "agent-device.command"])(
  "rejects CLI power-off through %s before contacting the host",
  async (method) => {
    const f = fixture();
    const token = await f.issue();
    const rpc = (
      command: string,
      flags: Record<string, unknown>,
      positionals: string[] = [],
      input?: Record<string, unknown>,
    ) =>
      f.call(
        token,
        "/rpc",
        "POST",
        JSON.stringify({
          jsonrpc: "2.0",
          method,
          params: { session: "session-thread-1", command, flags, positionals, input },
        }),
      );
    for (const selector of [{ udid: "device-1" }, { serial: "device-1" }]) {
      for (const command of ["close", "shutdown"]) {
        const denied = await rpc(command, { ...selector, shutdown: true }, ["test.app"]);
        expect(denied.status).toBe(403);
        expect(await denied.text()).toContain("device_close with shutdown=true");
      }
    }
    for (const command of ["shutdown", "replay", "test"])
      expect((await rpc(command, { serial: "device-1" })).status).toBe(403);
    for (const step of [
      { command: "shutdown" },
      { command: "close", flags: { shutdown: true } },
      { command: " CLoSE ", input: { shutdown: true } },
      { command: "replay" },
      { command: "test" },
      { command: "batch" },
    ])
      expect((await rpc("batch", { serial: "device-1", batchSteps: [step] })).status).toBe(403);
    expect(
      (
        await rpc("batch", {
          serial: "device-1",
          shutdown: true,
          batchSteps: [{ command: "close" }],
        })
      ).status,
    ).toBe(403);
    expect((await rpc("batch", { serial: "device-1", batchSteps: "invalid" })).status).toBe(403);
    for (const selectors of [
      { udid: "device-2" },
      { serial: "device-2" },
      { deviceId: "device-2" },
      { device: "Another emulator" },
      { device: "device-1" },
    ]) {
      for (const step of [
        { command: "boot", flags: selectors },
        { command: "boot", input: selectors },
      ])
        expect((await rpc("batch", { serial: "device-1", batchSteps: [step] })).status).toBe(403);
      expect((await rpc("boot", { serial: "device-1" }, [], selectors)).status).toBe(403);
      expect((await rpc("boot", { serial: "device-1", ...selectors })).status).toBe(403);
    }
    expect((await rpc("close", { serial: "device-1" }, [], { shutdown: true })).status).toBe(403);
    expect(f.requests).toEqual([]);
    expect(f.hostRequests).toEqual([]);
    for (const flags of [{ udid: "device-1" }, { serial: "device-1", shutdown: false }])
      expect((await rpc("close", flags)).status).toBe(200);
    expect(
      (
        await rpc("batch", {
          serial: "device-1",
          batchSteps: [
            { command: "snapshot" },
            { command: "boot", flags: { serial: "device-1" } },
            { command: "close", flags: { shutdown: false } },
          ],
        })
      ).status,
    ).toBe(200);
    expect((await rpc("snapshot", { udid: "device-1" })).status).toBe(200);
  },
);

it("reports revoked access after a delayed request body and unavailable helper", async () => {
  const f = fixture();
  const token = await f.issue();
  const reading = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const body = new ReadableStream<Uint8Array>(
    {
      pull: async (controller) => {
        reading.resolve();
        await resume.promise;
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "agent_device.command",
              params: {
                session: "session-thread-1",
                command: "snapshot",
                flags: { udid: "device-1" },
              },
            }),
          ),
        );
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: { "x-agent-device-token": token, "content-type": "application/json" },
    body,
    duplex: "half",
  };
  const pending = f.handler(new Request("http://t3.example/api/agent-device/rpc", init));
  await reading.promise;
  f.revoke();
  f.noReadiness();
  resume.resolve();
  expect((await pending).status).toBe(403);
  expect(f.requests).toEqual([]);
});

it("rejects a retained credential when fresh discovery retires its device", async () => {
  const f = fixture();
  const token = await f.issue();
  f.retireOnDiscovery();
  const denied = await f.call(token);
  expect(denied.status).toBe(403);
  expect(f.requests).toEqual([]);
  expect((await f.call(token, "/health", "GET")).status).toBe(403);
});

it("requires a concrete issued selector for commands while allowing device inventory", async () => {
  const f = fixture();
  const token = await f.issue();
  const rpc = (command: string, flags: Record<string, unknown>, method = "agent_device.command") =>
    f.call(
      token,
      "/rpc",
      "POST",
      JSON.stringify({
        jsonrpc: "2.0",
        method,
        params: { session: "session-thread-1", command, flags },
      }),
    );
  for (const flags of [
    {},
    { platform: "ios" },
    { device: "another-device" },
    { deviceId: "device-1" },
    { udid: "another-device" },
    { udid: "device-1", serial: "another-device" },
  ])
    expect((await rpc("open", flags)).status).toBe(403);
  expect(
    (await rpc("devices", { udid: "device-1" }, "agent_device.install_from_source")).status,
  ).toBe(403);
  expect(f.requests).toEqual([]);
  expect(f.hostRequests).toEqual([]);
  for (const method of ["agent_device.command", "agent-device.command"]) {
    expect((await rpc("devices", { platform: "ios" }, method)).status).toBe(200);
    expect((await rpc("snapshot", { platform: "ios", udid: "device-1" }, method)).status).toBe(200);
    expect(
      (await rpc("snapshot", { platform: "android", serial: "device-1" }, method)).status,
    ).toBe(200);
  }
});

it.each(["request", "issuance"])(
  "reuses a credential and discards it when revocation is observed during %s",
  async (observation) => {
    const f = fixture();
    const tokens = await Promise.all(Array.from({ length: 12 }, () => f.issue()));
    const token = tokens[0]!;
    expect(new Set(tokens).size).toBe(1);
    const other = await f.issue("thread-2");
    expect(other).not.toBe(token);
    f.revoke();
    const denied =
      observation === "request" ? await f.call(token, "/health", "GET") : await f.issueResponse();
    expect(denied.status).toBe(403);
    expect(f.requests).toEqual([]);
    f.grant();
    const replacement = await f.issue();
    expect(replacement).not.toBe(token);
    expect((await f.call(token, "/health", "GET")).status).toBe(403);
    expect((await f.call(replacement, "/health", "GET")).status).toBe(200);
    expect((await f.call(other, "/health", "GET")).status).toBe(200);
  },
);

it("preserves partial-download status and content-range for an owned artifact", async () => {
  const f = fixture();
  const token = await f.issue();
  await (await f.call(token)).text();
  const response = await f.handler(
    new Request("http://t3.example/api/agent-device/artifacts/artifact-1", {
      headers: { "x-agent-device-token": token, range: "bytes=0-1" },
    }),
  );
  expect(response.status).toBe(206);
  expect(response.headers.get("content-range")).toBe("bytes 0-1/8");
  expect(await response.text()).toBe("ok");
});

it("expires uploaded resources and screenshots at the daemon's respective lifetimes", async () => {
  const f = fixture();
  const token = await f.issue();
  await (await f.call(token)).text();
  await (await f.call(token, "/upload/preflight")).text();
  f.advance(5 * 60_000);
  expect((await f.call(token, "/upload/direct/upload-1", "PUT", "bytes")).status).toBe(403);
  expect((await f.call(token, "/artifacts/artifact-1", "GET")).status).toBe(200);
  f.advance(10 * 60_000);
  expect((await f.call(token, "/artifacts/artifact-1", "GET")).status).toBe(403);
  const other = await f.issue("thread-2");
  f.artifacts(["artifact-1"]);
  await (await f.capture(other, "session-thread-2")).text();
  expect((await f.call(other, "/artifacts/artifact-1", "GET")).status).toBe(200);
});

effectIt.effect.each(["download", "direct upload", "finalize", "install"] as const)(
  "rechecks %s ownership after delayed readiness",
  (operation) =>
    Effect.gen(function* () {
      const f = fixture();
      const owner = yield* Effect.promise(() => f.issue());
      const other = yield* Effect.promise(() => f.issue("thread-2"));
      const download = operation === "download";
      yield* Effect.promise(async () => {
        await (await (download ? f.capture(owner) : f.call(owner, "/upload/preflight"))).text();
      });
      const started = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      f.pauseReadiness(
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(resume)),
          Effect.asVoid,
        ),
      );
      const pending =
        operation === "download"
          ? f.call(owner, "/artifacts/artifact-1", "GET")
          : operation === "direct upload"
            ? f.call(owner, "/upload/direct/upload-1", "PUT", "bytes")
            : operation === "finalize"
              ? f.call(owner, "/upload/finalize")
              : f.call(
                  owner,
                  "/rpc",
                  "POST",
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: "install-1",
                    method: "agent_device.command",
                    params: {
                      session: "session-thread-1",
                      command: "install",
                      flags: { udid: "device-1" },
                      meta: { uploadedArtifactId: "upload-1" },
                    },
                  }),
                );
      yield* Deferred.await(started);
      f.advance((download ? 15 : 5) * 60_000);
      f.pauseReadiness(Effect.void);
      f.artifacts(["artifact-1"]);
      f.cachedUpload("upload-1");
      yield* Effect.promise(async () => {
        await (
          await (download
            ? f.capture(other, "session-thread-2")
            : f.call(other, "/upload/preflight"))
        ).text();
      });
      const forwarded = f.requests.length;
      yield* Deferred.succeed(resume, undefined);
      expect((yield* Effect.promise(() => pending)).status).toBe(403);
      expect(f.requests).toHaveLength(forwarded);
      expect(
        (yield* Effect.promise(() =>
          download
            ? f.call(other, "/artifacts/artifact-1", "GET")
            : f.call(other, "/upload/direct/upload-1", "PUT", "bytes"),
        )).status,
      ).toBe(200);
    }),
);

it.each([200, 308])("keeps ownership for an upload progressing with status %s", async (status) => {
  const f = fixture();
  const token = await f.issue();
  f.directUploadStatus(status);
  await (await f.call(token, "/upload/preflight")).text();
  f.advance(4 * 60_000);
  const chunk = await f.call(token, "/upload/direct/upload-1", "PUT", "bytes");
  expect(chunk.status).toBe(status);
  await chunk.text();
  f.advance(2 * 60_000);
  expect((await f.call(token, "/upload/finalize")).status).toBe(200);
});

it("releases resource ownership when the credential is discarded", async () => {
  const f = fixture();
  const token = await f.issue();
  await (await f.call(token)).text();
  f.revoke();
  expect((await f.call(token, "/health", "GET")).status).toBe(403);
  const other = await f.issue("thread-2");
  f.artifacts(["artifact-1"]);
  await (await f.capture(other, "session-thread-2")).text();
  expect((await f.call(other, "/artifacts/artifact-1", "GET")).status).toBe(200);
});

it("bounds retained resource ownership even within one active capture session", async () => {
  const f = fixture();
  const token = await f.issue();
  f.artifacts(Array.from({ length: 4097 }, (_, index) => `capture-${index}`));
  await (await f.capture(token)).text();
  expect((await f.call(token, "/artifacts/capture-0", "GET")).status).toBe(403);
  expect((await f.call(token, "/artifacts/capture-4096", "GET")).status).toBe(200);
});

it("removes hop-by-hop request headers while retaining upload range metadata", async () => {
  const f = fixture();
  const token = await f.issue();
  const response = await f.handler(
    new Request("http://t3.example/api/agent-device/rpc", {
      method: "POST",
      headers: {
        "x-agent-device-token": token,
        connection: "keep-alive, X-Internal-Hop",
        "x-internal-hop": "private",
        "keep-alive": "timeout=5",
        "transfer-encoding": "chunked",
        te: "trailers",
        trailer: "checksum",
        "proxy-authorization": "Bearer proxy-only",
        "proxy-connection": "keep-alive",
        "content-range": "bytes 0-1/8",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "request-1",
        method: "agent_device.command",
        params: {
          session: "session-thread-1",
          command: "snapshot",
          flags: { udid: "device-1" },
        },
      }),
    }),
  );
  expect(response.status).toBe(200);
  await response.text();
  const forwarded = f.requests[0]!.headers;
  for (const name of [
    "connection",
    "x-internal-hop",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "proxy-authorization",
    "proxy-connection",
  ])
    expect(forwarded[name]).toBeUndefined();
  expect(forwarded["content-range"]).toBe("bytes 0-1/8");
  expect(forwarded["x-agent-device-token"]).toBe("raw-daemon-token");
});

it.each([false, true])(
  "isolates artifact listings and downloads from %s NDJSON RPC results",
  async (ndjson) => {
    const f = fixture();
    if (ndjson) f.ndjson();
    const owner = await f.issue();
    const other = await f.issue("thread-2");
    expect(await (await f.call(other, "/artifacts", "GET")).json()).toEqual({ artifacts: [] });
    const ownerResult = await (await f.call(owner)).text();
    expect(ownerResult).toContain("artifact-1");
    if (ndjson) expect(ownerResult).toContain('"type":"progress"');
    const otherRpc = JSON.stringify({
      jsonrpc: "2.0",
      id: "request-2",
      method: "agent_device.command",
      params: {
        session: "session-thread-2",
        command: "screenshot",
        flags: { udid: "device-1" },
      },
    });
    await (await f.call(other, "/rpc", "POST", otherRpc)).text();
    expect(await (await f.call(owner, "/artifacts", "GET")).json()).toEqual({
      artifacts: [{ id: "artifact-1", filename: "one.png" }],
    });
    expect(await (await f.call(other, "/artifacts/", "GET")).json()).toEqual({
      artifacts: [{ id: "artifact-2", filename: "two.png" }],
    });
    const forwards = f.requests.length;
    const readiness = f.hostRequests.length;
    for (const id of ["artifact-1", "artifact%2D1", "external-artifact", "unknown"])
      expect((await f.call(other, `/artifacts/${id}`, "GET")).status).toBe(403);
    expect(f.requests).toHaveLength(forwards);
    expect(f.hostRequests).toHaveLength(readiness);
    expect((await f.call(owner, "/artifacts/artifact-1", "GET")).status).toBe(200);
    expect((await f.call(other, "/artifacts/artifact-2", "GET")).status).toBe(200);
  },
);

it("isolates direct upload, finalize, and installed upload references across sessions", async () => {
  const f = fixture();
  const owner = await f.issue();
  const other = await f.issue("thread-2");
  const first = (await (await f.call(owner, "/upload/preflight")).json()) as { uploadId: string };
  const second = (await (await f.call(other, "/upload/preflight")).json()) as { uploadId: string };
  expect(first.uploadId).toBe("upload-1");
  expect(second.uploadId).toBe("upload-2");
  expect(f.payloads[0]?.uploadAttemptId).not.toEqual(f.payloads[1]?.uploadAttemptId);
  const count = f.requests.length;
  const readiness = f.hostRequests.length;
  expect((await f.call(other, "/upload/direct/upload-1", "PUT", "bytes")).status).toBe(403);
  expect(
    (await f.call(other, "/upload/finalize", "POST", JSON.stringify({ uploadId: first.uploadId })))
      .status,
  ).toBe(403);
  expect(f.requests).toHaveLength(count);
  expect(f.hostRequests).toHaveLength(readiness);
  expect((await f.call(owner, "/upload/direct/upload-1", "PUT", "bytes")).status).toBe(200);
  const finalized = (await (await f.call(owner, "/upload/finalize")).json()) as {
    uploadId: string;
  };
  const legacy = (await (await f.call(owner, "/upload", "POST", "bytes")).json()) as {
    uploadId: string;
  };
  const install = (session: string, uploadId: string) =>
    JSON.stringify({
      jsonrpc: "2.0",
      method: "agent_device.command",
      params: {
        session,
        command: "install",
        flags: { udid: "device-1" },
        meta: { uploadedArtifactId: uploadId },
      },
    });
  const afterUploads = f.requests.length;
  for (const id of [finalized.uploadId, legacy.uploadId, "unknown-upload"])
    expect((await f.call(other, "/rpc", "POST", install("session-thread-2", id))).status).toBe(403);
  expect(f.requests).toHaveLength(afterUploads);
  expect(
    (await f.call(owner, "/rpc", "POST", install("session-thread-1", finalized.uploadId))).status,
  ).toBe(200);
  expect(
    (await f.call(owner, "/rpc", "POST", install("session-thread-1", legacy.uploadId))).status,
  ).toBe(200);
  expect((await f.call(other, "/upload/direct/upload-2", "PUT", "bytes")).status).toBe(200);
});

it("forwards progress immediately and registers artifacts before forwarding the final RPC response", async () => {
  const f = fixture();
  const token = await f.issue();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  f.streamRpc(
    new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    }),
  );
  controller.enqueue(encoder.encode('{"type":"progress","event":{"message":"Capturing"}}\n'));
  const response = await f.call(token);
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain('"type":"progress"');
  expect(await f.issue()).toBe(token);
  expect((await f.call(token, "/artifacts/artifact-1", "GET")).status).toBe(403);
  const final = encoder.encode(
    JSON.stringify({
      type: "response",
      response: {
        jsonrpc: "2.0",
        result: { ok: true, data: { artifacts: [{ artifactId: "artifact-1", field: "path" }] } },
      },
    }) + "\n",
  );
  controller.enqueue(final.slice(0, 17));
  controller.enqueue(final.slice(17));
  controller.close();
  const last = await reader.read();
  expect(new TextDecoder().decode(last.value)).toContain('"artifactId":"artifact-1"');
  expect((await f.call(token, "/artifacts/artifact-1", "GET")).status).toBe(200);
  await reader.read();
});
