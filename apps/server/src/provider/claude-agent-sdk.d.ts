declare module "@anthropic-ai/claude-agent-sdk" {
  export type PermissionMode =
    | "default"
    | "acceptEdits"
    | "bypassPermissions"
    | "plan"
    | "dontAsk";

  export interface PermissionUpdate {
    readonly [key: string]: unknown;
  }

  export type PermissionResult =
    | {
        readonly behavior: "allow";
        readonly updatedInput?: unknown;
        readonly message?: string;
      }
    | {
        readonly behavior: "deny";
        readonly updatedInput?: unknown;
        readonly message?: string;
      };

  export type CanUseTool = (
    toolName: string,
    toolInput: Record<string, unknown>,
    callbackOptions: {
      readonly signal?: AbortSignal;
      readonly suggestions?: ReadonlyArray<PermissionUpdate>;
      readonly [key: string]: unknown;
    },
  ) => Promise<PermissionResult>;

  export interface SDKUserMessage {
    readonly [key: string]: unknown;
  }

  export interface SDKResultMessage {
    readonly subtype?: string;
    readonly duration_ms?: number;
    readonly durationMs?: number;
    readonly is_error?: boolean;
    readonly isError?: boolean;
    readonly num_turns?: number;
    readonly total_cost_usd?: number;
    readonly stop_reason?: string | null;
    readonly errors?: ReadonlyArray<unknown>;
    readonly usage?: {
      readonly input_tokens?: number;
      readonly output_tokens?: number;
      readonly cache_creation_input_tokens?: number;
      readonly cache_read_input_tokens?: number;
      readonly server_tool_use?: {
        readonly web_search_requests?: number;
      };
    };
    readonly result?: string;
    readonly session_id?: string;
    readonly [key: string]: unknown;
  }

  export interface SDKMessage {
    readonly type?: string;
    readonly subtype?: string;
    readonly role?: string;
    readonly message?: {
      readonly id?: string;
      readonly content?: ReadonlyArray<unknown>;
      readonly [key: string]: unknown;
    };
    readonly content?: ReadonlyArray<Record<string, unknown>>;
    readonly uuid?: string;
    readonly session_id?: string;
    readonly parent_tool_use_id?: string;
    readonly tool_use_id?: string;
    readonly tool_name?: string;
    readonly input?: Record<string, unknown>;
    readonly result?: string;
    readonly error?: string;
    readonly errors?: ReadonlyArray<unknown>;
    readonly content_block?: Record<string, unknown>;
    readonly index?: number;
    readonly preceding_tool_use_ids?: ReadonlyArray<string>;
    readonly is_error?: boolean;
    readonly suggestions?: ReadonlyArray<PermissionUpdate>;
    readonly [key: string]: unknown;
  }

  export interface Options {
    readonly cwd?: string;
    readonly model?: string;
    readonly pathToClaudeCodeExecutable?: string;
    readonly permissionMode?: PermissionMode;
    readonly allowDangerouslySkipPermissions?: boolean;
    readonly maxThinkingTokens?: number;
    readonly resume?: string;
    readonly resumeSessionAt?: string;
    readonly includePartialMessages?: boolean;
    readonly canUseTool?: CanUseTool;
    readonly env?: Record<string, string | undefined>;
    readonly additionalDirectories?: ReadonlyArray<string>;
  }

  export type Query = AsyncIterable<SDKMessage> & {
    readonly interrupt?: () => Promise<void>;
    readonly setModel?: (model?: string) => Promise<void>;
    readonly setPermissionMode?: (mode: PermissionMode) => Promise<void>;
    readonly setMaxThinkingTokens?: (maxThinkingTokens: number | null) => Promise<void>;
    readonly close?: () => void;
  };

  export function query(input: {
    readonly prompt: string | AsyncIterable<SDKUserMessage>;
    readonly options?: Options;
  }): Query;
}
