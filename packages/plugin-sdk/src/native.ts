import type { EnvironmentId, PluginManifest } from "@t3tools/contracts";
import type * as React from "react";
import type { ComponentType } from "react";
// oxlint-disable-next-line eslint/no-restricted-imports -- Native plugins receive the whole react-native module from the host.
import type * as ReactNative from "react-native";
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type { ClientPluginServices, PluginDisposer } from "./common.ts";

export type { ClientPluginServices as NativePluginServices, PluginDisposer } from "./common.ts";

/** Metro bundles executable native entries; downloaded entries use declarative native views. */
export interface NativePluginHost {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly React: typeof React;
  readonly ReactNative: typeof ReactNative;
  readonly Effect: typeof Effect;
  readonly Schema: typeof Schema;
  readonly services: ClientPluginServices & { readonly host: ClientPluginServices };
  readonly getBuiltin: <Props extends object>(slot: string) => ComponentType<Props> | undefined;
  readonly register: <Props extends object>(
    slot: string,
    component: ComponentType<Props>,
    options?: { readonly id?: string; readonly order?: number },
  ) => void;
  readonly invoke: (
    environmentId: EnvironmentId,
    method: string,
    input?: unknown,
  ) => Promise<unknown>;
  readonly onDispose: (dispose: PluginDisposer) => void;
}
export interface NativePluginDefinition {
  readonly manifest: PluginManifest;
  readonly activate: (host: NativePluginHost) => void | Promise<void>;
}
