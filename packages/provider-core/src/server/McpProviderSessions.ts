import type { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type { McpProviderSessionConfig } from "./mcpSession.ts";

export class McpProviderSessions extends Context.Service<
  McpProviderSessions,
  {
    readonly set: (config: McpProviderSessionConfig) => Effect.Effect<void>;
    readonly read: (
      threadId: ThreadId,
      providerInstanceId: ProviderInstanceId,
    ) => Effect.Effect<McpProviderSessionConfig | undefined>;
    /**
     * Clears the thread's credentials for every provider instance, or only the
     * one whose credential id is `providerSessionId`.
     */
    readonly clear: (threadId: ThreadId, providerSessionId?: string) => Effect.Effect<void>;
  }
>()("@t3tools/provider-core/server/McpProviderSessions") {}

const make = Effect.gen(function* () {
  const sessions = yield* Ref.make(
    new Map<ThreadId, ReadonlyMap<ProviderInstanceId, McpProviderSessionConfig>>(),
  );
  return McpProviderSessions.of({
    set: (config) =>
      Ref.update(sessions, (current) =>
        new Map(current).set(
          config.threadId,
          new Map(current.get(config.threadId)).set(config.providerInstanceId, config),
        ),
      ),
    read: (threadId, providerInstanceId) =>
      Ref.get(sessions).pipe(
        Effect.map((current) => current.get(threadId)?.get(providerInstanceId)),
      ),
    clear: (threadId, providerSessionId) =>
      Ref.update(sessions, (current) => {
        const next = new Map(current);
        const byInstance = current.get(threadId);
        if (providerSessionId === undefined || byInstance === undefined) {
          next.delete(threadId);
          return next;
        }
        const remaining = new Map(
          Array.from(byInstance).filter(
            ([, config]) => config.providerSessionId !== providerSessionId,
          ),
        );
        if (remaining.size === 0) next.delete(threadId);
        else next.set(threadId, remaining);
        return next;
      }),
  });
});

export const layer = Layer.effect(McpProviderSessions, make);
