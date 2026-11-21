import type {
  PluginServiceDefinition,
  PluginServiceFactory,
  PluginServiceWrapper,
} from "@t3tools/shared/pluginKernel";

export type PluginDisposer = () => void | Promise<void>;

export interface PluginServiceRegistration {
  readonly register: (key: string, factory: PluginServiceFactory) => void;
  readonly replace: (key: string, factory: PluginServiceFactory) => void;
  readonly wrap: (key: string, member: string, run: PluginServiceWrapper) => void;
}

/** Service discovery is opaque until the owning service contract is known. */
export interface PluginServices extends PluginServiceRegistration {
  readonly list: () => readonly PluginServiceDefinition[];
  readonly get: (key: string) => unknown;
  readonly getBuiltin: (key: string) => unknown;
}

export interface ClientPluginServices extends PluginServiceRegistration {
  readonly list: () => Promise<readonly PluginServiceDefinition[]>;
  readonly get: (key: string) => Promise<unknown>;
  readonly getBuiltin: (key: string) => Promise<unknown>;
}

export interface PluginContributionMetadata {
  readonly pluginId: string;
  readonly slot: string;
  readonly id: string;
  readonly order: number;
}
