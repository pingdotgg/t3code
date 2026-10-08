/**
 * Provider event logging as the server offers it to drivers: one stream for
 * the provider's native protocol frames and one for canonical orchestration
 * events. Either logger is absent when diagnostics logging could not start.
 *
 * @module provider-core/server/ProviderEventLoggers
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface EventNdjsonLogger {
  readonly filePath: string;
  readonly write: (event: unknown, threadId: ThreadId | null) => Effect.Effect<void>;
  readonly close: () => Effect.Effect<void>;
}

export class ProviderEventLoggers extends Context.Service<
  ProviderEventLoggers,
  {
    readonly native: EventNdjsonLogger | undefined;
    readonly canonical: EventNdjsonLogger | undefined;
  }
>()("@t3tools/provider-core/server/ProviderEventLoggers") {}

/** Logging turned off: for tests and boot layers that skip diagnostics. */
export const NoOpProviderEventLoggers: ProviderEventLoggers["Service"] = {
  native: undefined,
  canonical: undefined,
};
