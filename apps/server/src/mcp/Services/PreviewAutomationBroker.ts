import type {
  PreviewAutomationError,
  PreviewAutomationOperation,
  PreviewAutomationOwner,
  PreviewAutomationRequest,
  PreviewAutomationResponse,
  PreviewTabId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { McpInvocationScope } from "./McpInvocationContext.ts";

export interface PreviewAutomationInvokeInput {
  readonly scope: McpInvocationScope;
  readonly operation: PreviewAutomationOperation;
  readonly input: unknown;
  readonly tabId?: PreviewTabId;
  readonly timeoutMs?: number;
}

export interface PreviewAutomationBrokerShape {
  readonly connect: (clientId: string) => Effect.Effect<Stream.Stream<PreviewAutomationRequest>>;
  readonly reportOwner: (
    owner: PreviewAutomationOwner,
  ) => Effect.Effect<void, PreviewAutomationError>;
  readonly clearOwner: (clientId: string) => Effect.Effect<void>;
  readonly respond: (
    response: PreviewAutomationResponse,
  ) => Effect.Effect<void, PreviewAutomationError>;
  readonly invoke: <A = unknown>(
    request: PreviewAutomationInvokeInput,
  ) => Effect.Effect<A, PreviewAutomationError>;
}

export class PreviewAutomationBroker extends Context.Service<
  PreviewAutomationBroker,
  PreviewAutomationBrokerShape
>()("t3/mcp/Services/PreviewAutomationBroker") {}
