import {
  AuthOrchestrationOperateScope,
  DesktopBootstrapWorkspaceFolder,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { bootstrapVscodeWorkspaces, VscodeWorkspaceBootstrapError } from "./bootstrap.ts";

const VscodeWorkspaceBootstrapRequest = Schema.Struct({
  workspaceFolders: Schema.Array(DesktopBootstrapWorkspaceFolder),
  activeWorkspaceFolderKey: Schema.optional(TrimmedNonEmptyString),
});

const respondToBootstrapError = (error: VscodeWorkspaceBootstrapError) =>
  Effect.gen(function* () {
    if (error.status === 500) {
      yield* Effect.logError("VS Code workspace bootstrap route failed", {
        message: error.message,
        cause: error.cause,
      });
    }
    return HttpServerResponse.jsonUnsafe({ error: error.message }, { status: error.status ?? 500 });
  });

const authenticateOwnerSession = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.mapError(
      (cause) =>
        new VscodeWorkspaceBootstrapError({
          message: "Authentication required to bootstrap VS Code workspaces.",
          status: 401,
          cause,
        }),
    ),
  );
  if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
    return yield* new VscodeWorkspaceBootstrapError({
      message: "Insufficient scope to bootstrap VS Code workspaces.",
      status: 403,
    });
  }
  return session;
});

export const vscodeWorkspaceBootstrapRouteLayer = HttpRouter.add(
  "POST",
  "/api/vscode/workspace-bootstrap",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const input = yield* HttpServerRequest.schemaBodyJson(VscodeWorkspaceBootstrapRequest).pipe(
      Effect.mapError(
        (cause) =>
          new VscodeWorkspaceBootstrapError({
            message: "Invalid VS Code workspace bootstrap request.",
            status: 400,
            cause,
          }),
      ),
    );
    const result = yield* bootstrapVscodeWorkspaces(input);
    return HttpServerResponse.jsonUnsafe(result);
  }).pipe(
    Effect.catchTags({
      VscodeWorkspaceBootstrapError: respondToBootstrapError,
    }),
  ),
);
