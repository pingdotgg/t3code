// @effect-diagnostics nodeBuiltinImport:off - the delivered-payload hash is recomputed in a pure mapper outside a service context.
import { AuthOrchestrationReadScope, ExtensionOperationError } from "@t3tools/contracts";
import {
  VCS_DIFF_API,
  type VcsDiffFileContentsResult,
  type VcsDiffFileContentsStreamEvent,
  type VcsDiffPreviewResult,
  type VcsDiffPreviewSource,
  type VcsDiffPreviewStreamEvent,
  type VcsDiffStreamSource,
} from "@t3tools/extension-sdk/catalogue";
import type { ApiStreamEvent } from "@t3tools/extension-sdk/capabilities";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import type {
  HostApiInvocationMetadata,
  HostApiPrincipal,
  HostApiProvider,
} from "@t3tools/extension-runtime";
import * as DateTime from "effect/DateTime";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { ReviewService } from "../review/ReviewService.ts";
import { makeExtensionScopeResolver } from "./scope.ts";

/**
 * The public `diff` bound (512 000 chars) sits below the native joined cap
 * (≤120 KB tracked patch + ≤80 KB per untracked file); the adapter slices
 * and ORs `truncated` rather than fabricating a complete diff. Over invoke
 * the tightest bound is neither of these — it is the broker's 64 KiB result
 * envelope, so every `truncated:true` body (smallest is 81 920 bytes) fails
 * at transport. The `streamPreview`/`streamFileContents` streams exist to
 * deliver those payloads as ≤64 KiB frames; the slicing math below is shared
 * verbatim so the bounds mean the same thing on both surfaces.
 */
const MAX_DIFF_CHARS = 512_000;
const MAX_FILE_CONTENTS_CHARS = 1_048_576;
/** Contract chunk bound (UTF-16 units) — small enough that JSON escaping can never push a frame past 64 KiB. */
const STREAM_CHUNK_UNITS = 8_192;
const STREAM_FRAME_BUDGET = 64 * 1024;

const pathSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
/**
 * Revspecs reach `git diff`/`git show` argv — a leading `-` would inject
 * options (`--output=` escapes the workspace), and whitespace/control
 * characters are never valid. Mirrors the contract-side not-patterns.
 */
const revSpecSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  // eslint-disable-next-line no-control-regex -- revspecs legitimately reject control characters.
  Schema.isPattern(/^(?!-)[^\s\x00-\x1f]+$/u),
);
const previewInput = Schema.decodeUnknownSync(
  Schema.Struct({
    baseRef: Schema.optional(revSpecSchema),
    ignoreWhitespace: Schema.optional(Schema.Boolean),
  }),
  { onExcessProperty: "error" },
);
const fileContentsInput = Schema.decodeUnknownSync(
  Schema.Struct({
    sourceKind: Schema.Literals(["working-tree", "branch-range"]),
    changeType: Schema.Literals(["change", "rename-pure", "rename-changed", "new", "deleted"]),
    baseRef: Schema.NullOr(revSpecSchema),
    headRef: Schema.NullOr(revSpecSchema),
    oldPath: pathSchema,
    newPath: pathSchema,
  }),
  { onExcessProperty: "error" },
);

const failure = (detail: string) => new ExtensionOperationError({ operation: "vcs.diff", detail });
const isOperationError = Schema.is(ExtensionOperationError);

const operationError = (cause: unknown) => {
  if (isOperationError(cause)) return cause;
  const tag =
    cause !== null &&
    typeof cause === "object" &&
    "_tag" in cause &&
    typeof (cause as { _tag: unknown })._tag === "string"
      ? (cause as { _tag: string })._tag
      : cause instanceof Error
        ? cause.name
        : undefined;
  const message = cause instanceof Error ? cause.message : "VCS diff operation failed.";
  return failure(`${tag ? `${tag}: ` : ""}${message}`.slice(0, 512));
};

