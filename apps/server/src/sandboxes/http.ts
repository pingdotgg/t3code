import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationReadScope,
  SandboxActivityReport,
  SandboxId,
  SandboxOperationError,
  SandboxSnapshotInput,
  SandboxSpawnInput,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { SandboxOrchestratorService } from "./SandboxOrchestratorService.ts";

const NO_STORE = { "cache-control": "no-store" };
const MAX_JSON_BODY_BYTES = 64 * 1024;

const decodeSpawn = Schema.decodeUnknownEffect(SandboxSpawnInput);
const decodeSnapshotJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.optional(SandboxSnapshotInput.fields.name),
      markAsBase: Schema.optional(SandboxSnapshotInput.fields.markAsBase),
    }),
  ),
);
const decodeSandboxId = Schema.decodeUnknownEffect(SandboxId);

const authorizeScope = Effect.fn("SandboxesHttp.authorizeScope")(function* (
  scope: AuthEnvironmentScope,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
  if (session._tag === "None") {
    return yield* HttpServerResponse.json(
      { error: "unauthorized", message: "Authentication required." },
      { status: 401, headers: NO_STORE },
    );
  }
  if (!session.value.scopes.includes(scope)) {
    return yield* HttpServerResponse.json(
      { error: "forbidden", requiredScope: scope, message: "Insufficient scope." },
      { status: 403, headers: NO_STORE },
    );
  }
  return null;
});

function errorToHttpResponse(error: SandboxOperationError) {
  const status =
    error.category === "not_found"
      ? 404
      : error.category === "auth"
        ? 401
        : error.category === "rate_limit"
          ? 429
          : error.category === "unconfigured" || error.category === "invalid_state"
            ? 400
            : 502;
  return HttpServerResponse.json(
    {
      error: error.category,
      operation: error.operation,
      message: error.message,
    },
    { status, headers: NO_STORE },
  );
}

const readJsonBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  return yield* request.json.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_JSON_BODY_BYTES)),
  );
});

const activityRoute = HttpRouter.add(
  "GET",
  "/api/sandboxes/activity",
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly activeCount: number;
      readonly lastActivity: string | null;
    }>`
      SELECT
        SUM(CASE WHEN status IN ('preparing', 'starting', 'running') THEN 1 ELSE 0 END) AS activeCount,
        MAX(COALESCE(completed_at, requested_at)) AS lastActivity
      FROM orchestration_v2_projection_runs
    `.pipe(Effect.orElseSucceed(() => []));
    const row = rows[0];
    const report: SandboxActivityReport = {
      activeRunCount: Number(row?.activeCount ?? 0),
      lastRunActivityAt: row?.lastActivity ?? null,
    };
    return yield* HttpServerResponse.json(report, { headers: NO_STORE });
  }),
);

const listRoute = HttpRouter.add(
  "GET",
  "/api/sandboxes",
  Effect.gen(function* () {
    const denied = yield* authorizeScope(AuthOrchestrationReadScope);
    if (denied !== null) return denied;
    const orchestrator = yield* SandboxOrchestratorService;
    return yield* orchestrator.listSandboxes().pipe(
      Effect.flatMap((result) => HttpServerResponse.json(result, { headers: NO_STORE })),
      Effect.catchTags({ SandboxOperationError: errorToHttpResponse }),
    );
  }),
);

const spawnRoute = HttpRouter.add(
  "POST",
  "/api/sandboxes",
  Effect.gen(function* () {
    const denied = yield* authorizeScope(AuthEnvironmentMaintainScope);
    if (denied !== null) return denied;
    const decoded = yield* readJsonBody.pipe(Effect.flatMap(decodeSpawn), Effect.option);
    if (decoded._tag === "None") {
      return yield* HttpServerResponse.json(
        { error: "invalid_request", message: "Invalid sandbox spawn payload." },
        { status: 400, headers: NO_STORE },
      );
    }
    const orchestrator = yield* SandboxOrchestratorService;
    return yield* orchestrator.spawnSandbox(decoded.value).pipe(
      Effect.flatMap((result) =>
        HttpServerResponse.json(result, { status: 201, headers: NO_STORE }),
      ),
      Effect.catchTags({ SandboxOperationError: errorToHttpResponse }),
    );
  }),
);

