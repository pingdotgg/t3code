import type {
  SourceControlSshPasswordPromptRequest,
  SourceControlSshPasswordPromptResolutionInput,
} from "@t3tools/contracts";
import { SshPasswordPrompt, type SshPasswordRequest } from "@t3tools/ssh/auth";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

const DEFAULT_PROMPT_TIMEOUT_MS = 3 * 60 * 1_000;

interface PendingPrompt {
  readonly deferred: Deferred.Deferred<string | null>;
}

export interface SourceControlSshPasswordPromptsOptions {
  readonly promptTimeoutMs?: number;
}

export class SourceControlSshPasswordPrompts extends Context.Service<
  SourceControlSshPasswordPrompts,
  {
    readonly makePrompt: (
      publish: (request: SourceControlSshPasswordPromptRequest) => Effect.Effect<void>,
    ) => SshPasswordPrompt["Service"];
    readonly resolve: (input: SourceControlSshPasswordPromptResolutionInput) => Effect.Effect<void>;
  }
>()("t3/sourceControl/SourceControlSshPasswordPrompts") {}

export const make = Effect.fn("SourceControlSshPasswordPrompts.make")(function* (
  options: SourceControlSshPasswordPromptsOptions = {},
) {
  const pending = yield* Ref.make(new Map<string, PendingPrompt>());
  const nextRequestSequence = yield* Ref.make(1);
  const promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;

  const removePending = (requestId: string) =>
    Ref.modify(pending, (entries) => {
      const entry = entries.get(requestId);
      if (entry === undefined) {
        return [undefined, entries] as const;
      }
      const next = new Map(entries);
      next.delete(requestId);
      return [entry, next] as const;
    });

  const resolve = Effect.fn("SourceControlSshPasswordPrompts.resolve")(function* (
    input: SourceControlSshPasswordPromptResolutionInput,
  ) {
    const entry = yield* removePending(input.requestId);
    if (entry !== undefined) {
      yield* Deferred.succeed(entry.deferred, input.password).pipe(Effect.asVoid);
    }
  });

  const makePrompt = (
    publish: (request: SourceControlSshPasswordPromptRequest) => Effect.Effect<void>,
  ): SshPasswordPrompt["Service"] =>
    SshPasswordPrompt.of({
      isAvailable: true,
      request: (input: SshPasswordRequest) =>
        Effect.gen(function* () {
          const sequence = yield* Ref.getAndUpdate(nextRequestSequence, (value) => value + 1);
          const requestId = `source-control-ssh-password-${sequence}`;
          const deferred = yield* Deferred.make<string | null>();
          yield* Ref.update(pending, (entries) => new Map(entries).set(requestId, { deferred }));

          return yield* Effect.gen(function* () {
            const now = yield* DateTime.now;
            yield* publish({
              requestId,
              destination: input.destination,
              username: input.username,
              prompt: input.prompt,
              attempt: input.attempt,
              expiresAt: DateTime.formatIso(DateTime.add(now, { milliseconds: promptTimeoutMs })),
              expiresInMs: promptTimeoutMs,
            });

            return yield* Deferred.await(deferred).pipe(
              Effect.timeoutOption(Duration.millis(promptTimeoutMs)),
              Effect.map(Option.getOrNull),
            );
          }).pipe(Effect.ensuring(removePending(requestId)));
        }),
    });

  return SourceControlSshPasswordPrompts.of({
    makePrompt,
    resolve,
  });
});

export const layer = Layer.effect(SourceControlSshPasswordPrompts, make());