const toPublicSource = (source: {
  readonly id: string;
  readonly kind: "working-tree" | "branch-range";
  readonly title: string;
  readonly baseRef: string | null;
  readonly headRef: string | null;
  readonly diff: string;
  readonly diffHash: string;
  readonly truncated: boolean;
}): VcsDiffPreviewSource => {
  const diff = source.diff.slice(0, MAX_DIFF_CHARS);
  return {
    id: source.id,
    kind: source.kind,
    title: source.title,
    baseRef: source.baseRef,
    headRef: source.headRef,
    diff,
    // The hash must describe the payload as delivered — the native hash
    // covers the pre-slice text, so recompute over the bounded body.
    diffHash: NodeCrypto.createHash("sha256").update(diff).digest("hex"),
    truncated: source.truncated || source.diff.length > MAX_DIFF_CHARS,
  };
};

/**
 * A cut at `end` must not separate a surrogate pair — back off one unit so a
 * consumer that encodes each piece to UTF-8 reassembles the exact bytes.
 */
const pairSafeEnd = (data: string, end: number): number =>
  end < data.length &&
  data.charCodeAt(end - 1) >= 0xd800 &&
  data.charCodeAt(end - 1) <= 0xdbff &&
  data.charCodeAt(end) >= 0xdc00 &&
  data.charCodeAt(end) <= 0xdfff
    ? end - 1
    : end;

/** Bounds a prefix to `maxUnits` without splitting a surrogate pair. */
export const boundedPrefix = (data: string, maxUnits: number): string =>
  data.slice(0, pairSafeEnd(data, Math.min(maxUnits, data.length)));

/**
 * Fixed-unit chunks, split so a surrogate pair never straddles a boundary —
 * the same rule terminal output uses, so a consumer that encodes each chunk
 * to UTF-8 separately still reassembles the exact delivered bytes.
 */
const splitStreamChunks = (data: string): string[] => {
  const chunks: string[] = [];
  for (let start = 0; start < data.length;) {
    const end = pairSafeEnd(data, Math.min(start + STREAM_CHUNK_UNITS, data.length));
    chunks.push(data.slice(start, end));
    start = end;
  }
  return chunks;
};

/**
 * Backstop check that an emitted event fits the broker's per-frame byte
 * limit. Chunk frames are proven small by the 8 192-unit bound; manifest
 * frames carry up to 8 sources with contract-bounded refs, so they are
 * guarded here rather than proven — a violation fails the stream loudly.
 */
const assertStreamFrameFits = (value: object) => {
  if (
    Buffer.byteLength(
      JSON.stringify({
        streamId: "x".repeat(128),
        sequence: Number.MAX_SAFE_INTEGER,
        type: "snapshot",
        value,
      }),
      "utf8",
    ) > STREAM_FRAME_BUDGET
  ) {
    throw failure("VCS diff stream event exceeds encoded frame bounds.");
  }
};

