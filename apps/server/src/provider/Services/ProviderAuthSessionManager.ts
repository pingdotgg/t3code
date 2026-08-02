import type {
  ProviderAuthAttachInput,
  ProviderAuthAttachStreamEvent,
  ProviderAuthCancelInput,
  ProviderAuthError,
  ProviderAuthResizeInput,
  ProviderAuthSessionSnapshot,
  ProviderAuthStartInput,
  ProviderAuthWriteInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export class ProviderAuthSessionManager extends Context.Service<
  ProviderAuthSessionManager,
  {
    readonly start: (
      input: ProviderAuthStartInput,
    ) => Effect.Effect<ProviderAuthSessionSnapshot, ProviderAuthError>;
    readonly attachStream: (
      input: ProviderAuthAttachInput,
      listener: (event: ProviderAuthAttachStreamEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void, ProviderAuthError>;
    readonly write: (input: ProviderAuthWriteInput) => Effect.Effect<void, ProviderAuthError>;
    readonly resize: (input: ProviderAuthResizeInput) => Effect.Effect<void, ProviderAuthError>;
    readonly cancel: (input: ProviderAuthCancelInput) => Effect.Effect<void, ProviderAuthError>;
  }
>()("t3/provider/Services/ProviderAuthSessionManager") {}
