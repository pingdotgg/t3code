import {
  ProviderDriverKind,
  ProviderReplayEntry,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import type { ProviderReplayGate } from "../testkit/ProviderReplayGate.testkit.ts";
import { ACP_PROTOCOL, type AcpAdapterV2RuntimeInput } from "./AcpAdapterV2.ts";

export const AcpReplayTranscript = Schema.Struct({
  provider: ProviderDriverKind,
  protocol: Schema.Literal(ACP_PROTOCOL),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(ProviderReplayEntry),
});
export type AcpReplayTranscript = typeof AcpReplayTranscript.Type;

const decodeAcpReplayTranscriptSchema = Schema.decodeUnknownEffect(AcpReplayTranscript);
const encodeReplayTranscriptJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export class AcpReplayTranscriptDecodeError extends Schema.TaggedError<AcpReplayTranscriptDecodeError>()(
  "AcpReplayTranscriptDecodeError",
  {
    expectedProvider: ProviderDriverKind,
    driver: Schema.optional(Schema.String),
    protocol: Schema.optional(Schema.String),
    scenario: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode ${this.expectedProvider} ACP replay transcript for scenario ${this.scenario ?? "<unknown>"}.`;
  }
}

const isAcpReplayTranscriptDecodeError = Schema.is(AcpReplayTranscriptDecodeError);

function metadataFromTranscript(transcript: ProviderReplayTranscript): {
  readonly provider?: string;
  readonly protocol?: string;
  readonly scenario?: string;
} {
  return {
    provider: transcript.provider,
    protocol: transcript.protocol,
    scenario: transcript.scenario,
  };
}

export function decodeAcpReplayTranscript(
  transcript: ProviderReplayTranscript,
  expectedProvider: ProviderDriverKind,
  options: { readonly retargetProvider?: boolean } = {},
): Effect.Effect<AcpReplayTranscript, AcpReplayTranscriptDecodeError> {
  const candidate = options.retargetProvider
    ? { ...transcript, provider: expectedProvider }
    : transcript;
  return decodeAcpReplayTranscriptSchema(candidate).pipe(
    Effect.filterOrFail(
      (decoded) => decoded.provider === expectedProvider,
      () =>
        new AcpReplayTranscriptDecodeError({
          expectedProvider,
          ...metadataFromTranscript(transcript),
          cause: `Expected provider ${expectedProvider}, received ${transcript.provider}`,
        }),
    ),
    Effect.mapError((cause) =>
      isAcpReplayTranscriptDecodeError(cause)
        ? cause
        : new AcpReplayTranscriptDecodeError({
            expectedProvider,
            ...metadataFromTranscript(transcript),
            cause,
          }),
    ),
  );
}

interface ReplayStatus {
  readonly cursor: number;
  readonly total: number;
  readonly failure?: unknown;
}

function decodeReplayStatus(raw: string): ReplayStatus {
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== "object" ||
    value === null ||
    typeof Reflect.get(value, "cursor") !== "number" ||
    typeof Reflect.get(value, "total") !== "number"
  ) {
    throw new Error("ACP replay status is malformed.");
  }
  return value as ReplayStatus;
}

export function makeAcpReplayCompletenessAssertion(
  fileSystem: FileSystem.FileSystem,
  statusPath: string,
  transcript: AcpReplayTranscript,
): Effect.Effect<void, EffectAcpErrors.AcpError> {
  return fileSystem.readFileString(statusPath).pipe(
    Effect.mapError(
      (cause) =>
        new EffectAcpErrors.AcpTransportError({
          detail: `Failed to read ACP replay status for ${transcript.scenario}`,
          cause,
        }),
    ),
    Effect.flatMap((raw) =>
      Effect.try({
        try: () => decodeReplayStatus(raw),
        catch: (cause) =>
          new EffectAcpErrors.AcpTransportError({
            detail: `Failed to decode ACP replay status for ${transcript.scenario}`,
            cause,
          }),
      }),
    ),
    Effect.flatMap((status) => {
      if (
        status.failure === undefined &&
        status.cursor === transcript.entries.length &&
        status.total === transcript.entries.length
      ) {
        return Effect.void;
      }
      return Effect.fail(
        new EffectAcpErrors.AcpTransportError({
          detail: `ACP replay did not consume all frames for ${transcript.scenario}`,
          cause: status,
        }),
      );
    }),
  );
}

function acpReplayAgentArgs(scriptPath: string): ReadonlyArray<string> {
  return ["--experimental-strip-types", scriptPath];
}

/**
 * Holds the replay agent's inbound lines at a gate the scenario releases.
 * The agent writes one line per `emit_inbound` entry in transcript order, so
 * the Nth line it writes belongs to the Nth inbound entry and carries its
 * label. Lines after a held one wait with it, which keeps wire order.
 */
function holdGatedReplayLines(
  transcript: AcpReplayTranscript,
  replayGate: ProviderReplayGate,
): NonNullable<AcpSessionRuntime.AcpSessionRuntimeOptions["transformStdout"]> {
  const inboundLabels = transcript.entries.flatMap((entry) =>
    entry.type === "emit_inbound" ? [entry.label] : [],
  );
  let inboundIndex = 0;
  const encoder = new TextEncoder();
  return (stdout) =>
    stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.mapEffect((line) => {
        const label = line.trim().length === 0 ? undefined : inboundLabels[inboundIndex++];
        return Effect.promise((signal) => replayGate.beforeEmit(label, signal)).pipe(
          Effect.as(encoder.encode(`${line}\n`)),
        );
      }),
    );
}

export function makeAcpReplayRuntime(input: {
  readonly transcript: AcpReplayTranscript;
  readonly statusPath: string;
  readonly scriptPath: string;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly cancelMeta?: AcpSessionRuntime.AcpSessionRuntimeOptions["cancelMeta"];
  readonly replayGate?: ProviderReplayGate;
}): (
  runtimeInput: AcpAdapterV2RuntimeInput,
) => Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> {
  // Recorded transcripts outgrow the kernel's 128 KiB limit on one environment
  // variable, so the agent reads the transcript from a file beside its status.
  const transcriptPath = `${input.statusPath}.transcript.json`;
  return (runtimeInput) =>
    Effect.gen(function* () {
      yield* input.fileSystem
        .writeFileString(transcriptPath, encodeReplayTranscriptJson(input.transcript))
        .pipe(
          Effect.mapError(
            (cause) =>
              new EffectAcpErrors.AcpTransportError({
                detail: `Failed to write ACP replay transcript for ${input.transcript.scenario}`,
                cause,
              }),
          ),
        );
      const context = yield* Layer.build(
        AcpSessionRuntime.layer({
          ...runtimeInput,
          spawn: {
            command: process.execPath,
            args: acpReplayAgentArgs(input.scriptPath),
            cwd: runtimeInput.cwd,
            env: {
              ...process.env,
              T3_ACP_REPLAY_TRANSCRIPT_PATH: transcriptPath,
              T3_ACP_REPLAY_STATUS_PATH: input.statusPath,
              T3_ACP_REPLAY_WORKSPACE: runtimeInput.cwd,
            },
          },
          authMethodId: "replay",
          ...(input.cancelMeta === undefined ? {} : { cancelMeta: input.cancelMeta }),
          ...(input.replayGate === undefined
            ? {}
            : { transformStdout: holdGatedReplayLines(input.transcript, input.replayGate) }),
        }).pipe(
          Layer.provide(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
          ),
        ),
      );
      return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(context),
      );
    });
}
