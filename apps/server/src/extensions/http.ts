import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  type EnvironmentSessionPrincipalShape,
  ExtensionOperationError,
  type AuthEnvironmentScope,
  type ExtensionApiInvokeInput,
  type ExtensionApiDiscoverInput,
  type ExtensionApiSelection,
  type ExtensionClientInput,
  type ExtensionAssetInput,
  type ExtensionInstallInput,
  type ExtensionInvokeInput,
  type ExtensionManageInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { HostApiRootAuthority } from "@t3tools/extension-runtime";
import { SessionStore } from "../auth/SessionStore.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { makeSessionApiAuthority } from "./sessionApiAuthority.ts";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import { EnvironmentExtensions } from "./EnvironmentExtensions.ts";

/** These are the actual authenticated endpoint operations, shared with focused scope tests. */
export function makeOperations(
  extensions: EnvironmentExtensions["Service"],
  makeAuthority: (
    session: EnvironmentSessionPrincipalShape,
    scope: AuthEnvironmentScope,
    writeScope?: AuthEnvironmentScope,
    /**
     * The client runtime instance id echoed from the request's
     * `x-t3-client-instance` header — resolves to that client's live ws
     * connection so HTTP mints bind to the correct root connection.
     */
    clientInstanceId?: string,
  ) => Effect.Effect<HostApiRootAuthority, ExtensionOperationError>,
) {
  return {
    invokeApi: Effect.fn("environment.extensions.invokeApi")(function* (
      input: ExtensionApiInvokeInput,
      clientInstanceId?: string,
    ) {
      // Domain scopes decide write capability: an ordinary paired session with
      // orchestration:operate gets a write-capable root without any
      // administrative access:write grant; a read-only session gets a
      // read-only root that the broker enforces for method effects. Access
      // alone is never a substitute for the domain operate scope.
      const authenticated = yield* EnvironmentAuthenticatedPrincipal;
      const requiredScope = authenticated.scopes.has(AuthOrchestrationOperateScope)
        ? AuthOrchestrationOperateScope
        : AuthOrchestrationReadScope;
      const session = yield* requireEnvironmentScope(requiredScope);
      const root = yield* makeAuthority(
        session,
        requiredScope,
        AuthOrchestrationOperateScope,
        clientInstanceId,
      );
      return { result: yield* extensions.invokeApi(input, root) };
    }),
    discoverApis: Effect.fn("environment.extensions.discoverApis")(function* (
      input: ExtensionApiDiscoverInput,
    ) {
      yield* requireEnvironmentScope(AuthOrchestrationReadScope);
      return { apis: yield* extensions.discoverApis(input) };
    }),
    selectApi: Effect.fn("environment.extensions.selectApi")(function* (
      input: ExtensionApiSelection,
    ) {
      yield* requireEnvironmentScope(AuthAccessWriteScope);
      yield* extensions.selectApi(input);
      return { ok: true };
    }),
    list: Effect.fn("environment.extensions.list")(function* () {
      yield* requireEnvironmentScope(AuthOrchestrationReadScope);
      return {
        installations: yield* extensions.list,
        ...(yield* extensions.catalogue),
        supportsCatalogueChanges: true,
        supportedPackageFormats: [1, 2, 3, 4],
        supportsApiStreams: true,
      };
    }),
    asset: Effect.fn("environment.extensions.asset")(function* (input: ExtensionAssetInput) {
      const session = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
      const authority = yield* makeAuthority(session, AuthOrchestrationReadScope);
      const bytes = yield* extensions.asset(input);
      yield* Effect.tryPromise({
        try: async () => {
          await authority.revalidate();
        },
        catch: () =>
          new ExtensionOperationError({
            operation: "asset",
            detail: "The authenticated asset caller is no longer authorized.",
          }),
      });
      return HttpApiSchema.withHeaders({
        body: bytes,
        headers: {
          "cache-control": "no-store" as const,
          "x-content-type-options": "nosniff" as const,
        },
      });
    }),
    client: Effect.fn("environment.extensions.client")(function* (input: ExtensionClientInput) {
      yield* requireEnvironmentScope(AuthOrchestrationReadScope);
      return yield* extensions.client(input.id, input.expectedContentHash);
    }),
    invoke: Effect.fn("environment.extensions.invoke")(function* (input: ExtensionInvokeInput) {
      yield* requireEnvironmentScope(AuthOrchestrationReadScope);
      return { result: yield* extensions.invoke(input) };
    }),
    install: Effect.fn("environment.extensions.install")(function* (input: ExtensionInstallInput) {
      yield* requireEnvironmentScope(AuthAccessWriteScope);
      return yield* extensions.install(input);
    }),
    manage: Effect.fn("environment.extensions.manage")(function* (input: ExtensionManageInput) {
      yield* requireEnvironmentScope(AuthAccessWriteScope);
      return { installation: yield* extensions.manage(input) };
    }),
  };
}
export const extensionsHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "extensions",
  Effect.fnUntraced(function* (handlers) {
    const sessions = yield* SessionStore;
    const environment = yield* ServerEnvironment;
    const environmentId = yield* environment.getEnvironmentId;
    const operations = makeOperations(
      yield* EnvironmentExtensions,
      (session, scope, writeScope, clientInstanceId) =>
        // HTTP requests carry no transport connection of their own, but the
        // client echoes the same instance id it announced on its ws upgrade.
        // Resolving it binds the authority to THAT client's live socket —
        // never a session-global newest. An absent header keeps the
        // documented connectionless mode (pure-HTTP callers depend on it),
        // but a supplied instance id that resolves to nothing is a stale
        // identity: downgrading it silently would mint records no root
        // connection revocation could ever reach, so it fails by name.
        Effect.gen(function* () {
          if (clientInstanceId === undefined) {
            return yield* makeSessionApiAuthority(
              session,
              environmentId,
              scope,
              sessions,
              writeScope,
            );
          }
          const connectionId = yield* sessions.connectionIdForClientInstance(
            session.sessionId,
            clientInstanceId,
          );
          if (Option.isNone(connectionId)) {
            return yield* new ExtensionOperationError({
              operation: "api.invoke",
              detail: `ExtensionClientInstanceError: client instance '${clientInstanceId}' has no live connection on this session.`,
            });
          }
          return yield* makeSessionApiAuthority(
            session,
            environmentId,
            scope,
            sessions,
            writeScope,
            connectionId.value,
          );
        }),
    );
    return handlers
      .handle("invokeApi", (args) =>
        annotateEnvironmentRequest(args.endpoint.name).pipe(
          Effect.andThen(operations.invokeApi(args.payload, args.headers["x-t3-client-instance"])),
        ),
      )
      .handle("discoverApis", (args) =>
        annotateEnvironmentRequest(args.endpoint.name).pipe(
          Effect.andThen(operations.discoverApis(args.payload)),
        ),
      )
      .handle("selectApi", (args) =>
        annotateEnvironmentRequest(args.endpoint.name).pipe(
          Effect.andThen(operations.selectApi(args.payload)),
        ),
      )
      .handle("list", (args) =>
        annotateEnvironmentRequest(args.endpoint.name).pipe(Effect.andThen(operations.list())),
      )
      .handle("asset", (args) =>
        annotateEnvironmentRequest(args.endpoint.name).pipe(
          Effect.andThen(operations.asset(args.payload)),
        ),
      )
      .handle("client", (args) =>
        annotateEnvironmentRequest(args.endpoint.name).pipe(
          Effect.andThen(operations.client(args.payload)),
        ),
      )
      .handle("invoke", (args) =>
        annotateEnvironmentRequest(args.endpoint.name).pipe(
          Effect.andThen(operations.invoke(args.payload)),
        ),
      )
      .handle("install", (args) =>
        annotateEnvironmentRequest(args.endpoint.name).pipe(
          Effect.andThen(operations.install(args.payload)),
        ),
      )
      .handle("manage", (args) =>
        annotateEnvironmentRequest(args.endpoint.name).pipe(
          Effect.andThen(operations.manage(args.payload)),
        ),
      );
  }),
);