export function createVcsDiffApiProvider(
  dependencies: Parameters<typeof makeExtensionScopeResolver>[0] & {
    readonly review: Pick<ReviewService["Service"], "getDiffPreview" | "getDiffFileContents">;
  },
): HostApiProvider {
  const resolve = makeExtensionScopeResolver(dependencies);
  const authorized = (principal: HostApiPrincipal | undefined) =>
    principal !== undefined &&
    principal.environmentId === dependencies.environmentId &&
    principal.scopes.includes(AuthOrchestrationReadScope);

  const invoke = Effect.fn("VcsDiffApi.invoke")(function* (
    method: string,
    input: unknown,
    context: ViewContext,
    signal: AbortSignal,
    metadata: HostApiInvocationMetadata,
  ) {
    signal.throwIfAborted();
    if (!authorized(metadata.principal)) {
      return yield* failure("VCS authority is unavailable.");
    }
    const scope = yield* resolve(context);
    let result: VcsDiffPreviewResult | VcsDiffFileContentsResult;
    if (method === "getPreview") {
      const safe = yield* Effect.try({
        try: () => previewInput(input),
        catch: () => failure("Invalid VCS diff preview request."),
      });
      const preview = yield* dependencies.review
        .getDiffPreview({
          cwd: scope.cwd,
          ...(safe.baseRef === undefined ? {} : { baseRef: safe.baseRef }),
          ...(safe.ignoreWhitespace === undefined
            ? {}
            : { ignoreWhitespace: safe.ignoreWhitespace }),
        })
        .pipe(Effect.mapError(operationError));
      result = {
        generatedAt: DateTime.formatIso(preview.generatedAt),
        sources: preview.sources.map(toPublicSource),
      };
    } else if (method === "getFileContents") {
      const safe = yield* Effect.try({
        try: () => fileContentsInput(input),
        catch: () => failure("Invalid VCS diff file contents request."),
      });
      const contents = yield* dependencies.review
        .getDiffFileContents({ cwd: scope.cwd, ...safe })
        .pipe(Effect.mapError(operationError));
      if (
        contents.oldContents.length > MAX_FILE_CONTENTS_CHARS ||
        contents.newContents.length > MAX_FILE_CONTENTS_CHARS
      ) {
        return yield* failure("VCS diff file contents exceed the public bounds.");
      }
      result = { oldContents: contents.oldContents, newContents: contents.newContents };
    } else {
      return yield* failure("VCS diff API method is unavailable.");
    }
    yield* Effect.tryPromise({
      try: () => metadata.assertAuthority?.() ?? Promise.resolve(),
      catch: () => failure("VCS authority was revoked."),
    });
    yield* resolve(scope.context);
    signal.throwIfAborted();
    return result;
  });

  return {
    providerId: "t3.host-vcs-diff",
    definition: VCS_DIFF_API,
    requiresRootAuthority: true,
    invoke: (method, input, context, signal, metadata) =>
      Effect.runPromise(invoke(method, input, context, signal, metadata), { signal }),
    subscribe: (name, input, context, signal, metadata, resumeCursor) => {
      if (name !== "streamPreview" && name !== "streamFileContents")
        throw failure("VCS diff stream is unavailable.");
      if (resumeCursor !== undefined) throw failure("VCS diff stream resume is unsupported.");
      // Authority first, like the unary path — an unauthorized caller must
      // not learn whether its input parses.
      if (!authorized(metadata.principal) || !metadata.assertAuthority)
        throw failure("VCS authority is unavailable.");
      const assertAuthority = metadata.assertAuthority;
      const safe = (() => {
        try {
          return name === "streamPreview"
            ? ({ kind: "preview", input: previewInput(input) } as const)
            : ({ kind: "fileContents", input: fileContentsInput(input) } as const);
        } catch {
          throw failure("Invalid VCS diff stream request.");
        }
      })();
      return (async function* (): AsyncGenerator<ApiStreamEvent> {
        const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect, { signal });
        signal.throwIfAborted();
        const scope = await run(resolve(context));
        // The unary discipline stretched over a finite transfer: re-resolve the
        // scope and re-assert authority at each frame boundary so a revoked
        // principal or moved workspace stops the stream mid-flight.
        const guard = async () => {
          signal.throwIfAborted();
          await run(resolve(scope.context));
          await assertAuthority();
        };
        if (safe.kind === "preview") {
          const preview = await run(
            dependencies.review
              .getDiffPreview({
                cwd: scope.cwd,
                ...(safe.input.baseRef === undefined ? {} : { baseRef: safe.input.baseRef }),
                ...(safe.input.ignoreWhitespace === undefined
                  ? {}
                  : { ignoreWhitespace: safe.input.ignoreWhitespace }),
              })
              .pipe(Effect.mapError(operationError)),
          );
          yield* streamDiffPreview({
            sources: preview.sources,
            generatedAt: DateTime.formatIso(preview.generatedAt),
            guard,
          });
          return;
        }
        const contents = await run(
          dependencies.review
            .getDiffFileContents({ cwd: scope.cwd, ...safe.input })
            .pipe(Effect.mapError(operationError)),
        );
        if (
          contents.oldContents.length > MAX_FILE_CONTENTS_CHARS ||
          contents.newContents.length > MAX_FILE_CONTENTS_CHARS
        ) {
          throw failure("VCS diff file contents exceed the public bounds.");
        }
        const sides = [
          { side: "old" as const, contents: contents.oldContents },
          { side: "new" as const, contents: contents.newContents },
        ].map((entry) => ({ ...entry, chunks: splitStreamChunks(entry.contents) }));
        const manifest: VcsDiffFileContentsStreamEvent = {
          kind: "manifest",
          oldByteLength: Buffer.byteLength(contents.oldContents, "utf8"),
          oldChunkCount: sides[0]!.chunks.length,
          newByteLength: Buffer.byteLength(contents.newContents, "utf8"),
          newChunkCount: sides[1]!.chunks.length,
        };
        assertStreamFrameFits(manifest);
        yield { type: "snapshot", value: manifest };
        for (const { side, chunks } of sides) {
          for (const [chunkIndex, data] of chunks.entries()) {
            await guard();
            const chunk: VcsDiffFileContentsStreamEvent = {
              kind: "chunk",
              side,
              chunkIndex,
              data,
            };
            assertStreamFrameFits(chunk);
            yield { type: "data", value: chunk };
          }
        }
        const complete: VcsDiffFileContentsStreamEvent = {
          kind: "complete",
          oldSha256: NodeCrypto.createHash("sha256")
            .update(sides[0]!.contents, "utf8")
            .digest("hex"),
          newSha256: NodeCrypto.createHash("sha256")
            .update(sides[1]!.contents, "utf8")
            .digest("hex"),
        };
        await guard();
        yield { type: "data", value: complete };
      })();
    },
  };
}