function parsePathSandboxId(request: HttpServerRequest.HttpServerRequest) {
  const match = request.url.match(/^\/api\/sandboxes\/([^/?#]+)/u);
  const raw = match?.[1] ? decodeURIComponent(match[1]) : "";
  return decodeSandboxId(raw).pipe(Effect.option);
}

const resumeRoute = HttpRouter.add(
  "POST",
  "/api/sandboxes/:id/resume",
  Effect.gen(function* () {
    const denied = yield* authorizeScope(AuthEnvironmentMaintainScope);
    if (denied !== null) return denied;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const id = yield* parsePathSandboxId(request);
    if (id._tag === "None") {
      return yield* HttpServerResponse.json(
        { error: "invalid_request", message: "Invalid sandbox id." },
        { status: 400, headers: NO_STORE },
      );
    }
    const orchestrator = yield* SandboxOrchestratorService;
    return yield* orchestrator.resumeSandbox({ id: id.value }).pipe(
      Effect.flatMap((result) => HttpServerResponse.json(result, { headers: NO_STORE })),
      Effect.catchTags({ SandboxOperationError: errorToHttpResponse }),
    );
  }),
);

const snapshotRoute = HttpRouter.add(
  "POST",
  "/api/sandboxes/:id/snapshot",
  Effect.gen(function* () {
    const denied = yield* authorizeScope(AuthEnvironmentMaintainScope);
    if (denied !== null) return denied;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const id = yield* parsePathSandboxId(request);
    if (id._tag === "None") {
      return yield* HttpServerResponse.json(
        { error: "invalid_request", message: "Invalid sandbox id." },
        { status: 400, headers: NO_STORE },
      );
    }
    const rawBody = yield* request.text.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_JSON_BODY_BYTES)),
      Effect.option,
    );
    if (rawBody._tag === "None") {
      return yield* HttpServerResponse.json(
        { error: "invalid_request", message: "Invalid snapshot payload." },
        { status: 400, headers: NO_STORE },
      );
    }
    const body =
      rawBody.value.trim().length === 0
        ? Option.some({})
        : yield* decodeSnapshotJson(rawBody.value).pipe(Effect.option);
    if (Option.isNone(body)) {
      return yield* HttpServerResponse.json(
        { error: "invalid_request", message: "Invalid snapshot payload." },
        { status: 400, headers: NO_STORE },
      );
    }
    const orchestrator = yield* SandboxOrchestratorService;
    return yield* orchestrator.snapshotSandbox({ id: id.value, ...body.value }).pipe(
      Effect.flatMap((result) => HttpServerResponse.json(result, { headers: NO_STORE })),
      Effect.catchTags({ SandboxOperationError: errorToHttpResponse }),
    );
  }),
);

const stopRoute = HttpRouter.add(
  "POST",
  "/api/sandboxes/:id/stop",
  Effect.gen(function* () {
    const denied = yield* authorizeScope(AuthEnvironmentMaintainScope);
    if (denied !== null) return denied;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const id = yield* parsePathSandboxId(request);
    if (id._tag === "None") {
      return yield* HttpServerResponse.json(
        { error: "invalid_request", message: "Invalid sandbox id." },
        { status: 400, headers: NO_STORE },
      );
    }
    const orchestrator = yield* SandboxOrchestratorService;
    return yield* orchestrator.stopSandbox({ id: id.value }).pipe(
      Effect.flatMap((result) => HttpServerResponse.json(result, { headers: NO_STORE })),
      Effect.catchTags({ SandboxOperationError: errorToHttpResponse }),
    );
  }),
);

const destroyRoute = HttpRouter.add(
  "DELETE",
  "/api/sandboxes/:id",
  Effect.gen(function* () {
    const denied = yield* authorizeScope(AuthEnvironmentMaintainScope);
    if (denied !== null) return denied;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const id = yield* parsePathSandboxId(request);
    if (id._tag === "None") {
      return yield* HttpServerResponse.json(
        { error: "invalid_request", message: "Invalid sandbox id." },
        { status: 400, headers: NO_STORE },
      );
    }
    const orchestrator = yield* SandboxOrchestratorService;
    return yield* orchestrator.destroySandbox({ id: id.value }).pipe(
      Effect.flatMap((result) => HttpServerResponse.json(result, { headers: NO_STORE })),
      Effect.catchTags({ SandboxOperationError: errorToHttpResponse }),
    );
  }),
);

export const layer = Layer.mergeAll(
  activityRoute,
  listRoute,
  spawnRoute,
  resumeRoute,
  snapshotRoute,
  stopRoute,
  destroyRoute,
);
