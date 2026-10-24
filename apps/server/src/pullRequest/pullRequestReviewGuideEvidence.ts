import { TextGenerationError, type GitCommandError } from "@t3tools/contracts";
import type { ReviewGuideStackLayer } from "@t3tools/provider-core/server/textGeneration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { PATCH_RENDER_PREFIX_ARGS } from "../vcs/GitVcsDriverCore.ts";

const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
const EVIDENCE_SIZE_DETAIL = "Complete review guide evidence exceeds the 64 MiB limit.";
const CHUNK_BYTES = 32 * 1024;
// Native readers sniff image signatures regardless of extension, even in continuation chunks.
const CHUNK_PREAMBLE = Buffer.from("T3 review guide evidence\n", "utf8");
const encodePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const encodeManifest = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

export const reviewGuideGitError = (cause: GitCommandError, detail: string) =>
  new TextGenerationError({
    operation: "generateReviewGuide",
    detail: cause.outputLength === undefined ? detail : EVIDENCE_SIZE_DETAIL,
    cause,
  });

export const REVIEW_GUIDE_DIFF_ARGS = [
  "--no-pager",
  "-c",
  "core.quotePath=false",
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  ...PATCH_RENDER_PREFIX_ARGS,
] as const;

interface EvidenceStream {
  readonly kind: "changedPaths" | "stat" | "history" | "patch" | "stackComparison";
  readonly headCommit?: string;
  readonly bytes: number;
  readonly chunks: Array<{
    file: string;
    offset: number;
    payloadOffset: number;
    bytes: number;
    startsMidLine: boolean;
    endsMidLine: boolean;
  }>;
}

export const prepareReviewGuideEvidence = Effect.fn(
  "PullRequestReviewGuideService.prepareEvidence",
)(
  function* (input: {
    readonly directory: string;
    readonly path: string;
    readonly baseCommit: string;
    readonly headCommit: string;
    readonly stack: ReadonlyArray<ReviewGuideStackLayer>;
    readonly change: Effect.Effect<{ nameOnly: string; patch: string }, TextGenerationError>;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const directory = `${input.directory}/evidence`;
    yield* fs.makeDirectory(directory).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: "generateReviewGuide",
            detail: "Could not create the review guide evidence directory.",
            cause,
          }),
      ),
    );
    let bytesWritten = 0;
    const streams: Array<EvidenceStream> = [];
    const sizeError = () =>
      new TextGenerationError({
        operation: "generateReviewGuide",
        detail: EVIDENCE_SIZE_DETAIL,
      });
    // All chunk writes belong to the preparation span; tracing every chunk adds no useful boundary.
    const writeStream = Effect.fnUntraced(function* (
      kind: EvidenceStream["kind"],
      text: string,
      headCommit?: string,
    ) {
      const bytes = Buffer.from(text, "utf8");
      if (bytesWritten + bytes.length > MAX_EVIDENCE_BYTES) return yield* sizeError();
      const stream: EvidenceStream = {
        kind,
        ...(headCommit === undefined ? {} : { headCommit }),
        bytes: bytes.length,
        chunks: [],
      };
      for (let offset = 0; offset < bytes.length;) {
        let end = Math.min(offset + CHUNK_BYTES - CHUNK_PREAMBLE.length, bytes.length);
        if (end < bytes.length) {
          const newline = bytes.subarray(offset, end).lastIndexOf(10);
          if (newline >= 0) end = offset + newline + 1;
          else while ((bytes[end]! & 0xc0) === 0x80) end--;
        }
        const file = `${streams.length}-${stream.chunks.length}.txt`;
        const framed = Buffer.concat([CHUNK_PREAMBLE, bytes.subarray(offset, end)]);
        if (bytesWritten + framed.length > MAX_EVIDENCE_BYTES) return yield* sizeError();
        yield* fs.writeFile(`${directory}/${file}`, framed).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: "generateReviewGuide",
                detail: `Could not write review guide ${kind} evidence chunk ${file}.`,
                cause,
              }),
          ),
        );
        bytesWritten += framed.length;
        stream.chunks.push({
          file,
          offset,
          payloadOffset: CHUNK_PREAMBLE.length,
          bytes: end - offset,
          startsMidLine: offset > 0 && bytes[offset - 1] !== 10,
          endsMidLine: end < bytes.length && bytes[end - 1] !== 10,
        });
        offset = end;
      }
      streams.push(stream);
    });
    const read = (kind: EvidenceStream["kind"], args: ReadonlyArray<string>, headCommit?: string) =>
      git
        .execute({
          operation: "PullRequestReviewGuideService.readEvidence",
          cwd: input.path,
          args,
          timeoutMs: 60_000,
          maxOutputBytes: Math.max(1, MAX_EVIDENCE_BYTES - bytesWritten),
        })
        .pipe(
          Effect.map((result) => result.stdout),
          Effect.mapError((cause) =>
            reviewGuideGitError(
              cause,
              `Could not read review guide ${kind} evidence${headCommit === undefined ? "" : ` for pinned stack head ${headCommit}`}.`,
            ),
          ),
        );

    const change = yield* input.change;
    yield* writeStream(
      "changedPaths",
      change.nameOnly
        .split("\0")
        .filter((path) => path !== "")
        .map((path) => `${encodePath(path)}\n`)
        .join(""),
    );
    yield* writeStream("patch", change.patch);
    yield* writeStream(
      "stat",
      yield* read("stat", [
        ...REVIEW_GUIDE_DIFF_ARGS,
        "--stat",
        `${input.baseCommit}...${input.headCommit}`,
        "--",
      ]),
    );
    yield* writeStream(
      "history",
      yield* read("history", [
        "--no-pager",
        "log",
        "--no-show-signature",
        "--no-color",
        "--format=%h %s",
        `${input.baseCommit}..${input.headCommit}`,
        "--",
      ]),
    );
    const compared = new Set([input.headCommit]);
    for (const layer of input.stack) {
      if (layer.headSha === null || compared.has(layer.headSha)) continue;
      compared.add(layer.headSha);
      yield* writeStream(
        "stackComparison",
        // A stale layer contributes its branch changes, without reversing unrelated main drift.
        yield* read(
          "stackComparison",
          [...REVIEW_GUIDE_DIFF_ARGS, `${input.headCommit}...${layer.headSha}`, "--"],
          layer.headSha,
        ),
        layer.headSha,
      );
    }
    const manifest = encodeManifest({
      version: 1,
      baseCommit: input.baseCommit,
      headCommit: input.headCommit,
      stack: input.stack.map(({ number, state, headSha }) => ({ number, state, headSha })),
      streams,
    });
    if (bytesWritten + Buffer.byteLength(manifest, "utf8") > MAX_EVIDENCE_BYTES) {
      return yield* sizeError();
    }
    // The descriptor is published only after all streams and their index are complete.
    const manifestPath = `${directory}/manifest.json`;
    yield* fs.writeFileString(manifestPath, manifest).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: "generateReviewGuide",
            detail: "Could not write the review guide evidence manifest.json.",
            cause,
          }),
      ),
    );
    return { manifestPath, headCommit: input.headCommit };
  },
  Effect.timeoutOrElse({
    duration: 60_000,
    orElse: () =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateReviewGuide",
          detail: "Review guide evidence preparation timed out after 60 seconds.",
        }),
      ),
  }),
);
