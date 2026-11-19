import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/compat";

const NATIVE_SESSION_ID = /^[\w-]+$/;
const READ_CHUNK_BYTES = 65_536;

const KimiTurnEnded = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("turn.ended"),
    agentId: Schema.Literal("main"),
    reason: Schema.String,
    error: Schema.optional(
      Schema.Struct({
        code: Schema.optional(Schema.String),
        message: Schema.optional(Schema.String),
        retryable: Schema.optional(Schema.Boolean),
      }),
    ),
  }),
);
const decodeTurnEnded = Schema.decodeUnknownOption(KimiTurnEnded);
type KimiTurnEnded = typeof KimiTurnEnded.Type;
const decodeTurnBoundary = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literals(["turn.prompt", "turn.ended"]),
      agentId: Schema.Literal("main"),
    }),
  ),
);
const decodePromptSteered = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ type: Schema.Literal("prompt.steered"), agentId: Schema.Literal("main") }),
  ),
);

class KimiTurnNotEnded extends Schema.TaggedError<KimiTurnNotEnded>()("KimiTurnNotEnded", {}) {}

const noOutcome = (_result: EffectAcpSchema.PromptResponse) =>
  Effect.succeed<OrchestrationV2ProviderFailure | undefined>(undefined);

// Kimi runs that work in turns it never reports over ACP, so T3 cannot show it.
const hiddenWorkFailure = (message: string) =>
  makeProviderFailure({ message, code: null, class: "provider_error", retryable: false });

function turnFailure(ended: KimiTurnEnded, steered: boolean) {
  if (steered && ended.reason === "completed") {
    return hiddenWorkFailure(
      "Kimi ended this turn early to handle a background task and kept working out of view. Its further output can't be shown here.",
    );
  }
  if (ended.reason !== "failed") return undefined;
  const code = ended.error?.code;
  return makeProviderFailure({
    message: ended.error?.message ?? "Kimi stopped this turn because of an error.",
    code: code ?? null,
    class:
      code === "provider.rate_limit"
        ? "usage_limit"
        : code === "provider.connection_error"
          ? "transport_error"
          : "provider_error",
    retryable: ended.error?.retryable ?? null,
  });
}

/**
 * Kimi Code answers failed, steered-away and queued prompts with `end_turn`, and runs that
 * work without ACP updates. Its main agent's `wire.jsonl` shows what happened. Slash commands
 * answer without a turn, so only a prompt sent while a turn is open counts as queued.
 */
export const makeKimiPromptOutcomeWatch = Effect.fn("KimiTurnOutcome.make")(function* (
  configuredHome: string | undefined,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sessionsDirectory = path.join(
    configuredHome || path.join(yield* HostProcess.HomeDirectory, ".kimi-code"),
    "sessions",
  );

  return Effect.fn("KimiTurnOutcome.watch")(function* (sessionId: string) {
    if (!NATIVE_SESSION_ID.test(sessionId)) return noOutcome;
    const wirePath = (workspace: string) =>
      path.join(sessionsDirectory, workspace, sessionId, "agents", "main", "wire.jsonl");
    const findWire = fileSystem.readDirectory(sessionsDirectory).pipe(
      Effect.flatMap((workspaces) =>
        Effect.findFirst(workspaces, (workspace) => fileSystem.exists(wirePath(workspace))),
      ),
      Effect.map(Option.map(wirePath)),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    const before = yield* findWire;
    const startOffset = Option.isSome(before)
      ? yield* fileSystem.stat(before.value).pipe(
          Effect.map((info) => info.size),
          Effect.orElseSucceed(() => 0n),
        )
      : 0n;
    // Reads back from the end until the last main-agent `turn.prompt` or `turn.ended`.
    const turnOpen = Option.isNone(before)
      ? false
      : yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fileSystem.open(before.value, { flag: "r" });
            let position = startOffset;
            let carry = Buffer.alloc(0);
            while (position > 0n) {
              const start =
                position > BigInt(READ_CHUNK_BYTES) ? position - BigInt(READ_CHUNK_BYTES) : 0n;
              const chunk = yield* file.readAlloc(Number(position - start), { position: start });
              if (Option.isNone(chunk)) return false;
              const lines = Buffer.concat([chunk.value, carry]).toString("utf8").split("\n");
              carry = start > 0n ? Buffer.from(lines.shift() ?? "", "utf8") : carry;
              for (const line of lines.reverse()) {
                if (!line.includes('"turn.prompt"') && !line.includes('"turn.ended"')) continue;
                const record = decodeTurnBoundary(line);
                if (Option.isSome(record)) return record.value.type === "turn.prompt";
              }
              position = start;
            }
            return false;
          }),
        ).pipe(Effect.orElseSucceed(() => false));

    return Effect.fn("KimiTurnOutcome.check")(function* (result: EffectAcpSchema.PromptResponse) {
      if (result.stopReason !== "end_turn") return undefined;
      // A new session's log can first appear with its first prompt.
      const wire = Option.isSome(before) ? before : yield* findWire;
      if (Option.isNone(wire)) return undefined;
      let offset = startOffset;
      let ended: KimiTurnEnded | undefined;
      let steered = false;
      // Kimi's own unfinished turn ends first; this prompt's outcome follows its `turn.prompt`.
      let started = !turnOpen;
      // Each poll decodes only the complete lines appended since the last one.
      const readAppended = Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fileSystem.open(wire.value, { flag: "r" });
          const chunks: Array<Uint8Array> = [];
          let position = offset;
          while (true) {
            const chunk = yield* file.readAlloc(READ_CHUNK_BYTES, { position });
            if (Option.isNone(chunk) || chunk.value.length === 0) break;
            chunks.push(chunk.value);
            position += BigInt(chunk.value.length);
          }
          const bytes = Buffer.concat(chunks);
          const complete = bytes.lastIndexOf(0x0a) + 1;
          offset += BigInt(complete);
          for (const line of bytes.subarray(0, complete).toString("utf8").split("\n")) {
            if (!started) {
              started =
                line.includes('"turn.prompt"') &&
                Option.exists(decodeTurnBoundary(line), (record) => record.type === "turn.prompt");
              continue;
            }
            if (ended === undefined && line.includes('"prompt.steered"')) {
              steered ||= Option.isSome(decodePromptSteered(line));
            }
            if (!line.includes('"turn.ended"')) continue;
            const record = decodeTurnEnded(line);
            if (Option.isSome(record)) ended ??= record.value;
          }
          if (ended === undefined) return yield* new KimiTurnNotEnded();
          return ended;
        }),
      );
      // Kimi writes `turn.ended` on a microtask after it answers the prompt.
      return yield* readAppended.pipe(
        Effect.retry({
          times: 40,
          schedule: Schedule.spaced("50 millis"),
          while: (error) => error._tag === "KimiTurnNotEnded",
        }),
        Effect.map((ended) => turnFailure(ended, steered)),
        Effect.catchTags({
          KimiTurnNotEnded: (error) =>
            turnOpen
              ? Effect.succeed(
                  hiddenWorkFailure(
                    "Kimi queued this message behind work it was still doing and answered before running it. Its reply can't be shown here.",
                  ),
                )
              : Effect.fail(error),
        }),
        Effect.catch(() =>
          Effect.logWarning("Kimi's session log has no outcome for this turn.").pipe(
            Effect.as(undefined),
          ),
        ),
      );
    });
  });
});
