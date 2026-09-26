import { ClientProvidersError, ExtensionOperationError } from "@t3tools/contracts";
import { COMPOSER_CONTEXT_API, MESSAGES_ENRICHMENT_API } from "@t3tools/extension-sdk/catalogue";
import { CLIENT_COMPOSER_V11_RANGE } from "@t3tools/extension-sdk/clientProviders";
import type { Json, ViewContext } from "@t3tools/extension-sdk/contracts";
import type { HostApiInvocationMetadata, HostApiProvider } from "@t3tools/extension-runtime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { satisfiesSemverRange } from "@t3tools/shared/semver";

import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import type { ClientApiProviders } from "./ClientApiProviders.ts";
import { invokeClient, resolveConnectionId } from "./uiClientApis.ts";
import { makeExtensionScopeResolver } from "./scope.ts";

/**
 * The composer draft store is client-local (apps/web zustand state); these
 * adapters forward ops to the `t3.client/composer` provider over the
 * client-provider connect stream. When no client connection hosts the
 * provider, `getCapabilities` reports `transport: "unavailable"` and ops
 * fail `client-provider-unavailable` rather than silently no-opping.
 * Composer ops are ScopedThreadRef-only: drafts are written for the
 * context's own thread, never a client-local `DraftId`.
 */
const CLIENT_COMPOSER = "t3.client/composer";
const COMPOSER_TIMEOUT_MS = 10_000;

const failure = (operation: string, detail: string) =>
  new ExtensionOperationError({ operation, detail: detail.slice(0, 512) });

/** Forwarded client errors keep their `client-*`/`notification-*` code prefix in the detail. */
const clientFailure = (operation: string) => (cause: unknown) =>
  Schema.is(ClientProvidersError)(cause)
    ? failure(operation, `${cause.code}: ${cause.detail}`)
    : failure(operation, cause instanceof Error ? cause.message : String(cause));

const boundedString = (max: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));
const lineSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 }));
const diffIndexSchema = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }));
const threadIdField = { threadId: Schema.optional(boundedString(128)) } as const;

