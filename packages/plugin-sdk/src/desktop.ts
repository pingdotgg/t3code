import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type { PluginDisposer, PluginServices } from "./common.ts";

export type { PluginDisposer, PluginServices } from "./common.ts";
export interface DesktopCommand<Input = unknown, Output = unknown> {
  readonly input?: Schema.Codec<Input, unknown>;
  readonly output?: Schema.Codec<Output, unknown>;
  readonly run: (input: Input) => Output | Promise<Output> | Effect.Effect<Output, unknown>;
}

/** Electron main-process extensions have a separate lifecycle from web contributions. */
export interface DesktopPluginHost {
  readonly id: string;
  readonly Effect: typeof Effect;
  readonly Schema: typeof Schema;
  readonly services: PluginServices;
  readonly commands: {
    readonly register: <Input, Output>(
      method: string,
      command: DesktopCommand<Input, Output>,
    ) => void;
  };
  readonly onDispose: (dispose: PluginDisposer) => void;
}
export interface DesktopPluginDefinition {
  readonly activate: (host: DesktopPluginHost) => void | Promise<void>;
}
