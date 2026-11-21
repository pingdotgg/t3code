import type { OrchestrationV2StoredEvent, ThreadId } from "@t3tools/contracts";
import type { ProviderDriver } from "@t3tools/provider-core/server/driver";
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import type { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { PluginDisposer, PluginServices } from "./common.ts";

export type {
  ProviderDriver,
  ProviderDriverCreateInput,
  ProviderDriverMetadata,
  ProviderInstance,
} from "@t3tools/provider-core/server/driver";
export type { PluginDisposer, PluginServices } from "./common.ts";
export type {
  PluginServiceDefinition,
  PluginServiceFactory,
  PluginServiceFactoryContext,
  PluginServiceWrapper,
} from "@t3tools/shared/pluginKernel";

/** Plugin command and event Effects cannot leave uncaptured service requirements. */
export type ExternalPluginEffect = Effect.Effect<unknown, unknown>;
export interface PluginCommand<Input = unknown, Output = unknown> {
  readonly input?: Schema.Codec<Input, unknown>;
  readonly output?: Schema.Codec<Output, unknown>;
  readonly run: (input: Input) => Output | Promise<Output> | Effect.Effect<Output, unknown>;
}
export interface PluginEventFilter {
  readonly eventType?: OrchestrationV2StoredEvent["event"]["type"];
  readonly threadId?: ThreadId;
}
export type PluginEventHandler = (
  event: OrchestrationV2StoredEvent,
) => ExternalPluginEffect | Promise<unknown> | void;

export interface ServerPluginHost<ProviderEnvironment = never> {
  readonly id: string;
  readonly Effect: typeof Effect;
  readonly Schema: typeof Schema;
  readonly Stream: typeof Stream;
  readonly Scope: typeof Scope;
  readonly events: {
    readonly on: (filter: PluginEventFilter, handler: PluginEventHandler) => void;
  };
  readonly http: {
    readonly Response: typeof HttpServerResponse;
    readonly register: (
      method: string,
      path: string,
      run: (request: HttpServerRequest.HttpServerRequest) => unknown,
    ) => void;
  };
  readonly services: PluginServices;
  readonly commands: {
    readonly register: <Input, Output>(name: string, command: PluginCommand<Input, Output>) => void;
    readonly wrap: (
      pluginId: string,
      method: string,
      run: (input: unknown, next: () => ExternalPluginEffect) => unknown,
    ) => void;
  };
  readonly providers: {
    readonly register: <Config, UsageEnvironment>(
      driver: ProviderDriver<Config, ProviderEnvironment, UsageEnvironment>,
    ) => void;
    readonly getBuiltin: (
      driverKind: string,
    ) => ProviderDriver<unknown, ProviderEnvironment, unknown> | undefined;
  };
  readonly onDispose: (dispose: PluginDisposer) => void;
}
export interface ServerPluginDefinition<Host = ServerPluginHost> {
  readonly activate: (host: Host) => ExternalPluginEffect | Promise<void> | void;
}