const insertInput = Schema.decodeUnknownSync(
  Schema.Struct({
    ...threadIdField,
    refs: Schema.Array(
      Schema.Struct({
        path: boundedString(512),
        startLine: Schema.optional(lineSchema),
        endLine: Schema.optional(lineSchema),
        excerpt: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  }),
  { onExcessProperty: "error" },
);
const mentionInput = Schema.decodeUnknownSync(
  Schema.Struct({
    ...threadIdField,
    paths: Schema.Array(boundedString(512)).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  }),
  { onExcessProperty: "error" },
);
const terminalContextInput = Schema.decodeUnknownSync(
  Schema.Struct({
    ...threadIdField,
    terminalId: boundedString(128),
    terminalLabel: boundedString(128),
    lineStart: lineSchema,
    lineEnd: lineSchema,
    // 10,000 chars keeps the worst-case escaped frame (~62 KB) inside the
    // broker's 64 KiB envelope; see the catalogue bounds comment.
    text: boundedString(10_000),
  }),
  { onExcessProperty: "error" },
);
const draftInput = Schema.decodeUnknownSync(Schema.Struct({ ...threadIdField }), {
  onExcessProperty: "error",
});
const annotationSelection = Schema.Struct({
  start: lineSchema,
  side: Schema.Literals(["additions", "deletions"]),
  end: lineSchema,
  endSide: Schema.Literals(["additions", "deletions"]),
});
// `kind` absent selects the 1.0.0 file variant; `kind: "diff"` carries what
// buildDiffReviewComment produces. The union errors on anything else.
const annotationInput = Schema.decodeUnknownSync(
  Schema.Struct({
    ...threadIdField,
    annotation: Schema.Union([
      Schema.Struct({
        filePath: boundedString(512),
        startLine: lineSchema,
        endLine: lineSchema,
        body: boundedString(4096),
        excerpt: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
      }),
      Schema.Struct({
        kind: Schema.Literal("diff"),
        filePath: boundedString(512),
        sectionId: boundedString(512),
        sectionTitle: boundedString(256),
        rangeLabel: boundedString(128),
        diff: boundedString(4096),
        selection: annotationSelection,
        startIndex: Schema.optional(diffIndexSchema),
        endIndex: Schema.optional(diffIndexSchema),
        body: boundedString(4096),
      }),
    ]),
  }),
  { onExcessProperty: "error" },
);
const removeAnnotationInput = Schema.decodeUnknownSync(
  Schema.Struct({ ...threadIdField, annotationId: boundedString(256) }),
  { onExcessProperty: "error" },
);

/** Draft ops address the calling surface's own thread only — `ScopedThreadRef`, never a client-local `DraftId`. */
const scopedThread = (
  operation: string,
  threadId: string | undefined,
  context: ViewContext,
): Effect.Effect<string, ExtensionOperationError> => {
  const scoped = context.resource.threadId;
  if (threadId !== undefined && threadId !== scoped)
    return Effect.fail(failure(operation, "Draft target is outside the granted thread scope."));
  const target = threadId ?? scoped;
  if (!target)
    return Effect.fail(failure(operation, "Draft operations require a thread-scoped context."));
  return Effect.succeed(target);
};

const invalid = (operation: string) => () =>
  failure(operation, "Invalid composer operation request.");

export interface ComposerBridge {
  readonly environmentId: string;
  readonly clientApiProviders: ClientApiProviders["Service"];
}

/** Dependencies remain host-owned; callers supply only a scoped resource and bounded payloads. */
export function createComposerApiProviders(
  dependencies: Parameters<typeof makeExtensionScopeResolver>[0],
  bridge: ComposerBridge,
): readonly HostApiProvider[] {
  const resolve = makeExtensionScopeResolver(dependencies);

  /** The composer version one connection declares, or undefined when it does not host the provider. */
  const composerVersionOf = (connectionId: string) =>
    Effect.map(
      bridge.clientApiProviders.listTargets(bridge.environmentId),
      (targets) =>
        targets
          .find((target) => target.connectionId === connectionId)
          ?.providers.find((provider) => provider.id === CLIENT_COMPOSER)?.version,
    );

  /** The composer version the caller's frames would be forwarded to; target errors surface like forwarded ones. */
  const targetedComposerVersion = (metadata: HostApiInvocationMetadata) =>
    Effect.flatMap(resolveConnectionId(bridge, metadata), composerVersionOf);

  /**
   * Capabilities describe the connection this caller's ops would actually
   * reach: a client still on `t3.client/composer@1.0.x` reports the 1.1.0-only
   * operations as unsupported instead of promising methods its dispatch would
   * silently degrade. `v11Only` marks each operation that requires the 1.1.0
   * surface; everything else is the 1.0.0 method set.
   */
  const composerCapabilities = (
    adapter: string,
    v11Only: Record<string, boolean>,
    metadata: HostApiInvocationMetadata,
  ) =>
    Effect.gen(function* () {
      const unavailable = (detail: string) => ({
        adapter,
        transport: "unavailable",
        detail,
        operations: Object.fromEntries(Object.keys(v11Only).map((name) => [name, false])),
      });
      const outcome = yield* Effect.result(targetedComposerVersion(metadata));
      if (!Result.isSuccess(outcome)) {
        return unavailable(`${outcome.failure.code}: ${outcome.failure.detail}`) satisfies Json;
      }
      const version = outcome.success;
      if (version === undefined) {
        return unavailable(
          "Composer draft state is client-local; no connected client hosts the composer provider.",
        ) satisfies Json;
      }
      const v11 = satisfiesSemverRange(version, CLIENT_COMPOSER_V11_RANGE);
      return {
        adapter,
        transport: "client",
        detail: v11
          ? null
          : `Connected client declares ${CLIENT_COMPOSER}@${version}; 1.1.0-only operations report false.`,
        operations: Object.fromEntries(
          Object.entries(v11Only).map(([name, required]) => [name, !required || v11]),
        ),
      } satisfies Json;
    });

  const forward = (
    method: string,
    input: Json,
    context: ViewContext,
    signal: AbortSignal,
    metadata: HostApiInvocationMetadata,
    connectionId?: string,
  ) =>
    Effect.runPromise(
      invokeClient(bridge, {
        apiId: CLIENT_COMPOSER,
        method,
        input,
        context,
        metadata,
        signal,
        timeoutMs: COMPOSER_TIMEOUT_MS,
        ...(connectionId !== undefined ? { connectionId } : {}),
      }),
      { signal },
    );

  /**
   * Resolves the caller's target connection and refuses a 1.1.0-only op with a
   * named error before any mutation when that connection still declares a
   * 1.0.x composer. Returns the resolved connectionId so the gate and the
   * forward that follows cannot split across two different connections.
   */
  const requireComposerV11 = (
    operation: string,
    metadata: HostApiInvocationMetadata,
  ): Effect.Effect<string, ExtensionOperationError> =>
    Effect.gen(function* () {
      const resolved = yield* Effect.result(resolveConnectionId(bridge, metadata));
      if (!Result.isSuccess(resolved)) {
        return yield* Effect.fail(clientFailure(operation)(resolved.failure));
      }
      const connectionId = resolved.success;
      const version = yield* composerVersionOf(connectionId);
      if (version !== undefined && !satisfiesSemverRange(version, CLIENT_COMPOSER_V11_RANGE)) {
        return yield* failure(
          operation,
          `client-provider-unsupported-version: The targeted client declares ${CLIENT_COMPOSER}@${version}, which does not satisfy ${CLIENT_COMPOSER_V11_RANGE}.`,
        );
      }
      return connectionId;
    });

  const composerInvoke = Effect.fn("ComposerApi.invoke")(function* (
    method: string,
    input: unknown,
    context: ViewContext,
    signal: AbortSignal,
    metadata: HostApiInvocationMetadata,
  ) {
    const scope = yield* resolve(context);
    if (method === "getCapabilities") {
      yield* resolve(scope.context);
      return yield* composerCapabilities(
        "host.composer",
        {
          insertContext: false,
          getDraftState: false,
          insertMention: true,
          insertTerminalContext: true,
        },
        metadata,
      );
    }
    const operation = `composer.context.${method}`;
    if (method === "insertContext") {
      const safe = yield* Effect.try({
        try: () => insertInput(input),
        catch: invalid(operation),
      });
      const threadId = yield* scopedThread(operation, safe.threadId, scope.context);
      yield* resolve(scope.context);
      return yield* Effect.tryPromise({
        try: () =>
          forward(
            "insertContext",
            { threadId, refs: safe.refs } as Json,
            scope.context,
            signal,
            metadata,
          ),
        catch: clientFailure(operation),
      });
    }
    if (method === "getDraftState") {
      const safe = yield* Effect.try({
        try: () => draftInput(input),
        catch: invalid(operation),
      });
      const threadId = yield* scopedThread(operation, safe.threadId, scope.context);
      yield* resolve(scope.context);
      return yield* Effect.tryPromise({
        try: () => forward("getDraftState", { threadId } as Json, scope.context, signal, metadata),
        catch: clientFailure(operation),
      });
    }
    if (method === "insertMention") {
      const safe = yield* Effect.try({
        try: () => mentionInput(input),
        catch: invalid(operation),
      });
      const threadId = yield* scopedThread(operation, safe.threadId, scope.context);
      yield* resolve(scope.context);
      const connectionId = yield* requireComposerV11(operation, metadata);
      return yield* Effect.tryPromise({
        try: () =>
          forward(
            "insertMention",
            { threadId, paths: safe.paths } as Json,
            scope.context,
            signal,
            metadata,
            connectionId,
          ),
        catch: clientFailure(operation),
      });
    }
    if (method === "insertTerminalContext") {
      const safe = yield* Effect.try({
        try: () => terminalContextInput(input),
        catch: invalid(operation),
      });
      const threadId = yield* scopedThread(operation, safe.threadId, scope.context);
      yield* resolve(scope.context);
      const connectionId = yield* requireComposerV11(operation, metadata);
      return yield* Effect.tryPromise({
        try: () =>
          forward(
            "insertTerminalContext",
            {
              threadId,
              terminalId: safe.terminalId,
              terminalLabel: safe.terminalLabel,
              lineStart: safe.lineStart,
              lineEnd: safe.lineEnd,
              text: safe.text,
            } as Json,
            scope.context,
            signal,
            metadata,
            connectionId,
          ),
        catch: clientFailure(operation),
      });
    }
    return yield* failure("composer.context", "Composer context API method is unavailable.");
  });

  const enrichmentInvoke = Effect.fn("ComposerApi.invokeEnrichment")(function* (
    method: string,
    input: unknown,
    context: ViewContext,
    signal: AbortSignal,
    metadata: HostApiInvocationMetadata,
  ) {
    const scope = yield* resolve(context);
    if (method === "getCapabilities") {
      yield* resolve(scope.context);
      return yield* composerCapabilities(
        "host.messages",
        {
          // The file variant is the 1.0.0 surface; the diff variant is gated
          // at attachAnnotation below.
          attachAnnotation: false,
          listAnnotations: true,
          removeAnnotation: true,
        },
        metadata,
      );
    }
    const operation = `messages.enrichment.${method}`;
    if (method === "attachAnnotation") {
      const safe = yield* Effect.try({
        try: () => annotationInput(input),
        catch: invalid(operation),
      });
      const threadId = yield* scopedThread(operation, safe.threadId, scope.context);
      yield* resolve(scope.context);
      // Only the diff variant rides the 1.1.0 surface; the 1.0.0 file comment
      // keeps flowing to old clients unchanged.
      const connectionId =
        "kind" in safe.annotation && safe.annotation.kind === "diff"
          ? yield* requireComposerV11(operation, metadata)
          : undefined;
      return yield* Effect.tryPromise({
        try: () =>
          forward(
            "attachAnnotation",
            { threadId, annotation: safe.annotation } as Json,
            scope.context,
            signal,
            metadata,
            connectionId,
          ),
        catch: clientFailure(operation),
      });
    }
    if (method === "listAnnotations") {
      const safe = yield* Effect.try({
        try: () => draftInput(input),
        catch: invalid(operation),
      });
      const threadId = yield* scopedThread(operation, safe.threadId, scope.context);
      yield* resolve(scope.context);
      const connectionId = yield* requireComposerV11(operation, metadata);
      return yield* Effect.tryPromise({
        try: () =>
          forward(
            "listAnnotations",
            { threadId } as Json,
            scope.context,
            signal,
            metadata,
            connectionId,
          ),
        catch: clientFailure(operation),
      });
    }
    if (method === "removeAnnotation") {
      const safe = yield* Effect.try({
        try: () => removeAnnotationInput(input),
        catch: invalid(operation),
      });
      const threadId = yield* scopedThread(operation, safe.threadId, scope.context);
      yield* resolve(scope.context);
      const connectionId = yield* requireComposerV11(operation, metadata);
      return yield* Effect.tryPromise({
        try: () =>
          forward(
            "removeAnnotation",
            { threadId, annotationId: safe.annotationId } as Json,
            scope.context,
            signal,
            metadata,
            connectionId,
          ),
        catch: clientFailure(operation),
      });
    }
    return yield* failure("messages.enrichment", "Messages enrichment API method is unavailable.");
  });

  return [
    {
      providerId: "host.composer",
      definition: COMPOSER_CONTEXT_API,
      availability: async () =>
        (await Effect.runPromise(
          bridge.clientApiProviders.hasProvider(bridge.environmentId, CLIENT_COMPOSER),
        ))
          ? { status: "ready" }
          : {
              status: "unavailable",
              reason: {
                code: "client-provider-unavailable",
                detail: "No connected client registered this provider.",
                relatedIds: [],
              },
            },
      invoke: (method: string, input: Json, context: ViewContext, signal: AbortSignal, metadata) =>
        Effect.runPromise(composerInvoke(method, input, context, signal, metadata), { signal }),
    },
    {
      providerId: "host.messages",
      definition: MESSAGES_ENRICHMENT_API,
      availability: async () =>
        (await Effect.runPromise(
          bridge.clientApiProviders.hasProvider(bridge.environmentId, CLIENT_COMPOSER),
        ))
          ? { status: "ready" }
          : {
              status: "unavailable",
              reason: {
                code: "client-provider-unavailable",
                detail: "No connected client registered this provider.",
                relatedIds: [],
              },
            },
      invoke: (method: string, input: Json, context: ViewContext, signal: AbortSignal, metadata) =>
        Effect.runPromise(enrichmentInvoke(method, input, context, signal, metadata), { signal }),
    },
  ];
}

export const makeComposerApiProviders = Effect.fn("ComposerApi.make")(function* (
  bridge: ComposerBridge,
) {
  return createComposerApiProviders(
    {
      environmentId: bridge.environmentId,
      projects: yield* ProjectionProjectRepository,
      threads: yield* ProjectionThreadRepository,
    },
    bridge,
  );
});
