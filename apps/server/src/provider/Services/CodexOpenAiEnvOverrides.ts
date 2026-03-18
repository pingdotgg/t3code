import { Effect, Layer, Ref, ServiceMap } from "effect";
import type { CodexSetOpenAiEnvResult } from "@t3tools/contracts";

export interface CodexOpenAiEnvOverridesState {
  readonly openaiApiKey: string | null;
  readonly openaiBaseUrl: string | null;
}

export interface CodexOpenAiEnvOverridesShape {
  readonly get: Effect.Effect<CodexOpenAiEnvOverridesState>;
  readonly set: (
    input: Readonly<CodexOpenAiEnvOverridesState>,
  ) => Effect.Effect<CodexSetOpenAiEnvResult>;
}

export class CodexOpenAiEnvOverrides extends ServiceMap.Service<
  CodexOpenAiEnvOverrides,
  CodexOpenAiEnvOverridesShape
>()("t3/provider/Services/CodexOpenAiEnvOverrides") {}

export const CodexOpenAiEnvOverridesLive = Layer.effect(
  CodexOpenAiEnvOverrides,
  Effect.gen(function* () {
    const ref = yield* Ref.make<CodexOpenAiEnvOverridesState>({
      openaiApiKey: null,
      openaiBaseUrl: null,
    });

    const get: CodexOpenAiEnvOverridesShape["get"] = Ref.get(ref);
    const set: CodexOpenAiEnvOverridesShape["set"] = (input) =>
      Ref.set(ref, {
        openaiApiKey: input.openaiApiKey,
        openaiBaseUrl: input.openaiBaseUrl,
      }).pipe(
        Effect.as({
          openaiApiKeySet: Boolean(input.openaiApiKey && input.openaiApiKey.trim().length > 0),
          openaiBaseUrl: input.openaiBaseUrl,
        }),
      );

    return { get, set } satisfies CodexOpenAiEnvOverridesShape;
  }),
);