export const makeVcsDiffApiProvider = Effect.fn("VcsDiffApi.make")(function* () {
  const environment = yield* ServerEnvironment;
  return createVcsDiffApiProvider({
    environmentId: yield* environment.getEnvironmentId,
    projects: yield* ProjectionProjectRepository,
    threads: yield* ProjectionThreadRepository,
    review: yield* ReviewService,
  });
});

/** Shared checkpoint and repository diff transport; hashes describe delivered text. */
export async function* streamDiffPreview(input: {
  readonly sources: readonly Parameters<typeof toPublicSource>[0][];
  readonly generatedAt: string;
  readonly guard: () => Promise<void>;
}): AsyncGenerator<ApiStreamEvent> {
  const sources = input.sources.map(toPublicSource).map((source) => ({
    source,
    chunks: splitStreamChunks(source.diff),
  }));
  const manifest: VcsDiffPreviewStreamEvent = {
    kind: "manifest",
    generatedAt: input.generatedAt,
    sources: sources.map(({ source, chunks }): VcsDiffStreamSource => ({
      id: source.id,
      kind: source.kind,
      title: source.title,
      baseRef: source.baseRef,
      headRef: source.headRef,
      truncated: source.truncated,
      diffHash: source.diffHash,
      diffByteLength: Buffer.byteLength(source.diff, "utf8"),
      chunkCount: chunks.length,
    })),
  };
  assertStreamFrameFits(manifest);
  await input.guard();
  yield { type: "snapshot", value: manifest };
  const payloadHash = NodeCrypto.createHash("sha256");
  for (const [sourceIndex, { chunks }] of sources.entries()) {
    for (const [chunkIndex, data] of chunks.entries()) {
      await input.guard();
      payloadHash.update(data, "utf8");
      const chunk: VcsDiffPreviewStreamEvent = {
        kind: "chunk",
        sourceIndex,
        chunkIndex,
        data,
      };
      assertStreamFrameFits(chunk);
      yield { type: "data", value: chunk };
    }
  }
  const complete: VcsDiffPreviewStreamEvent = {
    kind: "complete",
    payloadSha256: payloadHash.digest("hex"),
  };
  await input.guard();
  yield { type: "data", value: complete };
}
