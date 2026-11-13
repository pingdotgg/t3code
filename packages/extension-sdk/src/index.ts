import type {
  ProjectSnapshot,
  ThreadShellSnapshot,
  ThreadSnapshot,
  OrchestrationCommand,
  DispatchResult,
  ServerSettings,
  ServerSettingsPatch,
} from "./hostApi.generated.ts";
export type * from "./hostApi.generated.ts";
export interface ExtensionHostApi {
  "projects.list": { input: Record<string, never>; result: ProjectSnapshot };
  "threads.list": { input: Record<string, never>; result: ThreadShellSnapshot };
  "threads.get": { input: { readonly threadId: string }; result: ThreadSnapshot };
  "orchestration.dispatch": { input: OrchestrationCommand; result: DispatchResult };
  "settings.get": { input: Record<string, never>; result: ServerSettings };
  "settings.update": { input: ServerSettingsPatch; result: ServerSettings };
}

export const EXTENSION_API_VERSION = 1;

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };
export type JsonObject = { readonly [key: string]: Json };
export interface InvocationContext {
  readonly threadId?: string;
  readonly projectId?: string;
  readonly surface?: "web" | "desktop" | "mobile" | "agent";
}
export interface ExtensionCommand {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema?: JsonObject;
  readonly menu?: "thread" | "project";
}
export interface ExtensionTool {
  readonly id: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}
export interface ExtensionPanel {
  readonly id: string;
  readonly title: string;
  readonly entry: string;
}
export interface ExtensionSetting {
  readonly title: string;
  readonly description: string;
  readonly type: "string" | "number" | "boolean";
  readonly default: string | number | boolean;
}
export interface ExtensionManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: 1;
  readonly main: string;
  readonly events?: readonly string[];
  readonly description: string;
  readonly commands?: readonly ExtensionCommand[];
  readonly tools?: readonly ExtensionTool[];
  readonly panels?: readonly ExtensionPanel[];
  readonly settings?: Readonly<Record<string, ExtensionSetting>>;
  readonly settingsPages?: readonly {
    readonly id: string;
    readonly title: string;
    readonly description?: string;
    readonly settings?: readonly string[];
    readonly panelId?: string;
  }[];
  readonly statusItems?: readonly {
    readonly id: string;
    readonly text: string;
    readonly command: string;
  }[];
}
export interface ExtensionEvent {
  readonly type: string;
  readonly data: Json;
}
export interface ExtensionContext {
  readonly extensionId: string;
  readonly storagePath: string;
  readonly settings: Readonly<Record<string, Json>>;
  registerCommand(
    id: string,
    handler: (input: Json, context: InvocationContext) => Json | Promise<Json>,
  ): void;
  registerTool(
    id: string,
    handler: (input: Json, context: InvocationContext) => Json | Promise<Json>,
  ): void;
  onEvent(handler: (event: ExtensionEvent) => void | Promise<void>): () => void;
  onSettingsChanged(
    handler: (settings: Readonly<Record<string, Json>>) => void | Promise<void>,
  ): () => void;
  onDispose(handler: () => void | Promise<void>): void;
  /** Calls environment-local T3 service methods with the host's authority. */
  callT3<M extends keyof ExtensionHostApi>(
    method: M,
    input: ExtensionHostApi[M]["input"],
  ): Promise<ExtensionHostApi[M]["result"]>;
  emit(type: string, data: Json): void;
}
export interface Extension {
  activate(context: ExtensionContext): void | Promise<void>;
}
export function defineExtension(extension: Extension): Extension {
  return extension;
}
