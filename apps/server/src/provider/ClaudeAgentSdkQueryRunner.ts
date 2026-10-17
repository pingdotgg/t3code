import { cacheInOwnerScope } from "@t3tools/shared/lazyService";
import type { ForkSessionResult } from "@anthropic-ai/claude-agent-sdk";
import type {
  ClaudeAgentSdkQueryRunnerError,
  ClaudeAgentSdkQueryOpenInput,
  ClaudeAgentSdkQuerySession,
  ClaudeAgentSdkSessionForkInput,
  ClaudeAgentSdkSubagentLookupInput,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class ClaudeAgentSdkQueryRunner extends Context.Service<
  ClaudeAgentSdkQueryRunner,
  {
    readonly allocateSessionId: Effect.Effect<string, ClaudeAgentSdkQueryRunnerError>;
    readonly open: (
      input: ClaudeAgentSdkQueryOpenInput,
    ) => Effect.Effect<ClaudeAgentSdkQuerySession, ClaudeAgentSdkQueryRunnerError>;
    readonly forkSession: (
      input: ClaudeAgentSdkSessionForkInput,
    ) => Effect.Effect<ForkSessionResult, ClaudeAgentSdkQueryRunnerError>;
    /** The tool call that launched a subagent, read from the CLI's session storage. */
    readonly subagentLaunchToolUseId: (
      input: ClaudeAgentSdkSubagentLookupInput,
    ) => Effect.Effect<string | null, ClaudeAgentSdkQueryRunnerError>;
    readonly assertComplete: Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
  }
>()("t3/provider/ClaudeAgentSdkQueryRunner") {}

export const layer = Layer.effect(
  ClaudeAgentSdkQueryRunner,
  Effect.gen(function* () {
    const service = yield* cacheInOwnerScope(
      Effect.promise(() => import("../orchestration-v2/Adapters/ClaudeAdapterV2.ts")).pipe(
        Effect.flatMap((adapter) => Layer.build(adapter.layerQueryRunner)),
        Effect.map((services) => Context.get(services, ClaudeAgentSdkQueryRunner)),
      ),
    );
    return ClaudeAgentSdkQueryRunner.of({
      allocateSessionId: service.pipe(Effect.flatMap((value) => value.allocateSessionId)),
      open: (input) => service.pipe(Effect.flatMap((value) => value.open(input))),
      forkSession: (input) => service.pipe(Effect.flatMap((value) => value.forkSession(input))),
      subagentLaunchToolUseId: (input) =>
        service.pipe(Effect.flatMap((value) => value.subagentLaunchToolUseId(input))),
      assertComplete: service.pipe(Effect.flatMap((value) => value.assertComplete)),
    });
  }),
);
