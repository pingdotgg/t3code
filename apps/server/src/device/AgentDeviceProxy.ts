/** Keeps the shared daemon credential behind thread consent for every CLI request. */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as DeviceAgentAccess from "./DeviceAgentAccess.ts";
import * as DeviceService from "./DeviceService.ts";

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const RpcRequest = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optional(Schema.Unknown),
  method: Schema.String,
  params: JsonObject,
});
const UploadDescriptor = Schema.Struct({
  ok: Schema.Boolean,
  uploadId: Schema.String,
  cacheHit: Schema.Boolean,
  upload: Schema.optional(
    Schema.Struct({ url: Schema.String, headers: Schema.Record(Schema.String, Schema.String) }),
  ),
});
const UploadResult = Schema.Struct({ ok: Schema.Boolean, uploadId: Schema.String });
const ArtifactResult = Schema.Struct({
  ok: Schema.Literal(true),
  data: Schema.Struct({ artifacts: Schema.Array(Schema.Struct({ artifactId: Schema.String })) }),
});
const decodeRpcArtifacts = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ result: ArtifactResult }),
      Schema.Struct({
        type: Schema.Literal("response"),
        response: Schema.Struct({ result: ArtifactResult }),
      }),
    ]),
  ),
);
const decodeInventory = Schema.decodeUnknownEffect(
  Schema.Struct({ artifacts: Schema.Array(JsonObject) }),
);
const encodeUploadAttempt = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.String, Schema.String])),
);
const decodeUploadResult = Schema.decodeUnknownEffect(UploadResult);
const decodeRpcRequest = Schema.decodeUnknownEffect(RpcRequest);
const decodeObject = Schema.decodeUnknownEffect(JsonObject);
const decodeUploadDescriptor = Schema.decodeUnknownEffect(UploadDescriptor);
const decodeBatchSteps = Schema.decodeUnknownOption(
  Schema.Array(
    Schema.Struct({
      command: Schema.String,
      flags: Schema.optional(JsonObject),
      input: Schema.optional(JsonObject),
    }),
  ),
);
const requiresDeviceLifecycle = (command: unknown, shutdown: unknown) => {
  const name = typeof command === "string" ? command.trim().toLowerCase() : "";
  // Replay/test scripts hide their actions from this scoped adapter.
  return ["shutdown", "replay", "test"].includes(name) || (name === "close" && shutdown === true);
};
const targetsAnotherDevice = (
  selectors: Readonly<Record<string, unknown>> | undefined,
  deviceId: string,
) =>
  selectors?.device !== undefined ||
  [selectors?.udid, selectors?.serial, selectors?.deviceId].some(
    (id) => id !== undefined && id !== deviceId,
  );
