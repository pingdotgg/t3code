import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/compat";

const NATIVE_SESSION_ID = /^[\w-]+$/;
const READ_CHUNK_BYTES = 65_536;
const OUTCOME_POLLS = 41;
const OUTCOME_POLL_INTERVAL = "50 millis";
const HIDDEN_WORK_POLL_INTERVAL = "250 millis";
// Kimi writes the next queued turn's `turn.prompt` right after the last one ends.
const HIDDEN_WORK_IDLE_POLLS = 2;

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

const decodeTextPart = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("context.append_loop_event"),
      agentId: Schema.Literal("main"),
      event: Schema.Struct({
        type: Schema.Literal("content.part"),
        part: Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
      }),
    }),
  ),
);

/** A failure Kimi's stop reason hid, or the reply of turns Kimi ran without ACP updates. */
export type KimiPromptOutcome =
  | { readonly failure: OrchestrationV2ProviderFailure }
  | { readonly hiddenReply: string };

const noOutcome = (_result: EffectAcpSchema.PromptResponse, _stopped: Effect.Effect<boolean>) =>
  Effect.succeed<KimiPromptOutcome | undefined>(undefined);

function turnFailure(ended: KimiTurnEnded): OrchestrationV2ProviderFailure | undefined {
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
 * Kimi Code answers failed, steered-away and queued prompts with `end_turn`, and runs the
 * work after a steer or queue without ACP updates. Its main agent's `wire.jsonl` shows what
 * happened, so the check follows it until Kimi is idle and returns that work's reply. Slash
 * commands answer without a turn, so only a prompt sent while a turn is open counts as queued.
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

    return Effect.fn("KimiTurnOutcome.check")(function* (
      result: EffectAcpSchema.PromptResponse,
      stopped: Effect.Effect<boolean>,
    ) {
      if (result.stopReason !== "end_turn") return undefined;
      // A new session's log can first appear with its first prompt.
      const wire = Option.isSome(before) ? before : yield* findWire;
      if (Option.isNone(wire)) return undefined;
      let offset = startOffset;
      // Each read returns only the complete lines appended since the last one.
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
          return bytes.subarray(0, complete).toString("utf8").split("\n").filter(Boolean);
        }),
      );

      let ended: KimiTurnEnded | undefined;
      let steered = false;
      let open = turnOpen;
      // A queued prompt's work starts at its own `turn.prompt`, after Kimi's open turn ends.
      let queuedStarted = false;
      let followingHiddenWork = false;
      let lastEnded: KimiTurnEnded | undefined;
      const replies: Array<string> = [];
      const follow = (lines: ReadonlyArray<string>) => {
        for (const line of lines) {
          if (ended === undefined && !turnOpen && line.includes('"prompt.steered"')) {
            steered ||= Option.isSome(decodePromptSteered(line));
          }
          if (line.includes('"turn.prompt"') || line.includes('"turn.ended"')) {
            const boundary = decodeTurnBoundary(line);
            if (Option.isNone(boundary)) continue;
            const wasOpen = open;
            open = boundary.value.type === "turn.prompt";
            if (open) {
              queuedStarted ||= turnOpen && !wasOpen;
              continue;
            }
            const record = decodeTurnEnded(line);
            if (Option.isNone(record)) continue;
            if (!turnOpen || queuedStarted) lastEnded = record.value;
            ended ??= record.value;
          } else if (
            line.includes('"content.part"') &&
            (turnOpen ? queuedStarted : ended !== undefined)
          ) {
            const part = decodeTextPart(line);
            if (Option.isSome(part)) replies.push(part.value.event.part.text);
          }
        }
      };

      return yield* Effect.gen(function* () {
        // Kimi writes `turn.ended` on a microtask after it answers the prompt.
        if (!turnOpen) {
          for (let poll = 1; poll <= OUTCOME_POLLS; poll++) {
            if (poll > 1) yield* Effect.sleep(OUTCOME_POLL_INTERVAL);
            follow(yield* readAppended);
            if (ended !== undefined) break;
          }
        }
        if (!turnOpen && (!steered || (ended !== undefined && ended.reason !== "completed"))) {
          if (ended === undefined) {
            yield* Effect.logWarning("Kimi's session log has no outcome for this turn.");
            return undefined;
          }
          const failure = turnFailure(ended);
          return failure === undefined ? undefined : { failure };
        }
        // A steered notice or a queued prompt runs in turns Kimi reports only to its log.
        followingHiddenWork = true;
        for (let quiet = 0; quiet < HIDDEN_WORK_IDLE_POLLS;) {
          if (yield* stopped) break;
          yield* Effect.sleep(HIDDEN_WORK_POLL_INTERVAL);
          const lines = yield* readAppended;
          follow(lines);
          quiet = open || lines.length > 0 ? 0 : quiet + 1;
        }
        const failure = lastEnded === undefined ? undefined : turnFailure(lastEnded);
        if (failure !== undefined) return { failure };
        const hiddenReply = replies.join("\n\n").trim();
        return hiddenReply.length === 0 ? undefined : { hiddenReply };
      }).pipe(
        Effect.catch(() =>
          Effect.logWarning("Kimi's session log could not be read for this turn.").pipe(
            Effect.as(
              followingHiddenWork
                ? {
                    failure: makeProviderFailure({
                      class: "provider_error",
                      message:
                        "Kimi kept working after it answered, and T3 Code lost track of that work.",
                      code: null,
                      retryable: null,
                    }),
                  }
                : undefined,
            ),
          ),
        ),
      );
    });
  });
});