const DROPPED_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-connection",
  "cookie",
  "authorization",
  "x-agent-device-token",
  "content-length",
  "accept-encoding",
  "origin",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const path = url.value.pathname.slice(DeviceAgentAccess.AGENT_DEVICE_ROUTE_PREFIX.length);
  const allowed =
    request.method === "GET"
      ? /^\/(health|artifacts\/?|artifacts\/[^/]+|sessions\/[^/]+\/requests\/[^/]+\/diagnostics)$/.test(
          path,
        )
      : request.method === "POST"
        ? /^\/(rpc|upload|upload\/preflight|upload\/finalize)$/.test(path)
        : request.method === "PUT" && /^\/upload\/direct\/[^/]+$/.test(path);
  if (!allowed) return HttpServerResponse.text("Not Found", { status: 404 });
  const token =
    request.headers["x-agent-device-token"] ??
    request.headers.authorization?.replace(/^Bearer /i, "") ??
    "";
  const access = yield* DeviceAgentAccess.DeviceAgentAccess;
  const downloadId =
    path.startsWith("/artifacts/") && path !== "/artifacts/"
      ? decodeURIComponent(path.slice("/artifacts/".length))
      : undefined;
  const directUploadId = path.startsWith("/upload/direct/")
    ? decodeURIComponent(path.slice("/upload/direct/".length))
    : undefined;
  let resource =
    downloadId !== undefined
      ? { kind: "artifact" as const, id: downloadId }
      : directUploadId !== undefined
        ? { kind: "upload" as const, id: directUploadId }
        : undefined;
  const target = yield* access.authorize(token, resource);
  if (path.startsWith("/sessions/") && path.split("/")[2] !== encodeURIComponent(target.session))
    return HttpServerResponse.text("Forbidden", { status: 403 });
  const rpc = path === "/rpc" ? yield* decodeRpcRequest(yield* request.json) : undefined;
  let uploadBody =
    path === "/upload/preflight" || path === "/upload/finalize"
      ? yield* decodeObject(yield* request.json)
      : undefined;
  if (rpc) {
    // The CLI uses command RPCs. Other daemon methods can ignore flags and
    // select a device independently, so they cannot use this scoped credential.
    if (rpc.method !== "agent_device.command" && rpc.method !== "agent-device.command")
      return HttpServerResponse.text("Forbidden", { status: 403 });
    if (rpc.params.session !== target.session)
      return HttpServerResponse.text("Forbidden", { status: 403 });
    const meta = yield* decodeObject(rpc.params.meta ?? {});
    if (meta.uploadedArtifactId !== undefined) {
      if (typeof meta.uploadedArtifactId !== "string")
        return HttpServerResponse.text("Bad Request", { status: 400 });
      resource = { kind: "upload", id: meta.uploadedArtifactId };
      yield* access.authorize(token, resource);
    }
    const flags = yield* decodeObject(rpc.params.flags ?? {});
    const input = yield* decodeObject(rpc.params.input ?? {});
    // Power-off must retire T3 sessions and credentials through DeviceService.
    const command =
      typeof rpc.params.command === "string" ? rpc.params.command.trim().toLowerCase() : "";
    const steps = command === "batch" ? decodeBatchSteps(flags.batchSteps) : undefined;
    if (
      steps !== undefined &&
      Option.isSome(steps) &&
      steps.value.some(
        (step) =>
          targetsAnotherDevice(step.flags, target.deviceId) ||
          targetsAnotherDevice(step.input, target.deviceId),
      )
    )
      return HttpServerResponse.text("Forbidden", { status: 403 });
    if (
      requiresDeviceLifecycle(command, flags.shutdown) ||
      requiresDeviceLifecycle(command, input.shutdown) ||
      (steps !== undefined &&
        (Option.isNone(steps) ||
          steps.value.some(
            (step) =>
              step.command.trim().toLowerCase() === "batch" ||
              requiresDeviceLifecycle(step.command, step.flags?.shutdown ?? flags.shutdown) ||
              requiresDeviceLifecycle(step.command, step.input?.shutdown),
          )))
    )
      return HttpServerResponse.text(
        "Use device_close with shutdown=true to power off this device. Use explicit commands or batch steps instead of replay/test scripts.",
        { status: 403 },
      );
    if (
      targetsAnotherDevice(flags, target.deviceId) ||
      targetsAnotherDevice(input, target.deviceId) ||
      (rpc.params.command !== "devices" &&
        flags.udid !== target.deviceId &&
        flags.serial !== target.deviceId)
    )
      return HttpServerResponse.text("Forbidden", { status: 403 });
  }
  if (uploadBody) {
    if (path === "/upload/finalize") {
      if (typeof uploadBody.uploadId !== "string")
        return HttpServerResponse.text("Bad Request", { status: 400 });
      resource = { kind: "upload", id: uploadBody.uploadId };
      yield* access.authorize(token, resource);
    } else {
      if (typeof uploadBody.uploadAttemptId !== "string")
        return HttpServerResponse.text("Bad Request", { status: 400 });
      // The daemon deduplicates by uploadAttemptId and file metadata, without a session.
      uploadBody = {
        ...uploadBody,
        uploadAttemptId: yield* encodeUploadAttempt([
          target.threadId,
          target.hostId,
          target.session,
          uploadBody.uploadAttemptId,
        ]),
      };
    }
  }
  const devices = yield* DeviceService.DeviceService;
  const ready = yield* devices.agentReadinessIfSupported(target.hostId, true);
  // Commands must observe external shutdown/replacement before using a retained credential.
  if (ready && rpc) yield* devices.refreshAgentDevice(ready);
  // Readiness can outlast resource ownership, host identity, or thread consent.
  yield* access.authorize(token, resource);
  if (!ready) return HttpServerResponse.text("Device agent is not running", { status: 503 });
  const headers: Record<string, string> = {};
  const connectionHeaders = new Set(
    (request.headers.connection ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [name, value] of Object.entries(request.headers)) {
    if (!DROPPED_HEADERS.has(name) && !connectionHeaders.has(name) && value !== undefined)
      headers[name] = value;
  }
  headers.authorization = `Bearer ${ready.agentDevice.token}`;
  headers["x-agent-device-token"] = ready.agentDevice.token;
  let upstream = HttpClientRequest.make(request.method)(
    `${ready.agentDevice.baseUrl.replace(/\/$/, "")}${path}${url.value.search}`,
  ).pipe(HttpClientRequest.setHeaders(headers));
  if (rpc)
    upstream = yield* HttpClientRequest.bodyJson({
      ...rpc,
      params: { ...rpc.params, token: ready.agentDevice.token },
    })(upstream);
  else if (uploadBody) upstream = yield* HttpClientRequest.bodyJson(uploadBody)(upstream);
  else if (request.method !== "GET")
    upstream = upstream.pipe(HttpClientRequest.bodyStream(request.stream));
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const response = yield* client.execute(upstream);
  if (
    directUploadId !== undefined &&
    ((response.status >= 200 && response.status < 300) || response.status === 308)
  )
    yield* access.recordResource(target, { kind: "upload", id: directUploadId });
  if (path === "/upload/preflight" && response.status >= 200 && response.status < 300) {
    const descriptor = yield* decodeUploadDescriptor(yield* response.json);
    if (descriptor.ok)
      yield* access.recordResource(target, { kind: "upload", id: descriptor.uploadId });
    if (descriptor.upload) {
      const direct = new URL(descriptor.upload.url);
      if (direct.pathname !== `/upload/direct/${encodeURIComponent(descriptor.uploadId)}`)
        return HttpServerResponse.text("Invalid upload descriptor", { status: 502 });
      const proxyUrl = new URL(
        `${DeviceAgentAccess.AGENT_DEVICE_ROUTE_PREFIX}${direct.pathname}`,
        url.value.origin,
      ).toString();
      return yield* HttpServerResponse.json({
        ...descriptor,
        upload: {
          url: proxyUrl,
          headers: {
            "content-type": descriptor.upload.headers["content-type"] ?? "application/octet-stream",
            authorization: `Bearer ${token}`,
            "x-agent-device-token": token,
          },
        },
      });
    }
    return yield* HttpServerResponse.json(descriptor);
  }
  if (
    (path === "/upload" || path === "/upload/finalize") &&
    response.status >= 200 &&
    response.status < 300
  ) {
    const uploaded = yield* decodeUploadResult(yield* response.json);
    if (uploaded.ok)
      yield* access.recordResource(target, { kind: "upload", id: uploaded.uploadId });
    return yield* HttpServerResponse.json(uploaded);
  }
  if (
    (path === "/artifacts" || path === "/artifacts/") &&
    response.status >= 200 &&
    response.status < 300
  ) {
    const inventory = yield* decodeInventory(yield* response.json);
    const artifacts = yield* Effect.filter(inventory.artifacts, (artifact) =>
      typeof artifact.id === "string"
        ? access.ownsResource(target, { kind: "artifact", id: artifact.id })
        : Effect.succeed(false),
    );
    return yield* HttpServerResponse.json({ artifacts });
  }
  const responseHeaders: Record<string, string> = { "cache-control": "no-store" };
  for (const name of [
    "content-type",
    "content-disposition",
    "content-range",
    "range",
    "x-upload-offset",
  ]) {
    const value = response.headers[name];
    if (value !== undefined) responseHeaders[name] = value;
  }
  const stream =
    path === "/rpc"
      ? response.stream.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.tap((line) =>
            Effect.gen(function* () {
              const decoded = decodeRpcArtifacts(line);
              if (Option.isNone(decoded)) return;
              const result =
                "response" in decoded.value ? decoded.value.response.result : decoded.value.result;
              for (const artifact of result.data.artifacts)
                yield* access.recordResource(target, { kind: "artifact", id: artifact.artifactId });
            }),
          ),
          Stream.map((line) => `${line}\n`),
          Stream.encodeText,
        )
      : response.stream;
  return HttpServerResponse.stream(stream, {
    status: response.status,
    headers: responseHeaders,
  });
}).pipe(
  Effect.catchTags({
    DeviceAgentAccessDenied: () =>
      Effect.succeed(HttpServerResponse.text("Forbidden", { status: 403 })),
  }),
);

export const layer = HttpRouter.add(
  "*",
  `${DeviceAgentAccess.AGENT_DEVICE_ROUTE_PREFIX}/*`,
  handler,
);
