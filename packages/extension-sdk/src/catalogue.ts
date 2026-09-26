import { defineOrchestrationStatusApi, orchestrationControlApi } from "./orchestration.js";
export * from "./orchestration.js";
import {
  defineApi,
  defineStreamApi,
  type ApiDefinition,
  type TypedApi,
  type TypedStreamApi,
} from "./capabilities.js";
import type { JsonObject } from "./environment.js";
import type { GlobalCommandDescriptor } from "./environment.js";
import type { ViewContext } from "./contracts.js";
import type { WorkspaceReadTextInput, WorkspaceReadTextResult } from "./workspace.js";
import { textEditsApi, textEditsApiV1 } from "./textEdits.js";
import { workspaceResourcesApi, WORKSPACE_RESOURCES } from "./workspaceResources.js";
import {
  themeProviderStateSchema,
  terminalAppearanceSchema,
  commandDescriptorSchema,
  commandResultSchema,
  themeHalvesSchema,
} from "./clientProviders.js";

export * from "./workspaceResources.js";

export {
  EDITABLE_TEXT_MAX_BYTES,
  REVISION_HEX_LENGTH,
  WORKSPACE_READ_TEXT_EDITS,
  WORKSPACE_READ_TEXT_GRANT,
  WORKSPACE_WRITE_TEXT,
  textEditsApi,
  textEditsApiV1,
  isTextRevision,
  validateReadSnapshotInput,
  validateReadSnapshotResult,
  validateSaveInput,
  validateSaveResult,
} from "./textEdits.js";
export type {
  EditableSnapshot,
  EditableRelativePath,
  NotEditableSnapshot,
  ReadSnapshotInput,
  ReadSnapshotResult,
  SaveInput,
  SaveResult,
  SavedResult,
  ConflictResult,
  TextRevision,
} from "./textEdits.js";

/** Read-only environment loopback suggestions, not an engine or arbitrary URL probe. */
export const BROWSER_LOCAL_SERVERS = "t3.browser/local-servers";
export const BROWSER_READ_LOCAL_SERVERS = "t3.browser/read-local-servers";
export type BrowserLocalServersSnapshot = {
  readonly kind: "snapshot";
  readonly scope: "environment";
  readonly servers: readonly { readonly url: string; readonly port: number }[];
  readonly truncated: boolean;
};
export type BrowserLocalServersEvent =
  | BrowserLocalServersSnapshot
  | { readonly kind: "closed"; readonly reason: "source-unavailable" };
export const browserLocalServersApi = defineStreamApi<{
  subscribe: { input: Record<string, never>; event: BrowserLocalServersEvent };
}>({
  id: BROWSER_LOCAL_SERVERS,
  version: "1.0.0",
  methods: [],
  streams: [
    {
      name: "subscribe",
      requiredGrants: [BROWSER_READ_LOCAL_SERVERS],
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      eventSchema: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "scope", "servers", "truncated"],
            properties: {
              kind: { const: "snapshot" },
              scope: { const: "environment" },
              truncated: { type: "boolean" },
              servers: {
                type: "array",
                maxItems: 64,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["url", "port"],
                  properties: {
                    url: { type: "string", minLength: 1, maxLength: 256 },
                    port: { type: "integer", minimum: 1, maximum: 65535 },
                  },
                },
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "reason"],
            properties: { kind: { const: "closed" }, reason: { const: "source-unavailable" } },
          },
        ],
      },
    },
  ],
});

/**
 * Live provider-instance status for the environment — the same signal the
 * shell's status indicators render. Subscribe instead of polling so capability
 * staleness resolves as the registry refreshes, without a manual refresh.
 * The projection carries identity, lifecycle and capability flags only:
 * credentials, auth details, workspace paths and free-text diagnostics stay
 * server-side.
 */
export const PROVIDERS_STATUS = "t3.providers/status";
export const PROVIDERS_READ = "t3.providers/read";
export type ProviderStatusEntry = {
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName?: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly status: "ready" | "warning" | "error" | "disabled";
  readonly availability: "available" | "unavailable";
  readonly checkedAt: string;
  readonly supportsConversationRollback?: boolean;
  readonly supportsTextGeneration?: boolean;
  readonly requiresNewThreadForModelChange?: boolean;
  readonly showInteractionModeToggle?: boolean;
  readonly reportsContextWindow?: boolean;
};
export type ProvidersStatusEvent = {
  readonly kind: "snapshot";
  readonly scope: "environment";
  readonly providers: readonly ProviderStatusEntry[];
};
/**
 * The projection's display-label cap. Host provider names (`displayName`)
 * are unbounded non-empty strings, so the producer truncates to this length
 * rather than let a valid long name invalidate the whole frame; identity
 * stays on `instanceId`/`driver`, never the label.
 */
export const PROVIDER_STATUS_DISPLAY_NAME_MAX_LENGTH = 200;
const PROVIDER_STATUS_ENTRY_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["instanceId", "driver", "enabled", "installed", "status", "availability", "checkedAt"],
  properties: {
    instanceId: { type: "string", minLength: 1, maxLength: 160 },
    driver: { type: "string", minLength: 1, maxLength: 64 },
    displayName: {
      type: "string",
      minLength: 1,
      maxLength: PROVIDER_STATUS_DISPLAY_NAME_MAX_LENGTH,
    },
    enabled: { type: "boolean" },
    installed: { type: "boolean" },
    status: { enum: ["ready", "warning", "error", "disabled"] },
    availability: { enum: ["available", "unavailable"] },
    checkedAt: { type: "string", minLength: 1, maxLength: 40 },
    supportsConversationRollback: { type: "boolean" },
    supportsTextGeneration: { type: "boolean" },
    requiresNewThreadForModelChange: { type: "boolean" },
    showInteractionModeToggle: { type: "boolean" },
    reportsContextWindow: { type: "boolean" },
  },
};
export const providersStatusApi = defineStreamApi<{
  subscribe: { input: Record<string, never>; event: ProvidersStatusEvent };
}>({
  id: PROVIDERS_STATUS,
  version: "1.0.0",
  methods: [],
  streams: [
    {
      name: "subscribe",
      requiredGrants: [PROVIDERS_READ],
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      eventSchema: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "scope", "providers"],
        properties: {
          kind: { const: "snapshot" },
          scope: { const: "environment" },
          providers: { type: "array", maxItems: 64, items: PROVIDER_STATUS_ENTRY_SCHEMA },
        },
      },
    },
  ],
});

export const WORKSPACE_FILES = "t3.workspace/files";
export const WORKSPACE_LIST_ENTRIES = "t3.workspace/list-entries";
export const FILE_PRESENTATION = "t3.file/presentation";
export const FILE_PRESENTATION_OPEN = "t3.file/open";
export const TERMINAL_SESSIONS = "t3.terminal/sessions";
export const TERMINAL_READ = "t3.terminal/read";
export const TERMINAL_OUTPUT = "t3.terminal/output";
export const TERMINAL_READ_OUTPUT = "t3.terminal/read-output";
export const TERMINAL_OUTPUT_EVENTS = "t3.terminal/output-events";
export const TERMINAL_CONTROL = "t3.terminal/control";
/**
 * Distinct write grant for terminal lifecycle/input. Spawn/write authority
 * never rides the read grants (`t3.terminal/read`, `t3.terminal/read-output`).
 */
export const TERMINAL_OPERATE = "t3.terminal/operate";
export const WORKSPACE_SEARCH = "t3.workspace/search";
/**
 * Broad workspace read grant — mutation-signal streams carry read metadata
 * about the plugin's own thread workspace, never file bytes, so they ride
 * this grant rather than a narrower read-text capability.
 */
export const WORKSPACE_READ = "t3.workspace/read";
export const WORKSPACE_CHANGES = "t3.workspace/changes";
export type WorkspaceSearchInput = {
  readonly query: string;
  readonly limit?: number;
  readonly kind?: "file" | "directory";
  readonly imageOnly?: boolean;
};
export type WorkspaceSearchResultEntry = {
  readonly path: string;
  readonly kind: "file" | "directory";
};
export type WorkspaceSearchResult = {
  readonly entries: readonly WorkspaceSearchResultEntry[];
  readonly truncated: boolean;
};
export type WorkspaceSearchContentsInput = {
  readonly query: string;
  readonly limit?: number;
  readonly caseSensitive?: boolean;
  readonly wholeWord?: boolean;
  readonly useRegex?: boolean;
};
export type WorkspaceContentMatchRange = { readonly start: number; readonly end: number };
export type WorkspaceContentMatch = {
  readonly path: string;
  readonly lineNumber: number;
  readonly lineContent: string;
  readonly matchRanges: readonly WorkspaceContentMatchRange[];
};
export type WorkspaceSearchContentsResult = {
  readonly matches: readonly WorkspaceContentMatch[];
  readonly truncated: boolean;
  readonly regexFallbackError?: string;
};
export type WorkspaceListEntriesInput = {
  readonly relativePath: string;
  readonly cursor?: string;
  readonly limit?: number;
};
export type WorkspaceEntry = {
  readonly name: string;
  readonly relativePath: string;
  readonly kind: "file" | "directory";
};
export type WorkspaceListEntriesResult = {
  readonly entries: readonly WorkspaceEntry[];
  readonly nextCursor: string | null;
};
export type FilePresentationInput = { readonly relativePath: string };
export type FilePresentationResult = {
  readonly surfaceId: string;
  readonly placement: "side-panel" | "bottom-dock" | "full-page" | "compact-detail";
  readonly restoreState: JsonObject;
};
export type TerminalSessionsInput = { readonly terminalId: string };
export type TerminalOutputInput = { readonly terminalId: string };
export type TerminalOutputResult = {
  readonly terminalId: string;
  readonly contents: string;
  readonly retainedByteLength: number;
  readonly truncated: boolean;
} | null;
export type TerminalOutputEventsInput = { readonly terminalId: string };
export type TerminalOutputEventsSnapshot = {
  readonly kind: "snapshot";
  readonly terminalId: string;
  readonly streamEpoch: string;
  readonly status: "starting" | "running" | "exited" | "error";
  /**
   * The retained tail of the raw output stream — exactly the bytes the
   * process emitted, including unanswered terminal queries and a
   * possibly incomplete trailing control sequence. Hosts may sanitize
   * display copies of history, but this channel's contents and
   * coordinates are always raw so `contentsUnitStart` and live output
   * positions share one coordinate system.
   */
  readonly contents: string;
  readonly retainedByteLength: number;
  readonly truncated: boolean;
  /**
   * Number of history clears observed inside the current `streamEpoch`
   * (the clear counter resets when the epoch changes, so restart-path
   * clears are not counted). A history clear preserves `streamEpoch`, so
   * a snapshot taken after a missed `reset` frame is only
   * distinguishable by this counter: a value different from the
   * previous snapshot's means the old window's bytes are gone even when
   * `truncated` is false. `clearGeneration === 0` is also the coverage
   * evidence required before the retained window can be treated as
   * complete since the process started.
   */
  readonly clearGeneration: number;
  /**
   * Absolute UTF-16 unit offset of `contents[0]` inside the current
   * retained-history window — raw appended units since the last clear
   * minus `contents.length`, counting every unit the process emitted
   * (including bytes a display sanitizer would strip). Line eviction,
   * byte eviction and tail truncation all move this forward; comparing
   * it against the position recorded for a pending reply is the
   * authoritative origin evidence for whether that reply's bytes still
   * exist, independent of what the text says.
   */
  readonly contentsUnitStart: number;
  readonly boundarySequence: number;
};
export type TerminalOutputEventsOutput = {
  readonly kind: "output";
  readonly terminalId: string;
  readonly streamEpoch: string;
  readonly sequence: number;
  readonly chunkIndex: number;
  readonly chunkCount: number;
  readonly data: string;
};
export type TerminalOutputEventsReset = {
  readonly kind: "reset";
  readonly terminalId: string;
  readonly streamEpoch: string;
  readonly sequence: number;
  /**
   * `clearGeneration` of the new retained-history window created by this
   * clear. Subsequent bytes in the epoch start again at unit offset 0.
   */
  readonly clearGeneration: number;
  readonly reason: "history-cleared";
};
export type TerminalOutputEventsExit = {
  readonly kind: "exit";
  readonly terminalId: string;
  readonly streamEpoch: string;
  readonly sequence: number;
  readonly exitCode: number | null;
  readonly exitSignal: number | null;
};
export type TerminalOutputEventsClosed = {
  readonly kind: "closed";
  readonly terminalId: string;
  readonly streamEpoch: string;
  readonly reason: "terminal-closed" | "identity-changed" | "overflow" | "terminal-error";
};
export type TerminalOutputEventsValue =
  | TerminalOutputEventsSnapshot
  | TerminalOutputEventsOutput
  | TerminalOutputEventsReset
  | TerminalOutputEventsExit
  | TerminalOutputEventsClosed;
export type TerminalSessionResult = {
  readonly terminalId: string;
  readonly status: "starting" | "running" | "exited" | "error";
  readonly label: string;
  readonly hasRunningSubprocess: boolean;
  readonly exitCode: number | null;
  readonly exitSignal: number | null;
  readonly updatedAt: string;
} | null;
/** The non-null session metadata projection shared by inspect, list and control results. */
export type TerminalSessionMetadata = NonNullable<TerminalSessionResult>;
export type TerminalSessionsListInput = Record<string, never>;
export type TerminalSessionsListEvent =
  | {
      readonly kind: "snapshot";
      readonly terminals: readonly TerminalSessionMetadata[];
    }
  | { readonly kind: "upsert"; readonly terminal: TerminalSessionMetadata }
  | { readonly kind: "remove"; readonly terminalId: string }
  | { readonly kind: "closed"; readonly reason: "overflow" | "terminal-error" };
export type TerminalControlOpenInput = {
  readonly terminalId: string;
  readonly cwd: string;
  readonly worktreePath?: string | null;
  readonly cols?: number;
  readonly rows?: number;
  readonly env?: { readonly [key: string]: string };
  readonly providerInstanceId?: string;
};
export type TerminalControlAttachInput = {
  readonly terminalId: string;
  readonly cwd?: string;
  readonly worktreePath?: string | null;
  readonly cols?: number;
  readonly rows?: number;
  readonly env?: { readonly [key: string]: string };
  readonly providerInstanceId?: string;
  readonly restartIfNotRunning?: boolean;
};
export type TerminalControlWriteInput = {
  readonly terminalId: string;
  readonly data: string;
};
export type TerminalControlResizeInput = {
  readonly terminalId: string;
  readonly cols: number;
  readonly rows: number;
};
export type TerminalControlClearInput = { readonly terminalId: string };
export type TerminalControlRestartInput = {
  readonly terminalId: string;
  readonly cwd: string;
  readonly worktreePath?: string | null;
  readonly cols: number;
  readonly rows: number;
  readonly env?: { readonly [key: string]: string };
  readonly providerInstanceId?: string;
};
export type TerminalControlCloseInput = {
  readonly terminalId?: string;
  readonly deleteHistory?: boolean;
};
export type TerminalControlAck = Record<string, never>;
const path = { type: "string", maxLength: 512 };
export const workspaceFilesApi = defineApi<{
  listEntries: { input: WorkspaceListEntriesInput; output: WorkspaceListEntriesResult };
  readText: { input: WorkspaceReadTextInput; output: WorkspaceReadTextResult };
}>({
  id: WORKSPACE_FILES,
  version: "1.0.0",
  methods: [
    {
      name: "listEntries",
      effect: "read",
      requiredGrants: [WORKSPACE_LIST_ENTRIES],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["relativePath"],
        properties: {
          relativePath: path,
          cursor: { type: "string", maxLength: 2048 },
          limit: { type: "integer", minimum: 1, maximum: 200 },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["entries", "nextCursor"],
        properties: {
          entries: {
            type: "array",
            maxItems: 200,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "relativePath", "kind"],
              properties: {
                name: { type: "string", minLength: 1, maxLength: 512 },
                relativePath: path,
                kind: { enum: ["file", "directory"] },
              },
            },
          },
          nextCursor: { type: ["string", "null"], maxLength: 2048 },
        },
      },
    },
    {
      name: "readText",
      effect: "read",
      requiredGrants: ["t3.workspace/read-text"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["relativePath"],
        properties: { relativePath: path },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["relativePath", "contents", "byteLength", "truncated"],
        properties: {
          relativePath: path,
          contents: { type: "string", maxLength: 48000 },
          byteLength: { type: "integer", minimum: 0 },
          truncated: { type: "boolean" },
        },
      },
    },
  ],
});
export const filePresentationApi = defineApi<{
  open: { input: FilePresentationInput; output: FilePresentationResult };
}>({
  id: FILE_PRESENTATION,
  version: "1.0.0",
  methods: [
    {
      name: "open",
      effect: "read",
      requiredGrants: [FILE_PRESENTATION_OPEN],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["relativePath"],
        properties: { relativePath: path },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["surfaceId", "placement", "restoreState"],
        properties: {
          surfaceId: { type: "string", minLength: 1, maxLength: 160 },
          placement: { enum: ["side-panel", "bottom-dock", "full-page", "compact-detail"] },
          restoreState: { type: "object" },
        },
      },
    },
  ],
});
const terminalSessionMetadataSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "terminalId",
    "status",
    "label",
    "hasRunningSubprocess",
    "exitCode",
    "exitSignal",
    "updatedAt",
  ],
  properties: {
    terminalId: { type: "string", minLength: 1, maxLength: 128 },
    status: { enum: ["starting", "running", "exited", "error"] },
    label: { type: "string", maxLength: 128 },
    hasRunningSubprocess: { type: "boolean" },
    exitCode: { type: ["integer", "null"] },
    exitSignal: { type: ["integer", "null"] },
    updatedAt: { type: "string", maxLength: 64 },
  },
} as const;
const terminalSessionsInspectMethod = {
  name: "inspect",
  effect: "read",
  requiredGrants: [TERMINAL_READ],
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["terminalId"],
    properties: { terminalId: { type: "string", minLength: 1, maxLength: 128 } },
  },
  outputSchema: {
    ...terminalSessionMetadataSchema,
    type: ["object", "null"],
  },
} as const;
/**
 * Thread-scoped live session list: a full snapshot followed by upsert/remove
 * rows, folded from the native metadata stream. `closed` is the honest
 * teardown signal; there is no resume cursor.
 */
const terminalSessionsListEventSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "terminals"],
      properties: {
        kind: { const: "snapshot" },
        terminals: { type: "array", maxItems: 128, items: terminalSessionMetadataSchema },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "terminal"],
      properties: {
        kind: { const: "upsert" },
        terminal: terminalSessionMetadataSchema,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "terminalId"],
      properties: {
        kind: { const: "remove" },
        terminalId: { type: "string", minLength: 1, maxLength: 128 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "reason"],
      properties: {
        kind: { const: "closed" },
        reason: { enum: ["overflow", "terminal-error"] },
      },
    },
  ],
} as const;
/**
 * Sessions metadata, newest version first. 1.1.0 adds the `list` stream;
 * `inspect` is byte-identical to 1.0.0, which stays frozen below so consumers
 * and providers built against it keep canonical equality.
 */
export const terminalSessionsApi: TypedApi<{
  inspect: { input: TerminalSessionsInput; output: TerminalSessionResult };
}> &
  TypedStreamApi<{
    list: { input: TerminalSessionsListInput; event: TerminalSessionsListEvent };
  }> = defineStreamApi<{
  list: { input: TerminalSessionsListInput; event: TerminalSessionsListEvent };
}>({
  id: TERMINAL_SESSIONS,
  version: "1.1.0",
  methods: [terminalSessionsInspectMethod],
  streams: [
    {
      name: "list",
      requiredGrants: [TERMINAL_READ],
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      eventSchema: terminalSessionsListEventSchema,
    },
  ],
});
/** Frozen published 1.0.0 definition; shared definitions are immutable per version. */
export const terminalSessionsApiV1 = defineApi<{
  inspect: { input: TerminalSessionsInput; output: TerminalSessionResult };
}>({
  id: TERMINAL_SESSIONS,
  version: "1.0.0",
  methods: [terminalSessionsInspectMethod],
});

/** Bounds mirror the native RPC payloads in @t3tools/contracts terminal.ts. */
const terminalIdInput = { type: "string", minLength: 1, maxLength: 128 } as const;
const terminalColsInput = { type: "integer", minimum: 1, maximum: 1000 } as const;
const terminalRowsInput = { type: "integer", minimum: 1, maximum: 500 } as const;
const terminalCwdInput = { type: "string", minLength: 1, maxLength: 32768 } as const;
const terminalWorktreePathInput = {
  type: ["string", "null"],
  minLength: 1,
  maxLength: 32768,
} as const;
const terminalEnvInput = {
  type: "object",
  maxProperties: 128,
  propertyNames: { pattern: "^[A-Za-z_][A-Za-z0-9_]*$", maxLength: 128 },
  additionalProperties: { type: "string", maxLength: 8192 },
} as const;
const terminalProviderInstanceInput = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-zA-Z][a-zA-Z0-9_-]*$",
} as const;
const terminalSessionOutputSchema = terminalSessionMetadataSchema;
const terminalAckOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;
const terminalLaunchOptionals = {
  worktreePath: terminalWorktreePathInput,
  cols: terminalColsInput,
  rows: terminalRowsInput,
  env: terminalEnvInput,
  providerInstanceId: terminalProviderInstanceInput,
} as const;

/**
 * Terminal lifecycle and input. Every method is a write under the distinct
 * `t3.terminal/operate` grant — spawn authority is never conveyed by the read
 * grants. `attach` is open-or-attach: it never spawns without `cwd`, and a
 * stopped session respawns only when `restartIfNotRunning` is set. Reading
 * output stays on `t3.terminal/output-events`, which cannot spawn.
 */
export const terminalControlApi = defineApi<{
  open: { input: TerminalControlOpenInput; output: TerminalSessionMetadata };
  attach: { input: TerminalControlAttachInput; output: TerminalSessionMetadata };
  write: { input: TerminalControlWriteInput; output: TerminalControlAck };
  resize: { input: TerminalControlResizeInput; output: TerminalControlAck };
  clear: { input: TerminalControlClearInput; output: TerminalControlAck };
  restart: { input: TerminalControlRestartInput; output: TerminalSessionMetadata };
  close: { input: TerminalControlCloseInput; output: TerminalControlAck };
}>({
  id: TERMINAL_CONTROL,
  version: "1.0.0",
  methods: [
    {
      name: "open",
      effect: "write",
      requiredGrants: [TERMINAL_OPERATE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["terminalId", "cwd"],
        properties: {
          terminalId: terminalIdInput,
          cwd: terminalCwdInput,
          ...terminalLaunchOptionals,
        },
      },
      outputSchema: terminalSessionOutputSchema,
    },
    {
      name: "attach",
      effect: "write",
      requiredGrants: [TERMINAL_OPERATE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["terminalId"],
        properties: {
          terminalId: terminalIdInput,
          cwd: terminalCwdInput,
          restartIfNotRunning: { type: "boolean" },
          ...terminalLaunchOptionals,
        },
      },
      outputSchema: terminalSessionOutputSchema,
    },
    {
      name: "write",
      effect: "write",
      requiredGrants: [TERMINAL_OPERATE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["terminalId", "data"],
        properties: {
          terminalId: terminalIdInput,
          data: { type: "string", minLength: 1, maxLength: 65536 },
        },
      },
      outputSchema: terminalAckOutputSchema,
    },
    {
      name: "resize",
      effect: "write",
      requiredGrants: [TERMINAL_OPERATE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["terminalId", "cols", "rows"],
        properties: {
          terminalId: terminalIdInput,
          cols: terminalColsInput,
          rows: terminalRowsInput,
        },
      },
      outputSchema: terminalAckOutputSchema,
    },
    {
      name: "clear",
      effect: "write",
      requiredGrants: [TERMINAL_OPERATE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["terminalId"],
        properties: { terminalId: terminalIdInput },
      },
      outputSchema: terminalAckOutputSchema,
    },
    {
      name: "restart",
      effect: "write",
      requiredGrants: [TERMINAL_OPERATE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["terminalId", "cwd", "cols", "rows"],
        properties: {
          terminalId: terminalIdInput,
          cwd: terminalCwdInput,
          ...terminalLaunchOptionals,
        },
      },
      outputSchema: terminalSessionOutputSchema,
    },
    {
      name: "close",
      effect: "write",
      requiredGrants: [TERMINAL_OPERATE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          terminalId: terminalIdInput,
          deleteHistory: { type: "boolean" },
        },
      },
      outputSchema: terminalAckOutputSchema,
    },
  ],
});

export const terminalOutputApi = defineApi<{
  readSnapshot: { input: TerminalOutputInput; output: TerminalOutputResult };
}>({
  id: TERMINAL_OUTPUT,
  version: "1.0.0",
  methods: [
    {
      name: "readSnapshot",
      effect: "read",
      requiredGrants: [TERMINAL_READ_OUTPUT],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["terminalId"],
        properties: { terminalId: { type: "string", minLength: 1, maxLength: 128 } },
      },
      outputSchema: {
        type: ["object", "null"],
        additionalProperties: false,
        required: ["terminalId", "contents", "retainedByteLength", "truncated"],
        properties: {
          terminalId: { type: "string", minLength: 1, maxLength: 128 },
          contents: { type: "string", maxLength: 8192 },
          retainedByteLength: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          truncated: { type: "boolean" },
        },
      },
    },
  ],
});

const terminalOutputEventsValueSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: [
        "kind",
        "terminalId",
        "streamEpoch",
        "status",
        "contents",
        "retainedByteLength",
        "truncated",
        "clearGeneration",
        "contentsUnitStart",
        "boundarySequence",
      ],
      properties: {
        kind: { const: "snapshot" },
        terminalId: { type: "string", minLength: 1, maxLength: 128 },
        streamEpoch: { type: "string", minLength: 1, maxLength: 128 },
        status: { enum: ["starting", "running", "exited", "error"] },
        contents: { type: "string", maxLength: 8192 },
        retainedByteLength: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        truncated: { type: "boolean" },
        clearGeneration: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        contentsUnitStart: {
          type: "integer",
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        boundarySequence: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "kind",
        "terminalId",
        "streamEpoch",
        "sequence",
        "chunkIndex",
        "chunkCount",
        "data",
      ],
      properties: {
        kind: { const: "output" },
        terminalId: { type: "string", minLength: 1, maxLength: 128 },
        streamEpoch: { type: "string", minLength: 1, maxLength: 128 },
        sequence: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        chunkIndex: { type: "integer", minimum: 0, maximum: 63 },
        chunkCount: { type: "integer", minimum: 1, maximum: 64 },
        data: { type: "string", maxLength: 8192 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "terminalId", "streamEpoch", "sequence", "clearGeneration", "reason"],
      properties: {
        kind: { const: "reset" },
        terminalId: { type: "string", minLength: 1, maxLength: 128 },
        streamEpoch: { type: "string", minLength: 1, maxLength: 128 },
        sequence: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        clearGeneration: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        reason: { const: "history-cleared" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "terminalId", "streamEpoch", "sequence", "exitCode", "exitSignal"],
      properties: {
        kind: { const: "exit" },
        terminalId: { type: "string", minLength: 1, maxLength: 128 },
        streamEpoch: { type: "string", minLength: 1, maxLength: 128 },
        sequence: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        exitCode: {
          type: ["integer", "null"],
          minimum: -Number.MAX_SAFE_INTEGER,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        exitSignal: {
          type: ["integer", "null"],
          minimum: -Number.MAX_SAFE_INTEGER,
          maximum: Number.MAX_SAFE_INTEGER,
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "terminalId", "streamEpoch", "reason"],
      properties: {
        kind: { const: "closed" },
        terminalId: { type: "string", minLength: 1, maxLength: 128 },
        streamEpoch: { type: "string", minLength: 1, maxLength: 128 },
        reason: { enum: ["terminal-closed", "identity-changed", "overflow", "terminal-error"] },
      },
    },
  ],
} as const;

/** Stream-only additive contract; the existing unary output API is intentionally unchanged. */
export const terminalOutputEventsApi = defineStreamApi<{
  subscribe: { input: TerminalOutputEventsInput; event: TerminalOutputEventsValue };
}>({
  id: TERMINAL_OUTPUT_EVENTS,
  version: "1.0.0",
  methods: [],
  streams: [
    {
      name: "subscribe",
      requiredGrants: [TERMINAL_READ_OUTPUT],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["terminalId"],
        properties: { terminalId: { type: "string", minLength: 1, maxLength: 128 } },
      },
      eventSchema: terminalOutputEventsValueSchema,
    },
  ],
});

export type WorkspaceTreeEntry = { readonly path: string; readonly kind: "file" | "directory" };
export type WorkspaceTreeEvent =
  | {
      readonly kind: "chunk";
      readonly entries: readonly WorkspaceTreeEntry[];
      readonly truncated: boolean;
    }
  | { readonly kind: "complete"; readonly entryCount: number; readonly truncated: boolean };
/** A finite native-index snapshot. Publish only after complete; cancellation discards partial chunks. */
export const workspaceTreeApi = defineStreamApi<{
  snapshot: { input: Record<string, never>; event: WorkspaceTreeEvent };
}>({
  id: "t3.workspace/tree",
  version: "1.0.0",
  methods: [],
  streams: [
    {
      name: "snapshot",
      requiredGrants: [WORKSPACE_LIST_ENTRIES],
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      eventSchema: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "entries", "truncated"],
            properties: {
              kind: { const: "chunk" },
              truncated: { type: "boolean" },
              entries: {
                type: "array",
                maxItems: 200,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["path", "kind"],
                  properties: {
                    path: { type: "string", minLength: 1, maxLength: 32768 },
                    kind: { enum: ["file", "directory"] },
                  },
                },
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "entryCount", "truncated"],
            properties: {
              kind: { const: "complete" },
              entryCount: { type: "integer", minimum: 0, maximum: 25000 },
              truncated: { type: "boolean" },
            },
          },
        ],
      },
    },
  ],
});

const searchEntrySchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "kind"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: 512 },
    kind: { enum: ["file", "directory"] },
  },
} as const;
/**
 * Bounded workspace search over the host's native index. Mirrors the bounds
 * of the private projectsSearchEntries/projectsSearchContents RPCs so a
 * plugin never has to pull the whole tree client-side to answer a query.
 */
export const workspaceSearchApi = defineApi<{
  search: { input: WorkspaceSearchInput; output: WorkspaceSearchResult };
  searchContents: { input: WorkspaceSearchContentsInput; output: WorkspaceSearchContentsResult };
}>({
  id: WORKSPACE_SEARCH,
  version: "1.0.0",
  methods: [
    {
      name: "search",
      effect: "read",
      requiredGrants: [WORKSPACE_SEARCH],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", maxLength: 256 },
          limit: { type: "integer", minimum: 1, maximum: 200 },
          kind: { enum: ["file", "directory"] },
          imageOnly: { type: "boolean" },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["entries", "truncated"],
        properties: {
          entries: { type: "array", maxItems: 200, items: searchEntrySchema },
          truncated: { type: "boolean" },
        },
      },
    },
    {
      name: "searchContents",
      effect: "read",
      requiredGrants: [WORKSPACE_SEARCH],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1, maxLength: 256 },
          limit: { type: "integer", minimum: 1, maximum: 500 },
          caseSensitive: { type: "boolean" },
          wholeWord: { type: "boolean" },
          useRegex: { type: "boolean" },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["matches", "truncated"],
        properties: {
          matches: {
            type: "array",
            maxItems: 500,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "lineNumber", "lineContent", "matchRanges"],
              properties: {
                path: { type: "string", minLength: 1, maxLength: 512 },
                lineNumber: { type: "integer", minimum: 1 },
                lineContent: { type: "string", maxLength: 8192 },
                matchRanges: {
                  type: "array",
                  maxItems: 512,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["start", "end"],
                    properties: {
                      start: { type: "integer", minimum: 0 },
                      end: { type: "integer", minimum: 0 },
                    },
                  },
                },
              },
            },
          },
          truncated: { type: "boolean" },
          regexFallbackError: { type: "string", maxLength: 512 },
        },
      },
    },
  ],
});

/* ------------------------------------------------------------------------
 * t3.workspace/changes — the workspace mutation signal. The host folds the
 * plugin's own thread activity stream (completed command_execution /
 * file_change tool items — the same fold the native file panels consume) into
 * a monotonically increasing per-thread `mutationSeq`. It is deliberately NOT
 * a filesystem watcher: external edits made outside the agent never appear,
 * matching native behavior. A `snapshot` frame carries the folded latest seq;
 * each `mutation` frame bumps it; `closed:overflow` is recoverable —
 * resubscribing re-delivers the latest seq in a fresh snapshot, so a folded
 * stream loses nothing. Raw activity payloads never cross the wire.
 * --------------------------------------------------------------------- */
export type WorkspaceChangesInput = { readonly threadId: string };
export type WorkspaceMutationKind = "command_execution" | "file_change";
export type WorkspaceChangesEvent =
  | { readonly kind: "snapshot"; readonly mutationSeq: number }
  | {
      readonly kind: "mutation";
      readonly mutationSeq: number;
      readonly kinds: readonly WorkspaceMutationKind[];
      readonly at: string;
    }
  | { readonly kind: "closed"; readonly reason: "overflow" | "watch-error" };

const mutationSeqField = {
  type: "integer",
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
} as const;
const workspaceChangesEventSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "mutationSeq"],
      properties: { kind: { const: "snapshot" }, mutationSeq: mutationSeqField },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "mutationSeq", "kinds", "at"],
      properties: {
        kind: { const: "mutation" },
        mutationSeq: mutationSeqField,
        kinds: {
          type: "array",
          minItems: 1,
          maxItems: 2,
          items: { enum: ["command_execution", "file_change"] },
        },
        at: { type: "string", minLength: 1, maxLength: 64 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "reason"],
      properties: {
        kind: { const: "closed" },
        reason: { enum: ["overflow", "watch-error"] },
      },
    },
  ],
} as const;
export const workspaceChangesApi = defineStreamApi<{
  subscribeChanges: { input: WorkspaceChangesInput; event: WorkspaceChangesEvent };
}>({
  id: WORKSPACE_CHANGES,
  version: "1.0.0",
  methods: [],
  streams: [
    {
      name: "subscribeChanges",
      requiredGrants: [WORKSPACE_READ],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["threadId"],
        properties: { threadId: { type: "string", minLength: 1, maxLength: 128 } },
      },
      eventSchema: workspaceChangesEventSchema,
    },
  ],
});

/* ------------------------------------------------------------------------
 * t3.vcs — backend-neutral source-control / diff contracts.
 *
 * Grant split: `t3.vcs/read` covers every read method and the status stream;
 * `t3.vcs/mutate` is the DISTINCT mutation grant — stage/commit/branch/
 * worktree/pull/init never ride the read grant, and `effect:"write"` gives
 * the broker a second barrier on top of the grant check.
 *
 * Capability honesty: `t3.vcs/repository.getCapabilities` reports the
 * detected driver kind, the driver flag set, and per-operation support.
 * Unsupported operations fail with the named VcsUnsupportedOperationError
 * (mirrored as an ExtensionOperationError naming the operation + kind) —
 * never a silent no-op or a fabricated empty result.
 * --------------------------------------------------------------------- */
export const VCS_READ = "t3.vcs/read";
export const VCS_MUTATE = "t3.vcs/mutate";
export const VCS_STATUS = "t3.vcs/status";
export const VCS_REFS = "t3.vcs/refs";
export const VCS_CHANGES = "t3.vcs/changes";
export const VCS_DIFF = "t3.vcs/diff";
export const VCS_REPOSITORY = "t3.vcs/repository";

export type VcsDriverKindValue = "git" | "jj" | "unknown";
export type VcsSourceControlProvider = {
  readonly kind: "github" | "gitlab" | "azure-devops" | "bitbucket" | "forgejo" | "unknown";
  readonly name: string;
  readonly baseUrl: string;
};
export type VcsStatusFile = {
  readonly path: string;
  readonly insertions: number;
  readonly deletions: number;
};
export type VcsStatusChangeRequest = {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRef: string;
  readonly headRef: string;
  readonly state: "open" | "closed" | "merged";
  readonly isDraft?: boolean;
  readonly updatedAt?: string | null;
};
/** Local status half — mirrors VcsStatusLocalResult with a declared file cap. */
export type VcsStatusLocal = {
  readonly isRepo: boolean;
  readonly sourceControlProvider?: VcsSourceControlProvider;
  readonly hasPrimaryRemote: boolean;
  readonly isDefaultRef: boolean;
  readonly refName: string | null;
  readonly hasWorkingTreeChanges: boolean;
  readonly workingTree: {
    readonly files: readonly VcsStatusFile[];
    readonly insertions: number;
    readonly deletions: number;
    /** True when the host sliced the file list at the contract bound. */
    readonly truncated: boolean;
  };
};
/** Remote status half — mirrors VcsStatusRemoteResult. */
export type VcsStatusRemote = {
  readonly hasUpstream: boolean;
  readonly aheadCount: number;
  readonly behindCount: number;
  readonly aheadOfDefaultCount?: number;
  readonly pr: VcsStatusChangeRequest | null;
};
export type VcsStatusResult = VcsStatusLocal & VcsStatusRemote;
export type VcsStatusStreamEvent =
  | {
      readonly kind: "snapshot";
      readonly local: VcsStatusLocal;
      readonly remote: VcsStatusRemote | null;
    }
  | { readonly kind: "localUpdated"; readonly local: VcsStatusLocal }
  | { readonly kind: "remoteUpdated"; readonly remote: VcsStatusRemote | null }
  | { readonly kind: "closed"; readonly reason: "overflow" | "status-error" };
export type VcsListRefsInput = {
  readonly query?: string;
  readonly cursor?: number;
  readonly includeMatchingRemoteRefs?: boolean;
  readonly refKind?: "all" | "local" | "remote";
  readonly refresh?: boolean;
  readonly limit?: number;
};
export type VcsRefEntry = {
  readonly name: string;
  readonly isRemote?: boolean;
  readonly remoteName?: string;
  readonly current: boolean;
  readonly isDefault: boolean;
  readonly worktreePath: string | null;
};
export type VcsListRefsResult = {
  readonly refs: readonly VcsRefEntry[];
  readonly isRepo: boolean;
  readonly hasPrimaryRemote: boolean;
  readonly nextCursor: number | null;
  readonly totalCount: number;
};
export type VcsRefNameInput = { readonly refName: string };
export type VcsCreateRefInput = { readonly refName: string; readonly switchRef?: boolean };
export type VcsRefNameResult = { readonly refName: string };
export type VcsSwitchRefResult = { readonly refName: string | null };
/**
 * Per-path index state the private status payload drops — porcelain XY is
 * parsed for paths only upstream (GitVcsDriverCore), so a staging lane cannot
 * be rendered from `status`. This is the narrow net-new read surface.
 */
export type VcsChangeEntry = {
  readonly path: string;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly untracked: boolean;
  readonly conflicted: boolean;
};
export type VcsChangesListResult = {
  readonly isRepo: boolean;
  readonly entries: readonly VcsChangeEntry[];
  readonly truncated: boolean;
};
export type VcsPathsInput = { readonly paths: readonly string[] };
export type VcsPathsResult = { readonly paths: readonly string[] };
export type VcsCommitInput = {
  readonly message: string;
  readonly paths?: readonly string[];
};
export type VcsCommitResult = {
  readonly commitSha: string;
  readonly refName: string | null;
};
export type VcsDiffPreviewInput = {
  readonly baseRef?: string;
  readonly ignoreWhitespace?: boolean;
};
export type VcsDiffPreviewSource = {
  readonly id: string;
  readonly kind: "working-tree" | "branch-range";
  readonly title: string;
  readonly baseRef: string | null;
  readonly headRef: string | null;
  readonly diff: string;
  readonly diffHash: string;
  readonly truncated: boolean;
};
export type VcsDiffPreviewResult = {
  readonly generatedAt: string;
  readonly sources: readonly VcsDiffPreviewSource[];
};
export type VcsDiffFileContentsInput = {
  readonly sourceKind: "working-tree" | "branch-range";
  readonly changeType: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
  readonly baseRef: string | null;
  readonly headRef: string | null;
  readonly oldPath: string;
  readonly newPath: string;
};
export type VcsDiffFileContentsResult = {
  readonly oldContents: string;
  readonly newContents: string;
};
/**
 * Per-source descriptor announced in the `streamPreview` manifest frame —
 * the unary `VcsDiffPreviewSource` fields minus the (chunked) `diff` body.
 * `diffHash` is sha256 over the delivered body, same recompute as invoke;
 * `chunkCount` chunk frames carry that body in `chunkIndex` order.
 */
export type VcsDiffStreamSource = {
  readonly id: string;
  readonly kind: "working-tree" | "branch-range";
  readonly title: string;
  readonly baseRef: string | null;
  readonly headRef: string | null;
  readonly truncated: boolean;
  readonly diffHash: string;
  readonly diffByteLength: number;
  readonly chunkCount: number;
};
/**
 * `streamPreview` frames: one `manifest` snapshot, then `chunk` data frames
 * per source, then a `complete` data frame. `payloadSha256` is the sha256
 * over the concatenated UTF-8 bytes of every delivered `diff` body in
 * manifest order — consumers reassemble per source and verify end-to-end.
 */
export type VcsDiffPreviewStreamEvent =
  | {
      readonly kind: "manifest";
      readonly generatedAt: string;
      readonly sources: readonly VcsDiffStreamSource[];
    }
  | {
      readonly kind: "chunk";
      readonly sourceIndex: number;
      readonly chunkIndex: number;
      readonly data: string;
    }
  | { readonly kind: "complete"; readonly payloadSha256: string };
/**
 * `streamFileContents` frames: one `manifest` snapshot announcing per-side
 * byte/chunk counts, then `chunk` data frames tagged by side, then a
 * `complete` data frame with each side's sha256 over its delivered contents.
 */
export type VcsDiffFileContentsStreamEvent =
  | {
      readonly kind: "manifest";
      readonly oldByteLength: number;
      readonly oldChunkCount: number;
      readonly newByteLength: number;
      readonly newChunkCount: number;
    }
  | {
      readonly kind: "chunk";
      readonly side: "old" | "new";
      readonly chunkIndex: number;
      readonly data: string;
    }
  | { readonly kind: "complete"; readonly oldSha256: string; readonly newSha256: string };
/** Per-operation support flags keyed by `api.method`. */
export type VcsOperationsSupport = {
  readonly "status.get": boolean;
  readonly "status.refresh": boolean;
  readonly "status.subscribe": boolean;
  readonly "refs.list": boolean;
  readonly "refs.create": boolean;
  readonly "refs.switch": boolean;
  readonly "changes.list": boolean;
  readonly "changes.stage": boolean;
  readonly "changes.unstage": boolean;
  readonly "changes.commit": boolean;
  readonly "diff.getPreview": boolean;
  readonly "diff.getFileContents": boolean;
  readonly "repository.pull": boolean;
  readonly "repository.init": boolean;
  readonly "repository.createWorktree": boolean;
  readonly "repository.removeWorktree": boolean;
  readonly "repository.push": boolean;
  readonly "repository.fetch": boolean;
  readonly "repository.listRemotes": boolean;
};
/** The operations map a frozen 1.0.0 host reports — the 16 shipped keys only. */
export type VcsOperationsSupportV1 = Omit<
  VcsOperationsSupport,
  "repository.push" | "repository.fetch" | "repository.listRemotes"
>;
export type VcsDriverCapabilitiesInfo = {
  readonly kind: VcsDriverKindValue;
  readonly supportsWorktrees: boolean;
  readonly supportsBookmarks: boolean;
  readonly supportsAtomicSnapshot: boolean;
  readonly supportsPushDefaultRemote: boolean;
  readonly ignoreClassifier: "native" | "git-compatible-fallback";
};
export type VcsCapabilitiesResult = {
  readonly detected: boolean;
  readonly kind: VcsDriverKindValue | null;
  /** Detection failure detail when a repository could not be resolved. */
  readonly detail: string | null;
  readonly driver: VcsDriverCapabilitiesInfo | null;
  readonly operations: VcsOperationsSupport;
};
/** Frozen 1.0.0 getCapabilities output — narrower operations map only. */
export type VcsCapabilitiesResultV1 = Omit<VcsCapabilitiesResult, "operations"> & {
  readonly operations: VcsOperationsSupportV1;
};
export type VcsPullResult = {
  readonly status: "pulled" | "skipped_up_to_date";
  readonly refName: string;
  readonly upstreamRef: string | null;
};
/** Mirrors the driver's GitPushResult under the contract's ref naming. */
export type VcsPushResult = {
  readonly status: "pushed" | "skipped_up_to_date";
  readonly refName: string;
  readonly upstreamRef: string | null;
  readonly setUpstream: boolean;
};
/** Fetch remote-tracking refs for one remote or, when omitted, every remote. */
export type VcsFetchInput = { readonly remoteName?: string };
export type VcsFetchResult = { readonly remotes: readonly string[] };
export type VcsRemoteEntry = {
  readonly name: string;
  readonly url: string;
  readonly pushUrl: string | null;
  readonly isPrimary: boolean;
};
export type VcsListRemotesResult = {
  readonly isRepo: boolean;
  readonly remotes: readonly VcsRemoteEntry[];
};
export type VcsInitInput = { readonly kind?: "git" };
export type VcsCreateWorktreeInput = {
  readonly refName: string;
  readonly newRefName?: string;
  readonly baseRefName?: string;
  readonly path: string | null;
};
export type VcsCreateWorktreeResult = {
  readonly worktree: { readonly path: string; readonly refName: string };
};
export type VcsRemoveWorktreeInput = { readonly path: string; readonly force?: boolean };
export type VcsEmptyResult = Record<string, never>;

const vcsPath = { type: "string", minLength: 1, maxLength: 512 } as const;
const vcsPathsInput = {
  type: "array",
  minItems: 1,
  maxItems: 100,
  items: vcsPath,
} as const;
/**
 * `git check-ref-format` essentials enforced declaratively — a bound the
 * private RPC leaves to the driver. Host-produced ref fields stay plain.
 */
const vcsRefNameInput = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  allOf: [
    { not: { pattern: "\\.\\." } },
    { not: { pattern: "@\\{" } },
    { not: { pattern: "[\\x00-\\x20~^:?*\\[\\\\]" } },
    { not: { pattern: "(^|/)\\." } },
    { not: { pattern: "//" } },
    { not: { pattern: "^[/-]" } },
    { not: { pattern: "[/.]$" } },
    { not: { pattern: "\\.lock(/|$)" } },
    { not: { pattern: "^@$" } },
  ],
} as const;
const vcsRefNameOutput = { type: "string", minLength: 1, maxLength: 4096 } as const;
const vcsRefNameOrNull = { type: ["string", "null"], minLength: 1, maxLength: 4096 } as const;
/**
 * Revision inputs (diff baseRef/headRef) accept revspecs, not just refnames —
 * but a leading `-` would inject options into `git diff`/`git show` argv, and
 * whitespace/control characters are never valid. Enforced declaratively.
 */
const vcsRevSpec = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  allOf: [{ not: { pattern: "^-" } }, { not: { pattern: "[\\s\\x00-\\x1f]" } }],
} as const;
const vcsRevSpecOrNull = { anyOf: [{ type: "null" }, vcsRevSpec] } as const;
const vcsStatusFileSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "insertions", "deletions"],
  properties: {
    path: vcsPath,
    insertions: { type: "integer", minimum: 0 },
    deletions: { type: "integer", minimum: 0 },
  },
} as const;
const vcsStatusLocalSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "isRepo",
    "hasPrimaryRemote",
    "isDefaultRef",
    "refName",
    "hasWorkingTreeChanges",
    "workingTree",
  ],
  properties: {
    isRepo: { type: "boolean" },
    sourceControlProvider: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "name", "baseUrl"],
      properties: {
        kind: { enum: ["github", "gitlab", "azure-devops", "bitbucket", "forgejo", "unknown"] },
        name: { type: "string", minLength: 1, maxLength: 256 },
        baseUrl: { type: "string", maxLength: 2048 },
      },
    },
    hasPrimaryRemote: { type: "boolean" },
    isDefaultRef: { type: "boolean" },
    refName: vcsRefNameOrNull,
    hasWorkingTreeChanges: { type: "boolean" },
    workingTree: {
      type: "object",
      additionalProperties: false,
      required: ["files", "insertions", "deletions", "truncated"],
      properties: {
        files: { type: "array", maxItems: 5000, items: vcsStatusFileSchema },
        insertions: { type: "integer", minimum: 0 },
        deletions: { type: "integer", minimum: 0 },
        truncated: { type: "boolean" },
      },
    },
  },
} as const;
const vcsChangeRequestSchema = {
  type: ["object", "null"],
  additionalProperties: false,
  required: ["number", "title", "url", "baseRef", "headRef", "state"],
  properties: {
    number: { type: "integer", minimum: 1 },
    title: { type: "string", minLength: 1, maxLength: 512 },
    url: { type: "string", maxLength: 2048 },
    baseRef: vcsRefNameOutput,
    headRef: vcsRefNameOutput,
    state: { enum: ["open", "closed", "merged"] },
    isDraft: { type: "boolean" },
    updatedAt: { type: ["string", "null"], maxLength: 64 },
  },
} as const;
const vcsStatusRemoteSchema = {
  type: "object",
  additionalProperties: false,
  required: ["hasUpstream", "aheadCount", "behindCount", "pr"],
  properties: {
    hasUpstream: { type: "boolean" },
    aheadCount: { type: "integer", minimum: 0 },
    behindCount: { type: "integer", minimum: 0 },
    aheadOfDefaultCount: { type: "integer", minimum: 0 },
    pr: vcsChangeRequestSchema,
  },
} as const;
const vcsStatusResultSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "isRepo",
    "hasPrimaryRemote",
    "isDefaultRef",
    "refName",
    "hasWorkingTreeChanges",
    "workingTree",
    "hasUpstream",
    "aheadCount",
    "behindCount",
    "pr",
  ],
  properties: {
    ...vcsStatusLocalSchema.properties,
    ...vcsStatusRemoteSchema.properties,
  },
} as const;
const vcsEmptyInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;
const vcsAckOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

/** Public stream event shape — the private `_tag` union mirrored with `kind`. */
const vcsStatusStreamEventSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "local", "remote"],
      properties: {
        kind: { const: "snapshot" },
        local: vcsStatusLocalSchema,
        remote: { anyOf: [vcsStatusRemoteSchema, { type: "null" }] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "local"],
      properties: { kind: { const: "localUpdated" }, local: vcsStatusLocalSchema },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "remote"],
      properties: {
        kind: { const: "remoteUpdated" },
        remote: { anyOf: [vcsStatusRemoteSchema, { type: "null" }] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "reason"],
      properties: {
        kind: { const: "closed" },
        reason: { enum: ["overflow", "status-error"] },
      },
    },
  ],
} as const;
/**
 * Working-tree + upstream status. `get` serves the cached/merged snapshot,
 * `refresh` forces local+remote recompute; both mirror the private
 * vcs.refreshStatus / subscribeVcsStatus semantics over
 * VcsStatusBroadcaster. `subscribe` emits snapshot → localUpdated /
 * remoteUpdated frames; there is no resume cursor.
 */
export const vcsStatusApi: TypedApi<{
  get: { input: Record<string, never>; output: VcsStatusResult };
  refresh: { input: Record<string, never>; output: VcsStatusResult };
}> &
  TypedStreamApi<{
    subscribe: { input: Record<string, never>; event: VcsStatusStreamEvent };
  }> = defineStreamApi<{
  subscribe: { input: Record<string, never>; event: VcsStatusStreamEvent };
}>({
  id: VCS_STATUS,
  version: "1.0.0",
  methods: [
    {
      name: "get",
      effect: "read",
      requiredGrants: [VCS_READ],
      inputSchema: vcsEmptyInputSchema,
      outputSchema: vcsStatusResultSchema,
    },
    {
      name: "refresh",
      effect: "read",
      requiredGrants: [VCS_READ],
      inputSchema: vcsEmptyInputSchema,
      outputSchema: vcsStatusResultSchema,
    },
  ],
  streams: [
    {
      name: "subscribe",
      requiredGrants: [VCS_READ],
      inputSchema: vcsEmptyInputSchema,
      eventSchema: vcsStatusStreamEventSchema,
    },
  ],
});

const vcsRefEntrySchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "current", "isDefault", "worktreePath"],
  properties: {
    name: vcsRefNameOutput,
    isRemote: { type: "boolean" },
    remoteName: vcsRefNameOutput,
    current: { type: "boolean" },
    isDefault: { type: "boolean" },
    worktreePath: { type: ["string", "null"], minLength: 1, maxLength: 32768 },
  },
} as const;
/**
 * Ref listing and checkout mutations. `list` mirrors vcs.listRefs (≤200 page,
 * query/kind/remote filters); `create`/`switch` mirror vcs.createRef /
 * vcs.switchRef and require `t3.vcs/mutate` — checkout moves the working
 * tree, so it is never authorized by the read grant.
 */
export const vcsRefsApi = defineApi<{
  list: { input: VcsListRefsInput; output: VcsListRefsResult };
  create: { input: VcsCreateRefInput; output: VcsRefNameResult };
  switch: { input: VcsRefNameInput; output: VcsSwitchRefResult };
}>({
  id: VCS_REFS,
  version: "1.0.0",
  methods: [
    {
      name: "list",
      effect: "read",
      requiredGrants: [VCS_READ],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", maxLength: 256 },
          cursor: { type: "integer", minimum: 0 },
          includeMatchingRemoteRefs: { type: "boolean" },
          refKind: { enum: ["all", "local", "remote"] },
          refresh: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 200 },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["refs", "isRepo", "hasPrimaryRemote", "nextCursor", "totalCount"],
        properties: {
          refs: { type: "array", maxItems: 200, items: vcsRefEntrySchema },
          isRepo: { type: "boolean" },
          hasPrimaryRemote: { type: "boolean" },
          nextCursor: { type: ["integer", "null"], minimum: 0 },
          totalCount: { type: "integer", minimum: 0 },
        },
      },
    },
    {
      name: "create",
      effect: "write",
      requiredGrants: [VCS_MUTATE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["refName"],
        properties: { refName: vcsRefNameInput, switchRef: { type: "boolean" } },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["refName"],
        properties: { refName: vcsRefNameOutput },
      },
    },
    {
      name: "switch",
      effect: "write",
      requiredGrants: [VCS_MUTATE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["refName"],
        properties: { refName: vcsRefNameInput },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["refName"],
        properties: { refName: vcsRefNameOrNull },
      },
    },
  ],
});

const vcsChangeEntrySchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "staged", "unstaged", "untracked", "conflicted"],
  properties: {
    path: vcsPath,
    staged: { type: "boolean" },
    unstaged: { type: "boolean" },
    untracked: { type: "boolean" },
    conflicted: { type: "boolean" },
  },
} as const;
/**
 * Index staging. `list` exposes per-path staged/unstaged/untracked/
 * conflicted state the private status payload drops (porcelain XY state —
 * GitVcsDriverCore only keeps paths). `stage`/`unstage`/`commit` are the
 * same driver operations the native stacked action performs
 * (`add -A -- <paths>` / `reset` / `commit`), under `t3.vcs/mutate`.
 * `commit.paths` mirrors native semantics: given → reset + add -A those
 * paths only; omitted → add -A all changes.
 */
export const vcsChangesApi = defineApi<{
  list: { input: Record<string, never>; output: VcsChangesListResult };
  stage: { input: VcsPathsInput; output: VcsPathsResult };
  unstage: { input: VcsPathsInput; output: VcsPathsResult };
  commit: { input: VcsCommitInput; output: VcsCommitResult };
}>({
  id: VCS_CHANGES,
  version: "1.0.0",
  methods: [
    {
      name: "list",
      effect: "read",
      requiredGrants: [VCS_READ],
      inputSchema: vcsEmptyInputSchema,
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["isRepo", "entries", "truncated"],
        properties: {
          isRepo: { type: "boolean" },
          entries: { type: "array", maxItems: 5000, items: vcsChangeEntrySchema },
          truncated: { type: "boolean" },
        },
      },
    },
    {
      name: "stage",
      effect: "write",
      requiredGrants: [VCS_MUTATE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["paths"],
        properties: { paths: vcsPathsInput },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["paths"],
        properties: { paths: vcsPathsInput },
      },
    },
    {
      name: "unstage",
      effect: "write",
      requiredGrants: [VCS_MUTATE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["paths"],
        properties: { paths: vcsPathsInput },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["paths"],
        properties: { paths: vcsPathsInput },
      },
    },
    {
      name: "commit",
      effect: "write",
      requiredGrants: [VCS_MUTATE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["message"],
        properties: {
          message: { type: "string", minLength: 1, maxLength: 10000 },
          paths: vcsPathsInput,
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["commitSha", "refName"],
        properties: {
          commitSha: { type: "string", minLength: 1, maxLength: 64 },
          refName: vcsRefNameOrNull,
        },
      },
    },
  ],
});

const vcsDiffPreviewSourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "title", "baseRef", "headRef", "diff", "diffHash", "truncated"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 64 },
    kind: { enum: ["working-tree", "branch-range"] },
    title: { type: "string", minLength: 1, maxLength: 256 },
    baseRef: vcsRefNameOrNull,
    headRef: vcsRefNameOrNull,
    diff: { type: "string", maxLength: 512000 },
    diffHash: { type: "string", minLength: 1, maxLength: 128 },
    truncated: { type: "boolean" },
  },
} as const;
const vcsDiffPreviewInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    baseRef: vcsRevSpec,
    ignoreWhitespace: { type: "boolean" },
  },
} as const;
const vcsDiffFileContentsInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sourceKind", "changeType", "baseRef", "headRef", "oldPath", "newPath"],
  properties: {
    sourceKind: { enum: ["working-tree", "branch-range"] },
    changeType: { enum: ["change", "rename-pure", "rename-changed", "new", "deleted"] },
    baseRef: vcsRevSpecOrNull,
    headRef: vcsRevSpecOrNull,
    oldPath: vcsPath,
    newPath: vcsPath,
  },
} as const;
const vcsDiffGetPreviewMethod = {
  name: "getPreview",
  effect: "read",
  requiredGrants: [VCS_READ],
  inputSchema: vcsDiffPreviewInputSchema,
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["generatedAt", "sources"],
    properties: {
      generatedAt: { type: "string", maxLength: 64 },
      sources: { type: "array", maxItems: 8, items: vcsDiffPreviewSourceSchema },
    },
  },
} as const;
const vcsDiffGetFileContentsMethod = {
  name: "getFileContents",
  effect: "read",
  requiredGrants: [VCS_READ],
  inputSchema: vcsDiffFileContentsInputSchema,
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["oldContents", "newContents"],
    properties: {
      oldContents: { type: "string", maxLength: 1048576 },
      newContents: { type: "string", maxLength: 1048576 },
    },
  },
} as const;
const vcsDiffSha256 = {
  type: "string",
  minLength: 64,
  maxLength: 64,
  pattern: "^[0-9a-f]{64}$",
} as const;
/**
 * Chunk bodies stay at 8 192 UTF-16 units so the encoded broker frame can
 * never reach 64 KiB even under pathological JSON escaping (≤6 bytes per
 * unit). The adapter additionally verifies each wrapped frame's byte size.
 */
const vcsDiffChunkData = { type: "string", maxLength: 8192 } as const;
const vcsDiffStreamSourceSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "kind",
    "title",
    "baseRef",
    "headRef",
    "truncated",
    "diffHash",
    "diffByteLength",
    "chunkCount",
  ],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 64 },
    kind: { enum: ["working-tree", "branch-range"] },
    title: { type: "string", minLength: 1, maxLength: 256 },
    baseRef: vcsRefNameOrNull,
    headRef: vcsRefNameOrNull,
    truncated: { type: "boolean" },
    diffHash: vcsDiffSha256,
    diffByteLength: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    chunkCount: { type: "integer", minimum: 0, maximum: 64 },
  },
} as const;
const vcsDiffPreviewStreamEventSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "generatedAt", "sources"],
      properties: {
        kind: { const: "manifest" },
        generatedAt: { type: "string", maxLength: 64 },
        sources: { type: "array", maxItems: 8, items: vcsDiffStreamSourceSchema },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "sourceIndex", "chunkIndex", "data"],
      properties: {
        kind: { const: "chunk" },
        sourceIndex: { type: "integer", minimum: 0, maximum: 7 },
        chunkIndex: { type: "integer", minimum: 0, maximum: 63 },
        data: vcsDiffChunkData,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "payloadSha256"],
      properties: {
        kind: { const: "complete" },
        payloadSha256: vcsDiffSha256,
      },
    },
  ],
} as const;
const vcsDiffFileContentsStreamEventSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "oldByteLength", "oldChunkCount", "newByteLength", "newChunkCount"],
      properties: {
        kind: { const: "manifest" },
        // A surrogate pair straddling a boundary shrinks a chunk to 8 191
        // units, so the worst case is ceil(1 048 576 / 8 191) = 129 chunks.
        oldByteLength: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        oldChunkCount: { type: "integer", minimum: 0, maximum: 129 },
        newByteLength: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        newChunkCount: { type: "integer", minimum: 0, maximum: 129 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "side", "chunkIndex", "data"],
      properties: {
        kind: { const: "chunk" },
        side: { enum: ["old", "new"] },
        chunkIndex: { type: "integer", minimum: 0, maximum: 128 },
        data: vcsDiffChunkData,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "oldSha256", "newSha256"],
      properties: {
        kind: { const: "complete" },
        oldSha256: vcsDiffSha256,
        newSha256: vcsDiffSha256,
      },
    },
  ],
} as const;
/**
 * Review-shaped diff reads (private review.getDiffPreview /
 * review.getDiffFileContents). Native gates these on `review:write` though
 * both are semantic reads — the public contract correctly puts them under
 * `t3.vcs/read`. `diff` is capped at 512 000 chars; the adapter slices and
 * ORs `truncated` because native joins a ≤120 KB tracked patch with up to
 * 80 KB per untracked file. `getFileContents` is a git-only operation on
 * the host today — other drivers fail by name.
 *
 * Envelope interaction: invoke results cross the broker's 64 KiB payload
 * envelope, so a `truncated:true` preview can never be delivered by
 * `getPreview` — the smallest truncated body (one untracked file sliced at
 * 80 KB = 81 920 bytes) already exceeds it, and so does any untruncated
 * result past ~64 KiB — `getFileContents` payloads included once they cross
 * the envelope. The unary
 * methods remain correct for small diffs; `streamPreview` and
 * `streamFileContents` (1.1.0) deliver the same bounded payloads as ≤64 KiB
 * frames: a `manifest` snapshot with per-source sha256/chunk counts, `chunk`
 * data frames, then a `complete` frame carrying the sha256 over the full
 * delivered payload. Stream availability follows the unary support flags
 * (`diff.getPreview` / `diff.getFileContents` in getCapabilities). Streams
 * are one-shot — no resume cursor; cancel by abandoning the iterator.
 */
export const vcsDiffApi: TypedApi<{
  getPreview: { input: VcsDiffPreviewInput; output: VcsDiffPreviewResult };
  getFileContents: { input: VcsDiffFileContentsInput; output: VcsDiffFileContentsResult };
}> &
  TypedStreamApi<{
    streamPreview: { input: VcsDiffPreviewInput; event: VcsDiffPreviewStreamEvent };
    streamFileContents: {
      input: VcsDiffFileContentsInput;
      event: VcsDiffFileContentsStreamEvent;
    };
  }> = defineStreamApi<{
  streamPreview: { input: VcsDiffPreviewInput; event: VcsDiffPreviewStreamEvent };
  streamFileContents: {
    input: VcsDiffFileContentsInput;
    event: VcsDiffFileContentsStreamEvent;
  };
}>({
  id: VCS_DIFF,
  version: "1.1.0",
  methods: [vcsDiffGetPreviewMethod, vcsDiffGetFileContentsMethod],
  streams: [
    {
      name: "streamPreview",
      requiredGrants: [VCS_READ],
      inputSchema: vcsDiffPreviewInputSchema,
      eventSchema: vcsDiffPreviewStreamEventSchema,
    },
    {
      name: "streamFileContents",
      requiredGrants: [VCS_READ],
      inputSchema: vcsDiffFileContentsInputSchema,
      eventSchema: vcsDiffFileContentsStreamEventSchema,
    },
  ],
});
/** Frozen published 1.0.0 definition; shared definitions are immutable per version. */
export const vcsDiffApiV1 = defineApi<{
  getPreview: { input: VcsDiffPreviewInput; output: VcsDiffPreviewResult };
  getFileContents: { input: VcsDiffFileContentsInput; output: VcsDiffFileContentsResult };
}>({
  id: VCS_DIFF,
  version: "1.0.0",
  methods: [vcsDiffGetPreviewMethod, vcsDiffGetFileContentsMethod],
});

const vcsOperationsSupportSchemaV1 = {
  type: "object",
  additionalProperties: false,
  required: [
    "status.get",
    "status.refresh",
    "status.subscribe",
    "refs.list",
    "refs.create",
    "refs.switch",
    "changes.list",
    "changes.stage",
    "changes.unstage",
    "changes.commit",
    "diff.getPreview",
    "diff.getFileContents",
    "repository.pull",
    "repository.init",
    "repository.createWorktree",
    "repository.removeWorktree",
  ],
  properties: {
    "status.get": { type: "boolean" },
    "status.refresh": { type: "boolean" },
    "status.subscribe": { type: "boolean" },
    "refs.list": { type: "boolean" },
    "refs.create": { type: "boolean" },
    "refs.switch": { type: "boolean" },
    "changes.list": { type: "boolean" },
    "changes.stage": { type: "boolean" },
    "changes.unstage": { type: "boolean" },
    "changes.commit": { type: "boolean" },
    "diff.getPreview": { type: "boolean" },
    "diff.getFileContents": { type: "boolean" },
    "repository.pull": { type: "boolean" },
    "repository.init": { type: "boolean" },
    "repository.createWorktree": { type: "boolean" },
    "repository.removeWorktree": { type: "boolean" },
  },
} as const;
/** 1.1.0 operations map — 1.0.0 keys plus the push/fetch/listRemotes rows. */
const vcsOperationsSupportSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    ...vcsOperationsSupportSchemaV1.required,
    "repository.push",
    "repository.fetch",
    "repository.listRemotes",
  ],
  properties: {
    ...vcsOperationsSupportSchemaV1.properties,
    "repository.push": { type: "boolean" },
    "repository.fetch": { type: "boolean" },
    "repository.listRemotes": { type: "boolean" },
  },
} as const;
const vcsDriverCapabilitiesSchema = {
  type: ["object", "null"],
  additionalProperties: false,
  required: [
    "kind",
    "supportsWorktrees",
    "supportsBookmarks",
    "supportsAtomicSnapshot",
    "supportsPushDefaultRemote",
    "ignoreClassifier",
  ],
  properties: {
    kind: { enum: ["git", "jj", "unknown"] },
    supportsWorktrees: { type: "boolean" },
    supportsBookmarks: { type: "boolean" },
    supportsAtomicSnapshot: { type: "boolean" },
    supportsPushDefaultRemote: { type: "boolean" },
    ignoreClassifier: { enum: ["native", "git-compatible-fallback"] },
  },
} as const;
const vcsCapabilitiesResultSchemaV1 = {
  type: "object",
  additionalProperties: false,
  required: ["detected", "kind", "detail", "driver", "operations"],
  properties: {
    detected: { type: "boolean" },
    kind: { type: ["string", "null"], enum: ["git", "jj", "unknown", null] },
    detail: { type: ["string", "null"], maxLength: 512 },
    driver: vcsDriverCapabilitiesSchema,
    operations: vcsOperationsSupportSchemaV1,
  },
} as const;
const vcsCapabilitiesResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["detected", "kind", "detail", "driver", "operations"],
  properties: {
    detected: { type: "boolean" },
    kind: { type: ["string", "null"], enum: ["git", "jj", "unknown", null] },
    detail: { type: ["string", "null"], maxLength: 512 },
    driver: vcsDriverCapabilitiesSchema,
    operations: vcsOperationsSupportSchema,
  },
} as const;
const vcsRepositoryGetCapabilitiesMethodV1 = {
  name: "getCapabilities",
  effect: "read",
  requiredGrants: [VCS_READ],
  inputSchema: vcsEmptyInputSchema,
  outputSchema: vcsCapabilitiesResultSchemaV1,
} as const;
const vcsRepositoryGetCapabilitiesMethod = {
  name: "getCapabilities",
  effect: "read",
  requiredGrants: [VCS_READ],
  inputSchema: vcsEmptyInputSchema,
  outputSchema: vcsCapabilitiesResultSchema,
} as const;
const vcsRepositoryPullMethod = {
  name: "pull",
  effect: "write",
  requiredGrants: [VCS_MUTATE],
  inputSchema: vcsEmptyInputSchema,
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["status", "refName", "upstreamRef"],
    properties: {
      status: { enum: ["pulled", "skipped_up_to_date"] },
      refName: vcsRefNameOutput,
      upstreamRef: vcsRefNameOrNull,
    },
  },
} as const;
const vcsRepositoryInitMethod = {
  name: "init",
  effect: "write",
  requiredGrants: [VCS_MUTATE],
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { kind: { enum: ["git"] } },
  },
  outputSchema: vcsAckOutputSchema,
} as const;
const vcsRepositoryCreateWorktreeMethod = {
  name: "createWorktree",
  effect: "write",
  requiredGrants: [VCS_MUTATE],
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["refName", "path"],
    properties: {
      refName: vcsRefNameInput,
      newRefName: vcsRefNameInput,
      baseRefName: vcsRefNameInput,
      path: { type: ["string", "null"], minLength: 1, maxLength: 32768 },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["worktree"],
    properties: {
      worktree: {
        type: "object",
        additionalProperties: false,
        required: ["path", "refName"],
        properties: {
          path: { type: "string", minLength: 1, maxLength: 32768 },
          refName: vcsRefNameOutput,
        },
      },
    },
  },
} as const;
const vcsRepositoryRemoveWorktreeMethod = {
  name: "removeWorktree",
  effect: "write",
  requiredGrants: [VCS_MUTATE],
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: {
        type: "string",
        minLength: 1,
        maxLength: 32768,
      },
      force: { type: "boolean" },
    },
  },
  outputSchema: vcsAckOutputSchema,
} as const;
const vcsRepositoryPushMethod = {
  name: "push",
  effect: "write",
  requiredGrants: [VCS_MUTATE],
  inputSchema: vcsEmptyInputSchema,
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["status", "refName", "upstreamRef", "setUpstream"],
    properties: {
      status: { enum: ["pushed", "skipped_up_to_date"] },
      refName: vcsRefNameOutput,
      upstreamRef: vcsRefNameOrNull,
      setUpstream: { type: "boolean" },
    },
  },
} as const;
/** Remote names reject option-injection prefixes and whitespace/controls. */
const vcsRemoteNameInput = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  allOf: [{ not: { pattern: "^-" } }, { not: { pattern: "[\\s\\x00-\\x1f]" } }],
} as const;
const vcsRepositoryFetchMethod = {
  name: "fetch",
  effect: "write",
  requiredGrants: [VCS_MUTATE],
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { remoteName: vcsRemoteNameInput },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["remotes"],
    properties: {
      remotes: {
        type: "array",
        maxItems: 64,
        items: { type: "string", minLength: 1, maxLength: 256 },
      },
    },
  },
} as const;
const vcsRepositoryListRemotesMethod = {
  name: "listRemotes",
  effect: "read",
  requiredGrants: [VCS_READ],
  inputSchema: vcsEmptyInputSchema,
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["isRepo", "remotes"],
    properties: {
      isRepo: { type: "boolean" },
      remotes: {
        type: "array",
        maxItems: 64,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "url", "pushUrl", "isPrimary"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 256 },
            url: { type: "string", minLength: 1, maxLength: 2048 },
            pushUrl: { type: ["string", "null"], minLength: 1, maxLength: 2048 },
            isPrimary: { type: "boolean" },
          },
        },
      },
    },
  },
} as const;
/**
 * Repository-level capability discovery and authorized mutations.
 * `getCapabilities` is the honesty mechanism — it names the detected kind,
 * the driver flag set, and per-operation support so consumers never guess.
 * `pull`/`init`/`createWorktree`/`removeWorktree` mirror the private
 * vcs.pull / vcs.init / worktree RPCs under `t3.vcs/mutate`; 1.1.0 adds the
 * sync primitives `push`/`fetch` (write, mutate grant — fetch writes
 * remote-tracking refs) and `listRemotes` (read) off the driver interface.
 */
export const vcsRepositoryApi = defineApi<{
  getCapabilities: { input: Record<string, never>; output: VcsCapabilitiesResult };
  pull: { input: Record<string, never>; output: VcsPullResult };
  init: { input: VcsInitInput; output: VcsEmptyResult };
  createWorktree: { input: VcsCreateWorktreeInput; output: VcsCreateWorktreeResult };
  removeWorktree: { input: VcsRemoveWorktreeInput; output: VcsEmptyResult };
  push: { input: Record<string, never>; output: VcsPushResult };
  fetch: { input: VcsFetchInput; output: VcsFetchResult };
  listRemotes: { input: Record<string, never>; output: VcsListRemotesResult };
}>({
  id: VCS_REPOSITORY,
  version: "1.1.0",
  methods: [
    vcsRepositoryGetCapabilitiesMethod,
    vcsRepositoryPullMethod,
    vcsRepositoryInitMethod,
    vcsRepositoryCreateWorktreeMethod,
    vcsRepositoryRemoveWorktreeMethod,
    vcsRepositoryPushMethod,
    vcsRepositoryFetchMethod,
    vcsRepositoryListRemotesMethod,
  ],
});
/** Frozen published 1.0.0 definition; shared definitions are immutable per version. */
export const vcsRepositoryApiV1 = defineApi<{
  getCapabilities: { input: Record<string, never>; output: VcsCapabilitiesResultV1 };
  pull: { input: Record<string, never>; output: VcsPullResult };
  init: { input: VcsInitInput; output: VcsEmptyResult };
  createWorktree: { input: VcsCreateWorktreeInput; output: VcsCreateWorktreeResult };
  removeWorktree: { input: VcsRemoveWorktreeInput; output: VcsEmptyResult };
}>({
  id: VCS_REPOSITORY,
  version: "1.0.0",
  methods: [
    vcsRepositoryGetCapabilitiesMethodV1,
    vcsRepositoryPullMethod,
    vcsRepositoryInitMethod,
    vcsRepositoryCreateWorktreeMethod,
    vcsRepositoryRemoveWorktreeMethod,
  ],
});

export const VCS_STATUS_API = vcsStatusApi.definition;
export const VCS_REFS_API = vcsRefsApi.definition;
export const VCS_CHANGES_API = vcsChangesApi.definition;
export const VCS_DIFF_API = vcsDiffApi.definition;
export const VCS_DIFF_API_V1 = vcsDiffApiV1.definition;
export const VCS_REPOSITORY_API = vcsRepositoryApi.definition;
export const VCS_REPOSITORY_API_V1 = vcsRepositoryApiV1.definition;

/* ------------------------------------------------------------------------
 * t3.resources/lease — promoted binary/media presentation leases
 * (docs/internals/extensions/resources-lease-design.md).
 *
 * `createPresentationUrl` mints the NATIVE signed asset URL
 * (`/api/assets/<token>/<name>`, 1h HMAC claims, canonical-path containment
 * re-checked at serve time) for a ResourceRef mirroring the private
 * `AssetResource` union. The signed token IS the auth on the asset route —
 * `<img>`/webviews cannot set headers — so mint-time is the only grant check
 * and it is per-kind: the broker ANDs `requiredGrants` over every caller,
 * which cannot express "the grant follows `resource._tag`", so both methods
 * declare none and the host adapter enforces RESOURCE_LEASE_KIND_GRANTS for
 * every caller in the chain, before and after minting.
 *
 * Grant map: `workspace-file` and `project-favicon` ride
 * `t3.workspace/resources` — the resource-transfer contract's read grant
 * (a grant id and an API id are distinct registries sharing the string). `browser-surface` rides
 * `t3.browser/sessions` — the browser sessions contract's id, declared the same
 * way: only the browser sessions contract holder may vend presentation
 * leases onto a live engine session. `attachment` stays in the union but
 * carries no grant until the messages/composer read grant exists; the
 * adapter denies it by name. `media-file` (absolute paths are arbitrary-path
 * minting, a spec non-goal) and `native-app-icon` (no consumer) are not in
 * the union. ws-stream-class claims (`device-stream`) arrive with device streams on the
 * existing DeviceHubProxy wsTicket TTL semantics; `browser-surface` is a
 * URL/presentation-class claim, not ws-stream.
 * --------------------------------------------------------------------- */
export const RESOURCES_LEASE = "t3.resources/lease";
// WORKSPACE_RESOURCES (the `t3.workspace/resources` grant/API id) is declared
// by the transfer contract in ./workspaceResources.js and re-exported above —
// the `workspace-file`/`project-favicon` lease kinds mint under its grant.
/**
 * The `t3.browser/sessions` contract's id, shared as that contract's read
 * grant and as the `browser-surface` mint grant — the sessions contract
 * holder is the only authority the design allows to bind a presentation
 * lease to an engine session.
 */
export const BROWSER_SESSIONS = "t3.browser/sessions";

/**
 * The closed command vocabulary a `browser-surface` lease may carry — the
 * presentation-attachment channel's verbs: bind the session's presentation
 * (`attach`), drive bounds/visibility/stacking (`present`), and release
 * without closing the session (`release`). Engine commands (navigate,
 * reload, zoom, DevTools, …) are `t3.browser/sessions` methods checked per
 * call by the broker and are deliberately not encodable in a lease.
 */
export const BROWSER_SURFACE_COMMANDS = ["attach", "present", "release"] as const;
export type BrowserSurfaceCommand = (typeof BROWSER_SURFACE_COMMANDS)[number];

/** ResourceRef input kinds the contract accepts on the wire. */
export type ResourceLeaseRefKind =
  | "workspace-file"
  | "attachment"
  | "project-favicon"
  | "browser-surface";
/** The claim kinds a mint can produce; echoed back as `kind`. */
export type ResourceLeaseClaimKind =
  | "workspace-file"
  | "workspace-file-exact"
  | "project-favicon"
  | "project-favicon-external"
  | "browser-surface";
export type ResourceLeaseRef =
  | {
      readonly _tag: "workspace-file";
      readonly threadId: string;
      readonly path: string;
    }
  | {
      readonly _tag: "attachment";
      readonly attachmentId: string;
      readonly fileName?: string;
      readonly mimeType?: string;
      readonly disposition?: "inline" | "attachment";
    }
  | {
      readonly _tag: "project-favicon";
      readonly cwd: string;
      readonly path?: string | null;
    }
  | {
      readonly _tag: "browser-surface";
      readonly threadId: string;
      readonly tabId: string;
      readonly serverEpoch: string;
      readonly allowedCommands: readonly BrowserSurfaceCommand[];
    };
export type ResourceLeaseCreatePresentationUrlInput = { readonly resource: ResourceLeaseRef };
export type ResourceLeasePresentationUrl = {
  /** Server-relative minted path — resolve against the environment origin. */
  readonly url: string;
  readonly expiresAt: number;
  readonly kind: ResourceLeaseClaimKind;
};
export type ResourceLeaseCapabilities = {
  /** Kinds this build can mint for a caller holding the kind's grant. */
  readonly supportedKinds: readonly ResourceLeaseRefKind[];
};
/** Frozen 1.0.0 wire shapes — before `browser-surface` joined the union. */
export type ResourceLeaseRefV1 = Exclude<ResourceLeaseRef, { readonly _tag: "browser-surface" }>;
export type ResourceLeaseClaimKindV1 = Exclude<ResourceLeaseClaimKind, "browser-surface">;
export type ResourceLeaseRefKindV1 = Exclude<ResourceLeaseRefKind, "browser-surface">;
export type ResourceLeaseCreatePresentationUrlInputV1 = {
  readonly resource: ResourceLeaseRefV1;
};
export type ResourceLeasePresentationUrlV1 = {
  readonly url: string;
  readonly expiresAt: number;
  readonly kind: ResourceLeaseClaimKindV1;
};
export type ResourceLeaseCapabilitiesV1 = {
  readonly supportedKinds: readonly ResourceLeaseRefKindV1[];
};
/**
 * Mint-time authority per resource kind; `null` means no grant exists in this
 * build and the adapter fails closed by name. `supportedKinds` is exactly the
 * kinds with a declared grant.
 */
export const RESOURCE_LEASE_KIND_GRANTS: Readonly<Record<ResourceLeaseRefKind, string | null>> = {
  "workspace-file": WORKSPACE_RESOURCES,
  "project-favicon": WORKSPACE_RESOURCES,
  attachment: null,
  "browser-surface": BROWSER_SESSIONS,
};
export const RESOURCE_LEASE_SUPPORTED_KINDS: readonly ResourceLeaseRefKind[] = (
  Object.keys(RESOURCE_LEASE_KIND_GRANTS) as ResourceLeaseRefKind[]
).filter((kind) => RESOURCE_LEASE_KIND_GRANTS[kind] !== null);

const resourceLeaseRefSchemaV1 = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["_tag", "threadId", "path"],
      properties: {
        _tag: { const: "workspace-file" },
        threadId: { type: "string", minLength: 1, maxLength: 160 },
        path: { type: "string", minLength: 1, maxLength: 1024 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["_tag", "attachmentId"],
      properties: {
        _tag: { const: "attachment" },
        attachmentId: { type: "string", minLength: 1, maxLength: 256 },
        fileName: { type: "string", minLength: 1, maxLength: 255 },
        mimeType: { type: "string", minLength: 1, maxLength: 100 },
        disposition: { enum: ["inline", "attachment"] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["_tag", "cwd"],
      properties: {
        _tag: { const: "project-favicon" },
        cwd: { type: "string", minLength: 1, maxLength: 1024 },
        path: {
          type: ["string", "null"],
          minLength: 1,
          maxLength: 1024,
          pattern: "\\.(?:avif|gif|ico|jpe?g|png|svg|webp)$",
        },
      },
    },
  ],
} as const;

const resourceLeaseBrowserSurfaceCommandsSchema = {
  type: "array",
  minItems: 1,
  maxItems: 3,
  uniqueItems: true,
  items: { enum: [...BROWSER_SURFACE_COMMANDS] },
} as const;

/** 1.1.0 input union — the shipped 1.0.0 branches plus `browser-surface`. */
const resourceLeaseRefSchema = {
  oneOf: [
    ...resourceLeaseRefSchemaV1.oneOf,
    {
      type: "object",
      additionalProperties: false,
      required: ["_tag", "threadId", "tabId", "serverEpoch", "allowedCommands"],
      properties: {
        _tag: { const: "browser-surface" },
        threadId: { type: "string", minLength: 1, maxLength: 160 },
        tabId: { type: "string", minLength: 1, maxLength: 128 },
        serverEpoch: { type: "string", minLength: 1, maxLength: 128 },
        allowedCommands: resourceLeaseBrowserSurfaceCommandsSchema,
      },
    },
  ],
} as const;

export const resourcesLeaseApi = defineApi<{
  createPresentationUrl: {
    input: ResourceLeaseCreatePresentationUrlInput;
    output: ResourceLeasePresentationUrl;
  };
  releasePresentation: {
    input: { readonly presentationUrl: string };
    output: { readonly released: boolean };
  };
  getCapabilities: { input: Record<string, never>; output: ResourceLeaseCapabilities };
}>({
  id: RESOURCES_LEASE,
  version: "1.1.0",
  methods: [
    {
      name: "createPresentationUrl",
      effect: "read",
      // Per-kind grants are enforced inside the host adapter — a method-level
      // list can only express "every caller holds all of these".
      requiredGrants: [],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["resource"],
        properties: { resource: resourceLeaseRefSchema },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["url", "expiresAt", "kind"],
        properties: {
          url: { type: "string", minLength: 1, maxLength: 4096 },
          expiresAt: { type: "number" },
          kind: {
            enum: [
              "workspace-file",
              "workspace-file-exact",
              "project-favicon",
              "project-favicon-external",
              "browser-surface",
            ],
          },
        },
      },
    },
    {
      name: "releasePresentation",
      // Acquired under the same read-scoped grant as `createPresentationUrl`;
      // releasing your own held claim is not a write of host state beyond what
      // the read grant already entitles the caller to hold. A `write` effect
      // would require a write-scope the minting caller never had, making the
      // release unreachable through the broker for the only callers it serves.
      effect: "read",
      // Only a held `browser-surface` claim can be released, and only by the
      // authority that holds it — enforced inside the host adapter.
      requiredGrants: [],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["presentationUrl"],
        properties: {
          // The value `createPresentationUrl` returned (`/api/assets/<token>/…`)
          // or the bare signed token.
          presentationUrl: { type: "string", minLength: 1, maxLength: 4096 },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["released"],
        properties: { released: { type: "boolean" } },
      },
    },
    {
      name: "getCapabilities",
      effect: "read",
      requiredGrants: [],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["supportedKinds"],
        properties: {
          supportedKinds: {
            type: "array",
            maxItems: 16,
            items: {
              enum: ["workspace-file", "attachment", "project-favicon", "browser-surface"],
            },
          },
        },
      },
    },
  ],
});
export const RESOURCES_LEASE_API = resourcesLeaseApi.definition;
/** Frozen published 1.0.0 definition; shared definitions are immutable per version. */
export const resourcesLeaseApiV1 = defineApi<{
  createPresentationUrl: {
    input: ResourceLeaseCreatePresentationUrlInputV1;
    output: ResourceLeasePresentationUrlV1;
  };
  getCapabilities: { input: Record<string, never>; output: ResourceLeaseCapabilitiesV1 };
}>({
  id: RESOURCES_LEASE,
  version: "1.0.0",
  methods: [
    {
      name: "createPresentationUrl",
      effect: "read",
      // Per-kind grants are enforced inside the host adapter — a method-level
      // list can only express "every caller holds all of these".
      requiredGrants: [],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["resource"],
        properties: { resource: resourceLeaseRefSchemaV1 },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["url", "expiresAt", "kind"],
        properties: {
          url: { type: "string", minLength: 1, maxLength: 4096 },
          expiresAt: { type: "number" },
          kind: {
            enum: [
              "workspace-file",
              "workspace-file-exact",
              "project-favicon",
              "project-favicon-external",
            ],
          },
        },
      },
    },
    {
      name: "getCapabilities",
      effect: "read",
      requiredGrants: [],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["supportedKinds"],
        properties: {
          supportedKinds: {
            type: "array",
            maxItems: 16,
            items: { enum: ["workspace-file", "attachment", "project-favicon"] },
          },
        },
      },
    },
  ],
});
export const RESOURCES_LEASE_API_V1 = resourcesLeaseApiV1.definition;

/* ------------------------------------------------------------------------
 * t3.prs/read — change-request (pull request) browser reads (P10C-PR).
 *
 * The native Version Control surface is fundamentally a PR browser; this is
 * the read side of that surface for plugins. Every method maps 1:1 onto a
 * native `pullRequests.*` read — the adapter calls PullRequestService and
 * never shells out to a host CLI itself.
 *
 * Grant: `t3.prs/read` covers every method and stream. Mutations
 * (pullRequests.runAction/update/comment/updateComment/submitReview/
 * replyToThread/setThreadResolution/setReaction/requestReviewers/setLabels —
 * all operate-scoped natively) are a later control contract, named deferred.
 *
 * Auth boundary: reads run on the environment's git-host credentials (the
 * signed-in gh/glab/az CLI or the server's configured Bitbucket token). The
 * plugin never supplies credentials — there is no auth field on any input —
 * and a project with no PR host or no working credentials fails by name
 * (PullRequestUnavailableError reason: cli-missing / cli-unauthenticated /
 * provider-unsupported) rather than returning an empty success.
 *
 * Capability honesty: `getCapabilities` reports the hosts the scoped project
 * resolves to (native PullRequestProviderSummary verbatim) plus a
 * per-operation support map derived from each configured host's provider —
 * e.g. Azure DevOps declares no diff capability, so `prs.streamDiff` reports
 * false there while `prs.list` stays true.
 * --------------------------------------------------------------------- */
export const PRS_READ = "t3.prs/read";

export type PrsProviderKind =
  | "github"
  | "gitlab"
  | "azure-devops"
  | "bitbucket"
  | "forgejo"
  | "unknown";
export type PrsActor = {
  readonly login: string;
  readonly name: string | null;
  readonly avatarUrl: string | null;
};
export type PrsLabel = { readonly name: string; readonly color: string | null };
export type PrsReaction = {
  readonly content:
    | "thumbs-up"
    | "thumbs-down"
    | "laugh"
    | "hooray"
    | "confused"
    | "heart"
    | "rocket"
    | "eyes";
  readonly count: number;
  readonly actors: readonly string[];
  readonly viewerHasReacted: boolean;
};
export type PrsCheck = {
  readonly name: string;
  readonly status:
    | "pending"
    | "action-required"
    | "success"
    | "failure"
    | "skipped"
    | "neutral"
    | "cancelled";
  readonly description: string | null;
  readonly url: string | null;
};
/**
 * One change request addressed on a host. `projectId` is absent: the
 * extension's project scope supplies it, exactly like the native
 * PullRequestRef the adapter constructs. `host` keeps the native cross-repo
 * routing — a thread in a frontend project may name a backend PR on the same
 * host.
 */
export type PrsRef = {
  readonly host?: string;
  readonly repository: string;
  readonly number: number;
};
export type PrsListFilters = {
  readonly draft?: "only" | "hide";
  readonly review?: "approved" | "changes-requested" | "review-required" | "none";
  readonly checks?: "passing" | "failing";
  readonly labels?: readonly (readonly string[])[];
  readonly excludedLabels?: readonly string[];
  readonly author?: string;
};
export type PrsListInput = {
  readonly state: "all" | "open" | "closed" | "merged";
  readonly involvement?: "all" | "reviewing" | "authored";
  readonly filters?: PrsListFilters;
  readonly host?: string;
  readonly limit?: number;
  readonly cursors?: Readonly<Record<string, string>>;
  readonly query?: string;
};
export type PrsStackMembership = {
  readonly number: number;
  readonly position: number;
  readonly size: number;
  readonly base: string;
};
export type PrsListEntry = {
  readonly stack?: PrsStackMembership;
  readonly provider: PrsProviderKind;
  readonly host: string;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: PrsActor | null;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: "open" | "closed" | "merged";
  readonly isDraft: boolean;
  readonly mergeability: "mergeable" | "conflicting" | "unknown";
  readonly additions: number;
  readonly deletions: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly viewerReviewRequested: boolean;
  readonly labels: readonly PrsLabel[];
  readonly reviewDecision?: "approved" | "changes-requested" | "review-required";
  readonly checksState?: "passing" | "failing" | "pending";
};
export type PrsProviderSummary = {
  readonly host: string;
  readonly kind: PrsProviderKind;
  readonly searchesOnHost: boolean;
  readonly projectCount: number;
  readonly configured: boolean;
  readonly detail: string | null;
};
export type PrsListProjectError = {
  readonly projectId: string;
  readonly projectTitle: string;
  readonly message: string;
};
export type PrsListResult = {
  readonly viewers: Readonly<Record<string, string>>;
  readonly providers: readonly PrsProviderSummary[];
  readonly entries: readonly PrsListEntry[];
  readonly errors: readonly PrsListProjectError[];
  readonly truncated: boolean;
  readonly nextCursors: Readonly<Record<string, string>>;
};
export type PrsListStatsInput = { readonly refs: readonly PrsRef[] };
export type PrsDiffStat = {
  readonly projectId: string;
  readonly repository: string;
  readonly number: number;
  readonly additions: number;
  readonly deletions: number;
};
export type PrsListStatsResult = { readonly stats: readonly PrsDiffStat[] };
export type PrsSummary = {
  readonly provider: PrsProviderKind;
  readonly projectId: string;
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: "open" | "closed" | "merged";
  readonly isDraft?: boolean;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
  readonly updatedAt: string;
  readonly author?: PrsActor | null;
  readonly additions?: number;
  readonly deletions?: number;
  readonly changedFiles?: number;
  readonly reviewDecision?: "approved" | "changes-requested" | "review-required" | null;
  readonly checksState?: "passing" | "failing" | "pending" | null;
  readonly mergeability?: "mergeable" | "conflicting" | "unknown";
};
export type PrsStack = {
  readonly id: string;
  readonly number: number;
  readonly url: string;
  readonly base: string;
  readonly layers: readonly {
    readonly number: number;
    readonly title?: string;
    readonly isDraft?: boolean;
    readonly headSha?: string;
    readonly headBranch: string;
    readonly state: "open" | "closed" | "merged";
  }[];
};
export type PrsLinkedThreadsResult = {
  readonly threads: readonly {
    readonly id: string;
    readonly projectId: string;
    readonly title: string;
    readonly archivedAt: string | null;
  }[];
  /** Rows were dropped to stay within the result bound. */
  readonly truncated: boolean;
};
export type PrsCapabilities = {
  readonly diff: boolean;
  readonly comment: boolean;
  readonly actions: readonly string[];
  readonly mergeMethods: readonly ("merge" | "squash" | "rebase")[];
  readonly updateMethods?: readonly ("merge" | "rebase")[];
  readonly search: boolean;
  readonly reactions?: boolean;
  readonly review: {
    readonly inlineComment: boolean;
    readonly reply: boolean;
    readonly resolve: boolean;
    readonly verdicts: readonly ("comment" | "approve" | "request-changes")[];
  };
  readonly reviewers: { readonly request: boolean; readonly listCandidates: boolean };
  readonly edit?: { readonly changeRequest: boolean; readonly comment: boolean };
  readonly stacks?: boolean;
  readonly stackActions?: boolean;
  readonly labels?: boolean;
};
export type PrsViewerPermissions = {
  readonly stackRebase?: boolean;
  readonly actions: readonly string[];
  readonly comment: boolean;
  readonly resolve: boolean;
  readonly verdicts: readonly ("comment" | "approve" | "request-changes")[];
  readonly requestReviewers: boolean;
  readonly updateMethods?: readonly ("merge" | "rebase")[];
  readonly labels?: boolean;
};
export type PrsDetail = {
  readonly provider: PrsProviderKind;
  readonly capabilities: PrsCapabilities;
  readonly viewerPermissions: PrsViewerPermissions;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly workspaceRoot: string;
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  /** True when the adapter cut `body` at the contract's character bound. */
  readonly bodyTruncated?: boolean;
  readonly url: string;
  readonly author: PrsActor | null;
  readonly state: "open" | "closed" | "merged";
  readonly isDraft: boolean;
  readonly mergeability: "mergeable" | "conflicting" | "unknown";
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly headBranch: string;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly baseBranch: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly reviewers: readonly PrsActor[];
  readonly labels: readonly PrsLabel[];
  readonly checks: readonly PrsCheck[];
  readonly mergeCapabilities: {
    readonly merge: boolean;
    readonly squash: boolean;
    readonly rebase: boolean;
  };
  readonly viewer?: string;
  readonly baseComparison?: "up-to-date" | "behind" | "unknown";
  readonly behindBy?: number;
  readonly autoMergeEnabled?: boolean;
  readonly autoMergeMethod?: "merge" | "squash" | "rebase";
  readonly workflowApprovalsRequired?: number;
};
export type PrsComment = {
  readonly id: string;
  readonly kind: "issue-comment" | "review-comment" | "review";
  readonly author: PrsActor | null;
  readonly body: string;
  readonly createdAt: string;
  readonly url: string | null;
  readonly path: string | null;
  readonly reviewState: string | null;
  readonly reactions?: readonly PrsReaction[];
};
export type PrsThreadComment = {
  readonly id: string;
  readonly author: PrsActor | null;
  readonly body: string;
  readonly createdAt: string;
  readonly url: string | null;
  readonly reactions?: readonly PrsReaction[];
};
export type PrsReviewThread = {
  readonly id: string;
  readonly path: string;
  readonly line: number | null;
  readonly side: "left" | "right";
  readonly isResolved: boolean;
  readonly isOutdated: boolean;
  readonly comments: readonly PrsThreadComment[];
  readonly commentCount?: number;
  readonly nextCommentsCursor?: string;
};
export type PrsCommit = {
  readonly oid: string;
  readonly messageHeadline: string;
  readonly committedDate: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly authors?: readonly PrsActor[];
};
export type PrsActivity = {
  readonly author?: PrsActor | null;
  readonly reviewers?: readonly PrsActor[];
  readonly comments: readonly PrsComment[];
  readonly commentCount: number;
  readonly commentsTruncated: boolean;
  readonly reviewThreads: readonly PrsReviewThread[];
  readonly commits: readonly PrsCommit[];
  readonly reactions?: readonly PrsReaction[];
  /**
   * The adapter cut something to fit the public bounds — a tail of
   * comments/reviewThreads/commits, or a body past the per-body character
   * bound. `commentsTruncated` is the native flag and is OR-ed in when
   * comments were cut.
   */
  readonly truncated: boolean;
};
export type PrsThreadCommentsInput = PrsRef & {
  readonly threadId: string;
  readonly cursor: string;
};
export type PrsThreadCommentsResult = {
  readonly comments: readonly PrsThreadComment[];
  /**
   * Host-issued resume point for the next page — null when comments were
   * dropped to fit the result bound, since that cursor describes the
   * position after rows the caller never received. A truncated page is an
   * explicitly lossy partial response: `threadComments` exposes no
   * page-size or query control, so dropped rows cannot be recovered
   * through this API — `truncated:true` + `nextCursor:null` is the honest
   * terminal state, not a retryable cursor.
   */
  readonly nextCursor: string | null;
  /** Comments were dropped (count or byte bound) or bodies were cut. */
  readonly truncated: boolean;
};
export type PrsReviewerCandidate = PrsActor & {
  readonly id: string;
  readonly kind: "user" | "team";
  readonly isRequested: boolean;
};
export type PrsReviewerCandidateList = {
  readonly candidates: readonly PrsReviewerCandidate[];
  readonly truncated: boolean;
};
export type PrsLabelCandidate = PrsLabel & {
  readonly description: string | null;
  readonly isApplied: boolean;
};
export type PrsLabelCandidateList = {
  readonly candidates: readonly PrsLabelCandidate[];
  readonly truncated: boolean;
};
export type PrsInvalidateInput = { readonly reference?: PrsRef };
export type PrsDiffInput = PrsRef & {
  /** One commit's own changes, rather than the whole change request. */
  readonly commit?: string;
  /** Resume point issued by a previous truncated stream, verbatim. */
  readonly cursor?: string;
};
export type PrsDiffFileContentsInput = PrsRef & {
  readonly commit?: string;
  readonly changeType: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
  readonly oldPath: string;
  readonly newPath: string;
};
export type PrsOmittedFileStat = {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
};
/**
 * `streamDiff` frames — the `t3.vcs/diff@1.1.0` family (manifest snapshot →
 * chunk data frames → complete) applied to one pull-request patch. The
 * adapter walks the host's own diff slices (`pullRequests.diff`) until the
 * diff is whole or the delivered-byte budget is hit; `nextCursor` is the
 * host-issued resume point for a follow-up stream. `diffHash` /
 * `payloadSha256` are sha256 over the delivered UTF-8 patch text, in chunk
 * order — the same verification the vcs diff streams run.
 */
export type PrsDiffStreamEvent =
  | {
      readonly kind: "manifest";
      readonly repository: string;
      readonly number: number;
      readonly host?: string;
      readonly commit?: string;
      readonly diffHash: string;
      readonly diffByteLength: number;
      readonly chunkCount: number;
      readonly truncated: boolean;
      readonly nextCursor: string | null;
      readonly omittedFileStats?: readonly PrsOmittedFileStat[];
    }
  | { readonly kind: "chunk"; readonly chunkIndex: number; readonly data: string }
  | { readonly kind: "complete"; readonly payloadSha256: string };
/**
 * `subscribeRefreshes` events — one per host-read invalidation cycle. The
 * stream closes with a named reason rather than going silent when the
 * consumer falls behind or the native stream fails.
 */
export type PrsRefreshedEvent =
  | { readonly kind: "refreshed"; readonly revision: number }
  | { readonly kind: "closed"; readonly reason: "overflow" | "refresh-error" };
/** Per-operation support flags keyed by `prs.<method>`/`prs.<stream>`. */
export type PrsOperationsSupport = {
  readonly "prs.list": boolean;
  readonly "prs.listStats": boolean;
  readonly "prs.summary": boolean;
  readonly "prs.detail": boolean;
  readonly "prs.activity": boolean;
  readonly "prs.threadComments": boolean;
  readonly "prs.linkedThreads": boolean;
  readonly "prs.stack": boolean;
  readonly "prs.reviewerCandidates": boolean;
  readonly "prs.labelCandidates": boolean;
  readonly "prs.invalidate": boolean;
  readonly "prs.streamDiff": boolean;
  readonly "prs.streamDiffFileContents": boolean;
  readonly "prs.subscribeRefreshes": boolean;
};
export type PrsCapabilitiesResult = {
  /**
   * The scoped project resolves to a PR host backed by a registered
   * provider. False on a local-only repository or an unimplemented host —
   * every host-bound operation then fails by name (provider-unsupported)
   * rather than answering an empty list.
   */
  readonly hosted: boolean;
  /**
   * The stable machine reason reads fail: `cli-missing`,
   * `cli-unauthenticated`, or `provider-unsupported`. Null when the probe
   * succeeded (per-host state lives on `providers[]`).
   */
  readonly reason: "cli-missing" | "cli-unauthenticated" | "provider-unsupported" | null;
  /**
   * Human-readable detail behind `reason` — e.g. which tool or credential
   * is missing. Null when the probe succeeded.
   */
  readonly detail: string | null;
  readonly providers: readonly PrsProviderSummary[];
  readonly operations: PrsOperationsSupport;
};

const prsActorSchema = {
  type: ["object", "null"],
  additionalProperties: false,
  required: ["login", "name", "avatarUrl"],
  properties: {
    login: { type: "string", minLength: 1, maxLength: 256 },
    name: { type: ["string", "null"], maxLength: 512 },
    avatarUrl: { type: ["string", "null"], maxLength: 4096 },
  },
} as const;
const prsLabelSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "color"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 512 },
    color: { type: ["string", "null"], maxLength: 64 },
  },
} as const;
const prsReactionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["content", "count", "actors", "viewerHasReacted"],
  properties: {
    content: {
      enum: ["thumbs-up", "thumbs-down", "laugh", "hooray", "confused", "heart", "rocket", "eyes"],
    },
    count: { type: "integer", minimum: 1 },
    actors: {
      type: "array",
      maxItems: 500,
      items: { type: "string", minLength: 1, maxLength: 256 },
    },
    viewerHasReacted: { type: "boolean" },
  },
} as const;
const prsCheckSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "status", "description", "url"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 512 },
    status: {
      enum: ["pending", "action-required", "success", "failure", "skipped", "neutral", "cancelled"],
    },
    description: { type: ["string", "null"], maxLength: 4096 },
    url: { type: ["string", "null"], maxLength: 4096 },
  },
} as const;
const prsRepositoryField = { type: "string", minLength: 1, maxLength: 512 } as const;
const prsHostField = { type: "string", minLength: 1, maxLength: 256 } as const;
const prsRefInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["repository", "number"],
  properties: {
    host: prsHostField,
    repository: prsRepositoryField,
    number: { type: "integer", minimum: 1 },
  },
} as const;
const prsListFiltersSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    draft: { enum: ["only", "hide"] },
    review: { enum: ["approved", "changes-requested", "review-required", "none"] },
    checks: { enum: ["passing", "failing"] },
    labels: {
      type: "array",
      maxItems: 10,
      items: {
        type: "array",
        maxItems: 10,
        items: { type: "string", minLength: 1, maxLength: 200 },
      },
    },
    excludedLabels: {
      type: "array",
      maxItems: 10,
      items: { type: "string", minLength: 1, maxLength: 200 },
    },
    author: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;
const prsCursorsSchema = {
  type: "object",
  additionalProperties: { type: "string", minLength: 1, maxLength: 4096 },
  maxProperties: 100,
} as const;
const prsProviderSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["host", "kind", "searchesOnHost", "projectCount", "configured", "detail"],
  properties: {
    host: prsHostField,
    kind: { enum: ["github", "gitlab", "azure-devops", "bitbucket", "forgejo", "unknown"] },
    searchesOnHost: { type: "boolean" },
    projectCount: { type: "integer", minimum: 1 },
    configured: { type: "boolean" },
    detail: { type: ["string", "null"], maxLength: 1024 },
  },
} as const;
const prsListEntrySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "provider",
    "host",
    "projectId",
    "projectTitle",
    "repository",
    "number",
    "title",
    "url",
    "author",
    "headBranch",
    "baseBranch",
    "state",
    "isDraft",
    "mergeability",
    "additions",
    "deletions",
    "createdAt",
    "updatedAt",
    "viewerReviewRequested",
    "labels",
  ],
  properties: {
    stack: {
      type: "object",
      additionalProperties: false,
      required: ["number", "position", "size", "base"],
      properties: {
        number: { type: "integer", minimum: 1 },
        position: { type: "integer", minimum: 1 },
        size: { type: "integer", minimum: 1 },
        base: { type: "string", minLength: 1, maxLength: 1024 },
      },
    },
    provider: { enum: ["github", "gitlab", "azure-devops", "bitbucket", "forgejo", "unknown"] },
    host: prsHostField,
    projectId: { type: "string", minLength: 1, maxLength: 160 },
    projectTitle: { type: "string", minLength: 1, maxLength: 512 },
    repository: prsRepositoryField,
    number: { type: "integer", minimum: 1 },
    title: { type: "string", minLength: 1, maxLength: 2048 },
    url: { type: "string", minLength: 1, maxLength: 4096 },
    author: prsActorSchema,
    headBranch: { type: "string", minLength: 1, maxLength: 1024 },
    baseBranch: { type: "string", minLength: 1, maxLength: 1024 },
    state: { enum: ["open", "closed", "merged"] },
    isDraft: { type: "boolean" },
    mergeability: { enum: ["mergeable", "conflicting", "unknown"] },
    additions: { type: "integer", minimum: 0 },
    deletions: { type: "integer", minimum: 0 },
    createdAt: { type: "string", maxLength: 64 },
    updatedAt: { type: "string", maxLength: 64 },
    viewerReviewRequested: { type: "boolean" },
    labels: { type: "array", maxItems: 100, items: prsLabelSchema },
    reviewDecision: { enum: ["approved", "changes-requested", "review-required"] },
    checksState: { enum: ["passing", "failing", "pending"] },
  },
} as const;
const prsListResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["viewers", "providers", "entries", "errors", "truncated", "nextCursors"],
  properties: {
    viewers: {
      type: "object",
      additionalProperties: { type: "string", minLength: 1, maxLength: 256 },
      maxProperties: 100,
    },
    providers: { type: "array", maxItems: 100, items: prsProviderSummarySchema },
    entries: { type: "array", maxItems: 100, items: prsListEntrySchema },
    errors: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["projectId", "projectTitle", "message"],
        properties: {
          projectId: { type: "string", minLength: 1, maxLength: 160 },
          projectTitle: { type: "string", minLength: 1, maxLength: 512 },
          message: { type: "string", minLength: 1, maxLength: 1024 },
        },
      },
    },
    truncated: { type: "boolean" },
    nextCursors: prsCursorsSchema,
  },
} as const;
const prsReviewVerdictsSchema = {
  type: "array",
  maxItems: 3,
  items: { enum: ["comment", "approve", "request-changes"] },
} as const;
const prsActionsSchema = {
  type: "array",
  maxItems: 16,
  items: {
    enum: [
      "merge",
      "ready",
      "draft",
      "close",
      "reopen",
      "update-branch",
      "enable-auto-merge",
      "disable-auto-merge",
      "revert",
      "approve-workflows",
    ],
  },
} as const;
const prsMergeMethodsSchema = {
  type: "array",
  maxItems: 3,
  items: { enum: ["merge", "squash", "rebase"] },
} as const;
const prsUpdateMethodsSchema = {
  type: "array",
  maxItems: 2,
  items: { enum: ["merge", "rebase"] },
} as const;
const prsCapabilitiesSchema = {
  type: "object",
  additionalProperties: false,
  required: ["diff", "comment", "actions", "mergeMethods", "search", "review", "reviewers"],
  properties: {
    diff: { type: "boolean" },
    comment: { type: "boolean" },
    actions: prsActionsSchema,
    mergeMethods: prsMergeMethodsSchema,
    updateMethods: prsUpdateMethodsSchema,
    search: { type: "boolean" },
    reactions: { type: "boolean" },
    review: {
      type: "object",
      additionalProperties: false,
      required: ["inlineComment", "reply", "resolve", "verdicts"],
      properties: {
        inlineComment: { type: "boolean" },
        reply: { type: "boolean" },
        resolve: { type: "boolean" },
        verdicts: prsReviewVerdictsSchema,
      },
    },
    reviewers: {
      type: "object",
      additionalProperties: false,
      required: ["request", "listCandidates"],
      properties: {
        request: { type: "boolean" },
        listCandidates: { type: "boolean" },
      },
    },
    edit: {
      type: "object",
      additionalProperties: false,
      required: ["changeRequest", "comment"],
      properties: {
        changeRequest: { type: "boolean" },
        comment: { type: "boolean" },
      },
    },
    stacks: { type: "boolean" },
    stackActions: { type: "boolean" },
    labels: { type: "boolean" },
  },
} as const;
const prsViewerPermissionsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actions", "comment", "resolve", "verdicts", "requestReviewers"],
  properties: {
    stackRebase: { type: "boolean" },
    actions: prsActionsSchema,
    comment: { type: "boolean" },
    resolve: { type: "boolean" },
    verdicts: prsReviewVerdictsSchema,
    requestReviewers: { type: "boolean" },
    updateMethods: prsUpdateMethodsSchema,
    labels: { type: "boolean" },
  },
} as const;
const prsDetailSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "provider",
    "capabilities",
    "viewerPermissions",
    "projectId",
    "projectTitle",
    "workspaceRoot",
    "repository",
    "number",
    "title",
    "body",
    "url",
    "author",
    "state",
    "isDraft",
    "mergeability",
    "additions",
    "deletions",
    "changedFiles",
    "headBranch",
    "baseBranch",
    "createdAt",
    "updatedAt",
    "mergedAt",
    "closedAt",
    "reviewers",
    "labels",
    "checks",
    "mergeCapabilities",
  ],
  properties: {
    provider: { enum: ["github", "gitlab", "azure-devops", "bitbucket", "forgejo", "unknown"] },
    capabilities: prsCapabilitiesSchema,
    viewerPermissions: prsViewerPermissionsSchema,
    projectId: { type: "string", minLength: 1, maxLength: 160 },
    projectTitle: { type: "string", minLength: 1, maxLength: 512 },
    workspaceRoot: { type: "string", minLength: 1, maxLength: 32768 },
    repository: prsRepositoryField,
    number: { type: "integer", minimum: 1 },
    title: { type: "string", minLength: 1, maxLength: 2048 },
    // Delivered bodies are cut at this bound; bodyTruncated says so.
    body: { type: "string", maxLength: 16384 },
    bodyTruncated: { type: "boolean" },
    url: { type: "string", minLength: 1, maxLength: 4096 },
    author: prsActorSchema,
    state: { enum: ["open", "closed", "merged"] },
    isDraft: { type: "boolean" },
    mergeability: { enum: ["mergeable", "conflicting", "unknown"] },
    additions: { type: "integer", minimum: 0 },
    deletions: { type: "integer", minimum: 0 },
    changedFiles: { type: "integer", minimum: 0 },
    headBranch: { type: "string", minLength: 1, maxLength: 1024 },
    headRepositoryNameWithOwner: { type: ["string", "null"], minLength: 1, maxLength: 1024 },
    baseBranch: { type: "string", minLength: 1, maxLength: 1024 },
    createdAt: { type: "string", maxLength: 64 },
    updatedAt: { type: "string", maxLength: 64 },
    mergedAt: { type: ["string", "null"], maxLength: 64 },
    closedAt: { type: ["string", "null"], maxLength: 64 },
    reviewers: { type: "array", maxItems: 100, items: prsActorSchema },
    labels: { type: "array", maxItems: 100, items: prsLabelSchema },
    checks: { type: "array", maxItems: 200, items: prsCheckSchema },
    mergeCapabilities: {
      type: "object",
      additionalProperties: false,
      required: ["merge", "squash", "rebase"],
      properties: {
        merge: { type: "boolean" },
        squash: { type: "boolean" },
        rebase: { type: "boolean" },
      },
    },
    viewer: { type: "string", minLength: 1, maxLength: 256 },
    baseComparison: { enum: ["up-to-date", "behind", "unknown"] },
    behindBy: { type: "integer", minimum: 0 },
    autoMergeEnabled: { type: "boolean" },
    autoMergeMethod: { enum: ["merge", "squash", "rebase"] },
    workflowApprovalsRequired: { type: "integer", minimum: 0 },
  },
} as const;
const prsCommentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "author", "body", "createdAt", "url", "path", "reviewState"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 512 },
    kind: { enum: ["issue-comment", "review-comment", "review"] },
    author: prsActorSchema,
    body: { type: "string", maxLength: 8192 },
    createdAt: { type: "string", maxLength: 64 },
    url: { type: ["string", "null"], maxLength: 4096 },
    path: { type: ["string", "null"], maxLength: 1024 },
    reviewState: { type: ["string", "null"], maxLength: 64 },
    reactions: { type: "array", maxItems: 8, items: prsReactionSchema },
  },
} as const;
const prsThreadCommentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "author", "body", "createdAt", "url"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 512 },
    author: prsActorSchema,
    body: { type: "string", maxLength: 8192 },
    createdAt: { type: "string", maxLength: 64 },
    url: { type: ["string", "null"], maxLength: 4096 },
    reactions: { type: "array", maxItems: 8, items: prsReactionSchema },
  },
} as const;
const prsReviewThreadSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "path", "line", "side", "isResolved", "isOutdated", "comments"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 512 },
    path: { type: "string", minLength: 1, maxLength: 1024 },
    line: { type: ["integer", "null"], minimum: 1 },
    side: { enum: ["left", "right"] },
    isResolved: { type: "boolean" },
    isOutdated: { type: "boolean" },
    comments: { type: "array", maxItems: 100, items: prsThreadCommentSchema },
    commentCount: { type: "integer", minimum: 0 },
    nextCommentsCursor: { type: "string", minLength: 1, maxLength: 4096 },
  },
} as const;
const prsActivitySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "comments",
    "commentCount",
    "commentsTruncated",
    "reviewThreads",
    "commits",
    "truncated",
  ],
  properties: {
    author: prsActorSchema,
    reviewers: { type: "array", maxItems: 100, items: prsActorSchema },
    comments: { type: "array", maxItems: 100, items: prsCommentSchema },
    commentCount: { type: "integer", minimum: 0 },
    commentsTruncated: { type: "boolean" },
    reviewThreads: { type: "array", maxItems: 100, items: prsReviewThreadSchema },
    commits: {
      type: "array",
      maxItems: 250,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["oid", "messageHeadline", "committedDate"],
        properties: {
          oid: { type: "string", minLength: 1, maxLength: 128 },
          messageHeadline: { type: "string", maxLength: 4096 },
          committedDate: { type: "string", maxLength: 64 },
          additions: { type: "integer", minimum: 0 },
          deletions: { type: "integer", minimum: 0 },
          authors: { type: "array", maxItems: 8, items: prsActorSchema },
        },
      },
    },
    reactions: { type: "array", maxItems: 8, items: prsReactionSchema },
    truncated: { type: "boolean" },
  },
} as const;
const prsSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "provider",
    "projectId",
    "repository",
    "number",
    "title",
    "url",
    "state",
    "headBranch",
    "baseBranch",
    "updatedAt",
  ],
  properties: {
    provider: { enum: ["github", "gitlab", "azure-devops", "bitbucket", "forgejo", "unknown"] },
    projectId: { type: "string", minLength: 1, maxLength: 160 },
    repository: prsRepositoryField,
    number: { type: "integer", minimum: 1 },
    title: { type: "string", minLength: 1, maxLength: 2048 },
    url: { type: "string", minLength: 1, maxLength: 4096 },
    state: { enum: ["open", "closed", "merged"] },
    isDraft: { type: "boolean" },
    headBranch: { type: "string", minLength: 1, maxLength: 1024 },
    baseBranch: { type: "string", minLength: 1, maxLength: 1024 },
    closedAt: { type: ["string", "null"], maxLength: 64 },
    mergedAt: { type: ["string", "null"], maxLength: 64 },
    updatedAt: { type: "string", maxLength: 64 },
    author: prsActorSchema,
    additions: { type: "integer", minimum: 0 },
    deletions: { type: "integer", minimum: 0 },
    changedFiles: { type: "integer", minimum: 0 },
    reviewDecision: { enum: ["approved", "changes-requested", "review-required", null] },
    checksState: { enum: ["passing", "failing", "pending", null] },
    mergeability: { enum: ["mergeable", "conflicting", "unknown"] },
  },
} as const;
const prsStackSchema = {
  type: ["object", "null"],
  additionalProperties: false,
  required: ["id", "number", "url", "base", "layers"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 512 },
    number: { type: "integer", minimum: 1 },
    url: { type: "string", minLength: 1, maxLength: 4096 },
    base: { type: "string", minLength: 1, maxLength: 1024 },
    layers: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["number", "headBranch", "state"],
        properties: {
          number: { type: "integer", minimum: 1 },
          title: { type: "string", maxLength: 2048 },
          isDraft: { type: "boolean" },
          headSha: { type: "string", minLength: 1, maxLength: 128 },
          headBranch: { type: "string", minLength: 1, maxLength: 1024 },
          state: { enum: ["open", "closed", "merged"] },
        },
      },
    },
  },
} as const;
const prsLinkedThreadsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["threads", "truncated"],
  properties: {
    threads: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "projectId", "title", "archivedAt"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 160 },
          projectId: { type: "string", minLength: 1, maxLength: 160 },
          title: { type: "string", maxLength: 2048 },
          archivedAt: { type: ["string", "null"], maxLength: 64 },
        },
      },
    },
    truncated: { type: "boolean" },
  },
} as const;
const prsThreadCommentsResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["comments", "nextCursor", "truncated"],
  properties: {
    comments: { type: "array", maxItems: 100, items: prsThreadCommentSchema },
    nextCursor: { type: ["string", "null"], minLength: 1, maxLength: 4096 },
    truncated: { type: "boolean" },
  },
} as const;
const prsReviewerCandidateListSchema = {
  type: "object",
  additionalProperties: false,
  required: ["candidates", "truncated"],
  properties: {
    candidates: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["login", "name", "avatarUrl", "id", "kind", "isRequested"],
        properties: {
          login: { type: "string", minLength: 1, maxLength: 256 },
          name: { type: ["string", "null"], maxLength: 512 },
          avatarUrl: { type: ["string", "null"], maxLength: 4096 },
          id: { type: "string", minLength: 1, maxLength: 512 },
          kind: { enum: ["user", "team"] },
          isRequested: { type: "boolean" },
        },
      },
    },
    truncated: { type: "boolean" },
  },
} as const;
const prsLabelCandidateListSchema = {
  type: "object",
  additionalProperties: false,
  required: ["candidates", "truncated"],
  properties: {
    candidates: {
      type: "array",
      maxItems: 500,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "color", "description", "isApplied"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 512 },
          color: { type: ["string", "null"], maxLength: 64 },
          description: { type: ["string", "null"], maxLength: 4096 },
          isApplied: { type: "boolean" },
        },
      },
    },
    truncated: { type: "boolean" },
  },
} as const;
const prsOperationsSupportSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "prs.list",
    "prs.listStats",
    "prs.summary",
    "prs.detail",
    "prs.activity",
    "prs.threadComments",
    "prs.linkedThreads",
    "prs.stack",
    "prs.reviewerCandidates",
    "prs.labelCandidates",
    "prs.invalidate",
    "prs.streamDiff",
    "prs.streamDiffFileContents",
    "prs.subscribeRefreshes",
  ],
  properties: {
    "prs.list": { type: "boolean" },
    "prs.listStats": { type: "boolean" },
    "prs.summary": { type: "boolean" },
    "prs.detail": { type: "boolean" },
    "prs.activity": { type: "boolean" },
    "prs.threadComments": { type: "boolean" },
    "prs.linkedThreads": { type: "boolean" },
    "prs.stack": { type: "boolean" },
    "prs.reviewerCandidates": { type: "boolean" },
    "prs.labelCandidates": { type: "boolean" },
    "prs.invalidate": { type: "boolean" },
    "prs.streamDiff": { type: "boolean" },
    "prs.streamDiffFileContents": { type: "boolean" },
    "prs.subscribeRefreshes": { type: "boolean" },
  },
} as const;
const prsCapabilitiesResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["hosted", "reason", "detail", "providers", "operations"],
  properties: {
    hosted: { type: "boolean" },
    reason: {
      enum: ["cli-missing", "cli-unauthenticated", "provider-unsupported", null],
    },
    detail: { type: ["string", "null"], maxLength: 1024 },
    providers: { type: "array", maxItems: 100, items: prsProviderSummarySchema },
    operations: prsOperationsSupportSchema,
  },
} as const;
const prsEmptyInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;
const prsEmptyOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;
const prsDiffStreamEventSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: [
        "kind",
        "repository",
        "number",
        "diffHash",
        "diffByteLength",
        "chunkCount",
        "truncated",
        "nextCursor",
      ],
      properties: {
        kind: { const: "manifest" },
        repository: prsRepositoryField,
        number: { type: "integer", minimum: 1 },
        host: prsHostField,
        commit: { type: "string", minLength: 1, maxLength: 128 },
        diffHash: vcsDiffSha256,
        diffByteLength: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        // The adapter's 4 Mi-unit delivered bound / 8 192-unit chunks = 512.
        chunkCount: { type: "integer", minimum: 0, maximum: 512 },
        truncated: { type: "boolean" },
        nextCursor: { type: ["string", "null"], minLength: 1, maxLength: 4096 },
        omittedFileStats: {
          type: "array",
          maxItems: 1000,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "additions", "deletions"],
            properties: {
              path: { type: "string", minLength: 1, maxLength: 1024 },
              additions: { type: "number" },
              deletions: { type: "number" },
            },
          },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "chunkIndex", "data"],
      properties: {
        kind: { const: "chunk" },
        chunkIndex: { type: "integer", minimum: 0, maximum: 511 },
        data: vcsDiffChunkData,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "payloadSha256"],
      properties: { kind: { const: "complete" }, payloadSha256: vcsDiffSha256 },
    },
  ],
} as const;
const prsRefreshedEventSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "revision"],
      properties: {
        kind: { const: "refreshed" },
        revision: { type: "integer", minimum: 0 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "reason"],
      properties: {
        kind: { const: "closed" },
        reason: { enum: ["overflow", "refresh-error"] },
      },
    },
  ],
} as const;
const prsDiffInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["repository", "number"],
  properties: {
    host: prsHostField,
    repository: prsRepositoryField,
    number: { type: "integer", minimum: 1 },
    commit: { type: "string", minLength: 1, maxLength: 128 },
    cursor: { type: "string", minLength: 1, maxLength: 4096 },
  },
} as const;
const prsDiffFileContentsInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["repository", "number", "changeType", "oldPath", "newPath"],
  properties: {
    host: prsHostField,
    repository: prsRepositoryField,
    number: { type: "integer", minimum: 1 },
    commit: { type: "string", minLength: 1, maxLength: 128 },
    changeType: { enum: ["change", "rename-pure", "rename-changed", "new", "deleted"] },
    oldPath: { type: "string", minLength: 1, maxLength: 1024 },
    newPath: { type: "string", minLength: 1, maxLength: 1024 },
  },
} as const;
/**
 * The pull-request read surface. `list`/`detail`/`activity`/`threadComments`/
 * `stack`/`summary`/`linkedThreads`/`listStats`/`reviewerCandidates`/
 * `labelCandidates`/`invalidate` mirror the same-named `pullRequests.*`
 * reads; `streamDiff`/`streamDiffFileContents` cover the native diff
 * (HTTP-routed natively) as `t3.vcs/diff@1.1.0`-family frames so payload
 * size never matters; `subscribeRefreshes` mirrors the native refresh
 * counter so a plugin re-reads exactly when the native client would.
 */
export const prsReadApi: TypedApi<{
  getCapabilities: { input: Record<string, never>; output: PrsCapabilitiesResult };
  list: { input: PrsListInput; output: PrsListResult };
  listStats: { input: PrsListStatsInput; output: PrsListStatsResult };
  summary: { input: PrsRef; output: PrsSummary };
  detail: { input: PrsRef; output: PrsDetail };
  activity: { input: PrsRef; output: PrsActivity };
  threadComments: { input: PrsThreadCommentsInput; output: PrsThreadCommentsResult };
  stack: { input: PrsRef; output: PrsStack | null };
  linkedThreads: { input: PrsRef; output: PrsLinkedThreadsResult };
  reviewerCandidates: { input: PrsRef; output: PrsReviewerCandidateList };
  labelCandidates: { input: PrsRef; output: PrsLabelCandidateList };
  invalidate: { input: PrsInvalidateInput; output: Record<string, never> };
}> &
  TypedStreamApi<{
    streamDiff: { input: PrsDiffInput; event: PrsDiffStreamEvent };
    streamDiffFileContents: {
      input: PrsDiffFileContentsInput;
      event: VcsDiffFileContentsStreamEvent;
    };
    subscribeRefreshes: { input: Record<string, never>; event: PrsRefreshedEvent };
  }> = defineStreamApi<{
  streamDiff: { input: PrsDiffInput; event: PrsDiffStreamEvent };
  streamDiffFileContents: {
    input: PrsDiffFileContentsInput;
    event: VcsDiffFileContentsStreamEvent;
  };
  subscribeRefreshes: { input: Record<string, never>; event: PrsRefreshedEvent };
}>({
  id: PRS_READ,
  version: "1.0.0",
  methods: [
    {
      name: "getCapabilities",
      effect: "read",
      requiredGrants: [PRS_READ],
      inputSchema: prsEmptyInputSchema,
      outputSchema: prsCapabilitiesResultSchema,
    },
    {
      name: "list",
      effect: "read",
      requiredGrants: [PRS_READ],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["state"],
        properties: {
          state: { enum: ["all", "open", "closed", "merged"] },
          involvement: { enum: ["all", "reviewing", "authored"] },
          filters: prsListFiltersSchema,
          host: prsHostField,
          limit: { type: "integer", minimum: 1, maximum: 50 },
          cursors: prsCursorsSchema,
          query: { type: "string", minLength: 1, maxLength: 200 },
        },
      },
      outputSchema: prsListResultSchema,
    },
    {
      name: "listStats",
      effect: "read",
      requiredGrants: [PRS_READ],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["refs"],
        properties: {
          refs: { type: "array", minItems: 1, maxItems: 100, items: prsRefInputSchema },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["stats"],
        properties: {
          stats: {
            type: "array",
            maxItems: 100,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["projectId", "repository", "number", "additions", "deletions"],
              properties: {
                projectId: { type: "string", minLength: 1, maxLength: 160 },
                repository: prsRepositoryField,
                number: { type: "integer", minimum: 1 },
                additions: { type: "integer", minimum: 0 },
                deletions: { type: "integer", minimum: 0 },
              },
            },
          },
        },
      },
    },
    {
      name: "summary",
      effect: "read",
      requiredGrants: [PRS_READ],
      inputSchema: prsRefInputSchema,
      outputSchema: prsSummarySchema,
    },
    {
      name: "detail",
      effect: "read",
      requiredGrants: [PRS_READ],
      inputSchema: prsRefInputSchema,
      outputSchema: prsDetailSchema,
    },
    {
      name: "activity",
      effect: "read",
      requiredGrants: [PRS_READ],
      inputSchema: prsRefInputSchema,
      outputSchema: prsActivitySchema,
    },
    {
      name: "threadComments",
      effect: "read",
      requiredGrants: [PRS_READ],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["repository", "number", "threadId", "cursor"],
        properties: {
          host: prsHostField,
          repository: prsRepositoryField,
          number: { type: "integer", minimum: 1 },
          threadId: { type: "string", minLength: 1, maxLength: 512 },
          cursor: { type: "string", minLength: 1, maxLength: 4096 },
        },
      },
      outputSchema: prsThreadCommentsResultSchema,
    },
    {
      name: "stack",
      effect: "read",
      requiredGrants: [PRS_READ],
      inputSchema: prsRefInputSchema,
      outputSchema: prsStackSchema,
    },
    {
      name: "linkedThreads",
      effect: "read",
      requiredGrants: [PRS_READ],
      inputSchema: prsRefInputSchema,
      outputSchema: prsLinkedThreadsSchema,
    },
    {
      name: "reviewerCandidates",
      effect: "read",
      requiredGrants: [PRS_READ],
      inputSchema: prsRefInputSchema,
      outputSchema: prsReviewerCandidateListSchema,
    },
    {
      name: "labelCandidates",
      effect: "read",
      requiredGrants: [PRS_READ],
      inputSchema: prsRefInputSchema,
      outputSchema: prsLabelCandidateListSchema,
    },
    {
      name: "invalidate",
      effect: "read",
      requiredGrants: [PRS_READ],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { reference: prsRefInputSchema },
      },
      outputSchema: prsEmptyOutputSchema,
    },
  ],
  streams: [
    {
      name: "streamDiff",
      requiredGrants: [PRS_READ],
      inputSchema: prsDiffInputSchema,
      eventSchema: prsDiffStreamEventSchema,
    },
    {
      name: "streamDiffFileContents",
      requiredGrants: [PRS_READ],
      inputSchema: prsDiffFileContentsInputSchema,
      eventSchema: vcsDiffFileContentsStreamEventSchema,
    },
    {
      name: "subscribeRefreshes",
      requiredGrants: [PRS_READ],
      inputSchema: prsEmptyInputSchema,
      eventSchema: prsRefreshedEventSchema,
    },
  ],
});
export const PRS_READ_API = prsReadApi.definition;

/* ------------------------------------------------------------------------
 * t3.vcs/actions — repository mutation actions (the native stacked-action
 * composite plus the Operate-scoped git seams the composite family owns).
 *
 * `run` starts the native `gitRunStackedAction` composite under a
 * server-minted action id and returns that id; progress travels on the
 * separate `actionProgress` stream (T2 transport — the broker's streams are
 * read-only, so a mutating stream is not an option). `cwd`, `threadId`, and
 * `actionId` are server-side: the scope resolver binds the workspace, the
 * scope's own thread receives the created-PR link, and the adapter mints
 * the id. `commitMessage` left blank keeps the native leave-blank
 * auto-generate dialog semantics — the composite generates the message.
 */

export const VCS_ACTIONS = "t3.vcs/actions";

export type VcsActionKind = "commit" | "push" | "create_pr" | "commit_push" | "commit_push_pr";
export type VcsActionPhase = "branch" | "commit" | "push" | "pr";
export type VcsActionRunInput = {
  readonly action: VcsActionKind;
  /** Blank or absent keeps native semantics — the composite generates the message. */
  readonly commitMessage?: string;
  readonly featureBranch?: boolean;
  readonly paths?: readonly string[];
};
export type VcsActionRunResult = { readonly actionId: string };

/**
 * P1 provenance — success-only UI metadata. `"caller"` means the text was
 * supplied to this operation (transport provenance, not human authorship);
 * `"generated"` the composite wrote it; `"existing"` an already-open change
 * request of unknown authorship; `"not_applicable"` the phase did not run.
 * Partial-failure provenance (a generated commit under a failed push)
 * carries no flag — the failure event names the phase instead.
 */
export type VcsActionMessageSource = "caller" | "generated" | "not_applicable";
export type VcsActionContentSource = "caller" | "generated" | "existing" | "not_applicable";

export type VcsActionResult = {
  readonly action: VcsActionKind;
  readonly branch: {
    readonly status: "created" | "skipped_not_requested";
    readonly name?: string;
  };
  readonly commit: {
    readonly status: "created" | "skipped_no_changes" | "skipped_not_requested";
    readonly commitSha?: string;
    readonly subject?: string;
    readonly messageSource: VcsActionMessageSource;
  };
  readonly push: {
    readonly status: "pushed" | "skipped_not_requested" | "skipped_up_to_date";
    readonly branch?: string;
    readonly upstreamBranch?: string;
    readonly setUpstream?: boolean;
  };
  readonly pr: {
    readonly status: "created" | "opened_existing" | "skipped_not_requested";
    readonly url?: string;
    readonly number?: number;
    readonly baseBranch?: string;
    readonly headBranch?: string;
    readonly title?: string;
    readonly contentSource: VcsActionContentSource;
  };
  readonly toast: {
    readonly title: string;
    readonly description?: string;
    readonly cta:
      | { readonly kind: "none" }
      | { readonly kind: "open_pr"; readonly label: string; readonly url: string }
      | {
          readonly kind: "run_action";
          readonly label: string;
          readonly action: { readonly kind: VcsActionKind };
        };
  };
};

/**
 * `actionProgress` events — the native `GitActionProgressEvent` union minus
 * `actionId`/`cwd` (server-side correlation), with the terminal result
 * carrying the SDK-side provenance annotations. `closed{overflow}` ends the
 * stream by name when a consumer falls behind or the retained history is
 * cut, never a silent gap. `action_finished` means the git phases finished;
 * the adapter's link+refresh tail (native ordering) may still be settling.
 * `closed{authorization-revoked}` may follow the phase terminal when the
 * detached post-service recheck finds authority or the dynamic PR grant
 * gone — git effects already persisted, so the denial is named by the
 * check that failed, never a generic `action_failed{phase}`. Consumers
 * must read the stream to settlement, not stop at `action_finished`.
 */
export type VcsActionProgressEvent =
  | {
      readonly kind: "action_started";
      readonly action: VcsActionKind;
      readonly phases: readonly VcsActionPhase[];
    }
  | {
      readonly kind: "phase_started";
      readonly action: VcsActionKind;
      readonly phase: VcsActionPhase;
      readonly label: string;
    }
  | { readonly kind: "hook_started"; readonly action: VcsActionKind; readonly hookName: string }
  | {
      readonly kind: "hook_output";
      readonly action: VcsActionKind;
      readonly hookName: string | null;
      readonly stream: "stdout" | "stderr";
      readonly text: string;
    }
  | {
      readonly kind: "hook_finished";
      readonly action: VcsActionKind;
      readonly hookName: string;
      readonly exitCode: number | null;
      readonly durationMs: number | null;
    }
  | {
      readonly kind: "action_finished";
      readonly action: VcsActionKind;
      readonly result: VcsActionResult;
    }
  | {
      readonly kind: "action_failed";
      readonly action: VcsActionKind;
      readonly phase: VcsActionPhase | null;
      readonly message: string;
    }
  | { readonly kind: "closed"; readonly reason: "overflow" | "authorization-revoked" };

export type VcsActionProgressInput = { readonly actionId: string };

export type VcsActionResolvedPullRequest = {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly state: "open" | "closed" | "merged";
};
export type VcsActionResolvePullRequestInput = { readonly reference: string };
export type VcsActionResolvePullRequestResult = {
  readonly pullRequest: VcsActionResolvedPullRequest;
};
export type VcsActionPrepareThreadInput = {
  readonly reference: string;
  readonly mode: "local" | "worktree";
};
export type VcsActionPrepareThreadResult = {
  readonly pullRequest: VcsActionResolvedPullRequest;
  readonly branch: string;
  readonly worktreePath: string | null;
  readonly isOnPullRequestHead: boolean;
};
export type VcsActionPublishInput = {
  readonly provider: PrsProviderKind;
  readonly repository: string;
  readonly visibility: "private" | "public";
  readonly remoteName?: string;
  readonly protocol?: "auto" | "ssh" | "https";
};
export type VcsActionPublishResult = {
  readonly repository: {
    readonly provider: PrsProviderKind;
    readonly nameWithOwner: string;
    readonly url: string;
    readonly sshUrl: string;
  };
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly branch: string;
  readonly upstreamBranch?: string;
  readonly status: "pushed" | "remote_added";
};
/** Per-operation support flags keyed by `actions.<method|stream>`. */
export type VcsActionsOperationsSupport = {
  readonly "actions.run": boolean;
  readonly "actions.resolvePullRequest": boolean;
  readonly "actions.preparePullRequestThread": boolean;
  readonly "actions.publishRepository": boolean;
  readonly "actions.actionProgress": boolean;
};
export type VcsActionsCapabilitiesResult = {
  readonly detected: boolean;
  readonly kind: VcsDriverKindValue | null;
  readonly detail: string | null;
  readonly driver: VcsDriverCapabilitiesInfo | null;
  readonly operations: VcsActionsOperationsSupport;
};

const vcsActionKindSchema = {
  enum: ["commit", "push", "create_pr", "commit_push", "commit_push_pr"],
} as const;
const vcsActionPhaseSchema = { enum: ["branch", "commit", "push", "pr"] } as const;
const vcsActionMessageSourceSchema = { enum: ["caller", "generated", "not_applicable"] } as const;
const vcsActionContentSourceSchema = {
  enum: ["caller", "generated", "existing", "not_applicable"],
} as const;
const vcsActionResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action", "branch", "commit", "push", "pr", "toast"],
  properties: {
    action: vcsActionKindSchema,
    branch: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {
        status: { enum: ["created", "skipped_not_requested"] },
        name: { type: "string", minLength: 1, maxLength: 4096 },
      },
    },
    commit: {
      type: "object",
      additionalProperties: false,
      required: ["status", "messageSource"],
      properties: {
        status: { enum: ["created", "skipped_no_changes", "skipped_not_requested"] },
        commitSha: { type: "string", minLength: 1, maxLength: 128 },
        subject: { type: "string", minLength: 1, maxLength: 4096 },
        messageSource: vcsActionMessageSourceSchema,
      },
    },
    push: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {
        status: { enum: ["pushed", "skipped_not_requested", "skipped_up_to_date"] },
        branch: { type: "string", minLength: 1, maxLength: 4096 },
        upstreamBranch: { type: "string", minLength: 1, maxLength: 4096 },
        setUpstream: { type: "boolean" },
      },
    },
    pr: {
      type: "object",
      additionalProperties: false,
      required: ["status", "contentSource"],
      properties: {
        status: { enum: ["created", "opened_existing", "skipped_not_requested"] },
        url: { type: "string", minLength: 1, maxLength: 4096 },
        number: { type: "integer", minimum: 1 },
        baseBranch: { type: "string", minLength: 1, maxLength: 4096 },
        headBranch: { type: "string", minLength: 1, maxLength: 4096 },
        title: { type: "string", minLength: 1, maxLength: 2048 },
        contentSource: vcsActionContentSourceSchema,
      },
    },
    toast: {
      type: "object",
      additionalProperties: false,
      required: ["title", "cta"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 512 },
        description: { type: "string", minLength: 1, maxLength: 1024 },
        cta: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["kind"],
              properties: { kind: { const: "none" } },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["kind", "label", "url"],
              properties: {
                kind: { const: "open_pr" },
                label: { type: "string", minLength: 1, maxLength: 256 },
                url: { type: "string", maxLength: 4096 },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["kind", "label", "action"],
              properties: {
                kind: { const: "run_action" },
                label: { type: "string", minLength: 1, maxLength: 256 },
                action: {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind"],
                  properties: { kind: vcsActionKindSchema },
                },
              },
            },
          ],
        },
      },
    },
  },
} as const;
const vcsActionEventBase = {
  action: vcsActionKindSchema,
} as const;
const vcsActionProgressEventSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "action", "phases"],
      properties: {
        kind: { const: "action_started" },
        ...vcsActionEventBase,
        phases: { type: "array", maxItems: 4, items: vcsActionPhaseSchema },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "action", "phase", "label"],
      properties: {
        kind: { const: "phase_started" },
        ...vcsActionEventBase,
        phase: vcsActionPhaseSchema,
        label: { type: "string", minLength: 1, maxLength: 1024 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "action", "hookName"],
      properties: {
        kind: { const: "hook_started" },
        ...vcsActionEventBase,
        hookName: { type: "string", minLength: 1, maxLength: 512 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "action", "hookName", "stream", "text"],
      properties: {
        kind: { const: "hook_output" },
        ...vcsActionEventBase,
        hookName: { type: ["string", "null"], minLength: 1, maxLength: 512 },
        stream: { enum: ["stdout", "stderr"] },
        // Native bounds hook lines at 500 chars; keep slack for future raises.
        text: { type: "string", minLength: 1, maxLength: 4096 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "action", "hookName", "exitCode", "durationMs"],
      properties: {
        kind: { const: "hook_finished" },
        ...vcsActionEventBase,
        hookName: { type: "string", minLength: 1, maxLength: 512 },
        exitCode: { type: ["integer", "null"] },
        durationMs: { type: ["integer", "null"], minimum: 0 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "action", "result"],
      properties: {
        kind: { const: "action_finished" },
        ...vcsActionEventBase,
        result: vcsActionResultSchema,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "action", "phase", "message"],
      properties: {
        kind: { const: "action_failed" },
        ...vcsActionEventBase,
        phase: { type: ["string", "null"], enum: ["branch", "commit", "push", "pr", null] },
        message: { type: "string", minLength: 1, maxLength: 4096 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "reason"],
      properties: {
        kind: { const: "closed" },
        reason: { enum: ["overflow", "authorization-revoked"] },
      },
    },
  ],
} as const;
const vcsActionResolvedPullRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["number", "title", "url", "baseBranch", "headBranch", "state"],
  properties: {
    number: { type: "integer", minimum: 1 },
    title: { type: "string", minLength: 1, maxLength: 2048 },
    url: { type: "string", maxLength: 4096 },
    baseBranch: { type: "string", minLength: 1, maxLength: 4096 },
    headBranch: { type: "string", minLength: 1, maxLength: 4096 },
    state: { enum: ["open", "closed", "merged"] },
  },
} as const;
const vcsActionReferenceInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reference"],
  properties: {
    reference: { type: "string", minLength: 1, maxLength: 2048 },
  },
} as const;
const vcsActionsOperationsSupportSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "actions.run",
    "actions.resolvePullRequest",
    "actions.preparePullRequestThread",
    "actions.publishRepository",
    "actions.actionProgress",
  ],
  properties: {
    "actions.run": { type: "boolean" },
    "actions.resolvePullRequest": { type: "boolean" },
    "actions.preparePullRequestThread": { type: "boolean" },
    "actions.publishRepository": { type: "boolean" },
    "actions.actionProgress": { type: "boolean" },
  },
} as const;
const vcsActionsCapabilitiesResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["detected", "kind", "detail", "driver", "operations"],
  properties: {
    detected: { type: "boolean" },
    kind: { type: ["string", "null"], enum: ["git", "jj", "unknown", null] },
    detail: { type: ["string", "null"], maxLength: 512 },
    driver: vcsDriverCapabilitiesSchema,
    operations: vcsActionsOperationsSupportSchema,
  },
} as const;

export const vcsActionsApi: TypedApi<{
  getCapabilities: { input: Record<string, never>; output: VcsActionsCapabilitiesResult };
  run: { input: VcsActionRunInput; output: VcsActionRunResult };
  resolvePullRequest: {
    input: VcsActionResolvePullRequestInput;
    output: VcsActionResolvePullRequestResult;
  };
  preparePullRequestThread: {
    input: VcsActionPrepareThreadInput;
    output: VcsActionPrepareThreadResult;
  };
  publishRepository: { input: VcsActionPublishInput; output: VcsActionPublishResult };
}> &
  TypedStreamApi<{
    actionProgress: { input: VcsActionProgressInput; event: VcsActionProgressEvent };
  }> = defineStreamApi<{
  actionProgress: { input: VcsActionProgressInput; event: VcsActionProgressEvent };
}>({
  id: VCS_ACTIONS,
  version: "1.0.0",
  methods: [
    {
      name: "getCapabilities",
      effect: "read",
      requiredGrants: [VCS_READ],
      inputSchema: prsEmptyInputSchema,
      outputSchema: vcsActionsCapabilitiesResultSchema,
    },
    {
      name: "run",
      effect: "write",
      requiredGrants: [VCS_MUTATE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: vcsActionKindSchema,
          commitMessage: { type: "string", maxLength: 10000 },
          featureBranch: { type: "boolean" },
          paths: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: { type: "string", minLength: 1, maxLength: 512 },
          },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["actionId"],
        properties: { actionId: { type: "string", minLength: 1, maxLength: 128 } },
      },
    },
    {
      name: "resolvePullRequest",
      // Read-shaped but Operate-gated: it shells the provider CLI, matching
      // the native RPC's Operate scope (design: `t3.vcs/mutate`).
      effect: "read",
      requiredGrants: [VCS_MUTATE],
      inputSchema: vcsActionReferenceInputSchema,
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["pullRequest"],
        properties: { pullRequest: vcsActionResolvedPullRequestSchema },
      },
    },
    {
      name: "preparePullRequestThread",
      effect: "write",
      requiredGrants: [VCS_MUTATE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["reference", "mode"],
        properties: {
          reference: { type: "string", minLength: 1, maxLength: 2048 },
          mode: { enum: ["local", "worktree"] },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["pullRequest", "branch", "worktreePath", "isOnPullRequestHead"],
        properties: {
          pullRequest: vcsActionResolvedPullRequestSchema,
          branch: { type: "string", minLength: 1, maxLength: 4096 },
          worktreePath: { type: ["string", "null"], minLength: 1, maxLength: 32768 },
          isOnPullRequestHead: { type: "boolean" },
        },
      },
    },
    {
      name: "publishRepository",
      // Declared `t3.vcs/mutate`; the adapter additionally requires every
      // caller in the chain to hold `t3.prs/write` (P-a conjunctive under
      // G3 — a comment-only grant must never reach pushCurrentBranch).
      effect: "write",
      requiredGrants: [VCS_MUTATE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["provider", "repository", "visibility"],
        properties: {
          provider: {
            enum: ["github", "gitlab", "azure-devops", "bitbucket", "forgejo", "unknown"],
          },
          repository: { type: "string", minLength: 1, maxLength: 512 },
          visibility: { enum: ["private", "public"] },
          remoteName: { type: "string", minLength: 1, maxLength: 256 },
          protocol: { enum: ["auto", "ssh", "https"] },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["repository", "remoteName", "remoteUrl", "branch", "status"],
        properties: {
          repository: {
            type: "object",
            additionalProperties: false,
            required: ["provider", "nameWithOwner", "url", "sshUrl"],
            properties: {
              provider: {
                enum: ["github", "gitlab", "azure-devops", "bitbucket", "forgejo", "unknown"],
              },
              nameWithOwner: { type: "string", minLength: 1, maxLength: 512 },
              url: { type: "string", minLength: 1, maxLength: 4096 },
              sshUrl: { type: "string", minLength: 1, maxLength: 4096 },
            },
          },
          remoteName: { type: "string", minLength: 1, maxLength: 256 },
          remoteUrl: { type: "string", minLength: 1, maxLength: 4096 },
          branch: { type: "string", minLength: 1, maxLength: 4096 },
          upstreamBranch: { type: "string", minLength: 1, maxLength: 4096 },
          status: { enum: ["pushed", "remote_added"] },
        },
      },
    },
  ],
  streams: [
    {
      name: "actionProgress",
      requiredGrants: [VCS_READ],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["actionId"],
        properties: { actionId: { type: "string", minLength: 1, maxLength: 128 } },
      },
      eventSchema: vcsActionProgressEventSchema,
    },
  ],
});
export const VCS_ACTIONS_API = vcsActionsApi.definition;

/* ------------------------------------------------------------------------
 * t3.prs/write — the pull-request write family. Ten host-write ops 1:1 on
 * the native `pullRequests.*` mutations under the same bound-ref rules as
 * t3.prs/read: `repository`/`host` are validated against the granted
 * project's own repository identity server-side and never forwarded, so a
 * reference cannot route to another project's credentials. Viewer-permission
 * and capability gating live in PullRequestService — a host that cannot do
 * a write fails by name rather than reporting support it does not have.
 */

export const PRS_WRITE = "t3.prs/write";

/** Per-write-operation support flags keyed by `prs.<method>`. */
export type PrsWriteOperationsSupport = {
  readonly "prs.runAction": boolean;
  readonly "prs.update": boolean;
  readonly "prs.comment": boolean;
  readonly "prs.updateComment": boolean;
  readonly "prs.submitReview": boolean;
  readonly "prs.replyToThread": boolean;
  readonly "prs.setThreadResolution": boolean;
  readonly "prs.setReaction": boolean;
  readonly "prs.requestReviewers": boolean;
  readonly "prs.setLabels": boolean;
};
export type PrsWriteActionKind =
  | "merge"
  | "ready"
  | "draft"
  | "close"
  | "reopen"
  | "update-branch"
  | "enable-auto-merge"
  | "disable-auto-merge"
  | "revert"
  | "approve-workflows";
export type PrsWriteMergeMethod = "merge" | "squash" | "rebase";
export type PrsWriteUpdateMethod = "merge" | "rebase";
export type PrsWriteVerdict = "comment" | "approve" | "request-changes";

export type PrsWriteCapabilitiesResult = {
  /** Same meaning as `PrsCapabilitiesResult.hosted` — a registered provider serves the bound repository. */
  readonly hosted: boolean;
  readonly reason: "cli-missing" | "cli-unauthenticated" | "provider-unsupported" | null;
  readonly detail: string | null;
  readonly operations: PrsWriteOperationsSupport;
  /**
   * The actions the bound provider declares it can carry out — a surface
   * offers only what this lists, which is the same `actions` list the
   * native panel reads before drawing a button.
   */
  readonly actions: readonly PrsWriteActionKind[];
  /** Merge strategies the provider offers before repository settings narrow them. */
  readonly mergeMethods: readonly PrsWriteMergeMethod[];
  /** How the host can bring a stale branch up to date; empty means `update-branch` is absent from `actions` anyway. */
  readonly updateMethods: readonly PrsWriteUpdateMethod[];
  /** Verdicts a submitted review can carry; empty means reviews cannot be submitted. */
  readonly verdicts: readonly PrsWriteVerdict[];
};

export type PrsWriteActionInput = PrsRef & {
  readonly action: PrsWriteActionKind;
  readonly mergeMethod?: PrsWriteMergeMethod;
  readonly updateMethod?: "merge" | "rebase";
  readonly stackNumber?: number;
  readonly expectedStackHeads?: readonly { readonly number: number; readonly headSha: string }[];
};
export type PrsWriteUpdateInput = PrsRef & {
  readonly title?: string;
  readonly body?: string;
};
export type PrsWriteCommentInput = PrsRef & { readonly body: string };
export type PrsWriteUpdateCommentInput = PrsRef & {
  readonly commentId: string;
  readonly kind: "issue-comment" | "review-comment";
  readonly body: string;
};
export type PrsWriteReviewCommentDraft = {
  readonly path: string;
  readonly oldPath?: string;
  readonly position:
    | { readonly kind: "added"; readonly newLine: number }
    | { readonly kind: "deleted"; readonly oldLine: number }
    | {
        readonly kind: "context";
        readonly oldLine: number;
        readonly newLine: number;
        readonly side: "left" | "right";
      };
  readonly body: string;
};
export type PrsWriteSubmitReviewInput = PrsRef & {
  readonly verdict: PrsWriteVerdict;
  readonly body: string;
  readonly comments: readonly PrsWriteReviewCommentDraft[];
};
export type PrsWriteReplyInput = PrsRef & {
  readonly threadId: string;
  readonly body: string;
};
export type PrsWriteThreadResolutionInput = PrsRef & {
  readonly threadId: string;
  readonly resolved: boolean;
};
export type PrsWriteReactionInput = PrsRef & {
  readonly subjectId?: string;
  readonly content:
    | "thumbs-up"
    | "thumbs-down"
    | "laugh"
    | "hooray"
    | "confused"
    | "heart"
    | "rocket"
    | "eyes";
  readonly reacted: boolean;
};
export type PrsWriteReviewerRequestInput = PrsRef & {
  readonly reviewers: readonly { readonly id: string; readonly kind: "user" | "team" }[];
  readonly requested: boolean;
};
export type PrsWriteLabelsInput = PrsRef & {
  readonly labels: readonly string[];
  readonly applied: boolean;
};
export type PrsWriteEmptyResult = Record<string, never>;

const prsWriteBodySchema = { type: "string", minLength: 1, maxLength: 65536 } as const;
const prsWriteOperationsSupportSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "prs.runAction",
    "prs.update",
    "prs.comment",
    "prs.updateComment",
    "prs.submitReview",
    "prs.replyToThread",
    "prs.setThreadResolution",
    "prs.setReaction",
    "prs.requestReviewers",
    "prs.setLabels",
  ],
  properties: {
    "prs.runAction": { type: "boolean" },
    "prs.update": { type: "boolean" },
    "prs.comment": { type: "boolean" },
    "prs.updateComment": { type: "boolean" },
    "prs.submitReview": { type: "boolean" },
    "prs.replyToThread": { type: "boolean" },
    "prs.setThreadResolution": { type: "boolean" },
    "prs.setReaction": { type: "boolean" },
    "prs.requestReviewers": { type: "boolean" },
    "prs.setLabels": { type: "boolean" },
  },
} as const;
const prsWriteActionKindSchema = {
  enum: [
    "merge",
    "ready",
    "draft",
    "close",
    "reopen",
    "update-branch",
    "enable-auto-merge",
    "disable-auto-merge",
    "revert",
    "approve-workflows",
  ],
} as const;
const prsWriteMergeMethodSchema = { enum: ["merge", "squash", "rebase"] } as const;
const prsWriteVerdictSchema = { enum: ["comment", "approve", "request-changes"] } as const;
const prsWriteCapabilitiesResultSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "hosted",
    "reason",
    "detail",
    "operations",
    "actions",
    "mergeMethods",
    "updateMethods",
    "verdicts",
  ],
  properties: {
    hosted: { type: "boolean" },
    reason: {
      enum: ["cli-missing", "cli-unauthenticated", "provider-unsupported", null],
    },
    detail: { type: ["string", "null"], maxLength: 1024 },
    operations: prsWriteOperationsSupportSchema,
    actions: { type: "array", maxItems: 16, items: prsWriteActionKindSchema },
    mergeMethods: { type: "array", maxItems: 8, items: prsWriteMergeMethodSchema },
    updateMethods: {
      type: "array",
      maxItems: 4,
      items: { enum: ["merge", "rebase"] },
    },
    verdicts: { type: "array", maxItems: 8, items: prsWriteVerdictSchema },
  },
} as const;
const prsWriteActionInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["repository", "number", "action"],
  properties: {
    host: prsHostField,
    repository: prsRepositoryField,
    number: { type: "integer", minimum: 1 },
    action: prsWriteActionKindSchema,
    mergeMethod: prsWriteMergeMethodSchema,
    updateMethod: { enum: ["merge", "rebase"] },
    stackNumber: { type: "integer", minimum: 1 },
    expectedStackHeads: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["number", "headSha"],
        properties: {
          number: { type: "integer", minimum: 1 },
          headSha: { type: "string", minLength: 1, maxLength: 128 },
        },
      },
    },
  },
} as const;
const prsWriteReviewCommentDraftSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "position", "body"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: 1024 },
    oldPath: { type: "string", minLength: 1, maxLength: 1024 },
    position: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "newLine"],
          properties: {
            kind: { const: "added" },
            newLine: { type: "integer", minimum: 1 },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "oldLine"],
          properties: {
            kind: { const: "deleted" },
            oldLine: { type: "integer", minimum: 1 },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "oldLine", "newLine", "side"],
          properties: {
            kind: { const: "context" },
            oldLine: { type: "integer", minimum: 1 },
            newLine: { type: "integer", minimum: 1 },
            side: { enum: ["left", "right"] },
          },
        },
      ],
    },
    body: prsWriteBodySchema,
  },
} as const;

export const prsWriteApi = defineApi<{
  getCapabilities: { input: Record<string, never>; output: PrsWriteCapabilitiesResult };
  runAction: { input: PrsWriteActionInput; output: PrsWriteEmptyResult };
  update: { input: PrsWriteUpdateInput; output: PrsWriteEmptyResult };
  comment: { input: PrsWriteCommentInput; output: PrsWriteEmptyResult };
  updateComment: { input: PrsWriteUpdateCommentInput; output: PrsWriteEmptyResult };
  submitReview: { input: PrsWriteSubmitReviewInput; output: PrsWriteEmptyResult };
  replyToThread: { input: PrsWriteReplyInput; output: PrsWriteEmptyResult };
  setThreadResolution: { input: PrsWriteThreadResolutionInput; output: PrsWriteEmptyResult };
  setReaction: { input: PrsWriteReactionInput; output: PrsWriteEmptyResult };
  requestReviewers: { input: PrsWriteReviewerRequestInput; output: PrsWriteEmptyResult };
  setLabels: { input: PrsWriteLabelsInput; output: PrsWriteEmptyResult };
}>({
  id: PRS_WRITE,
  version: "1.0.0",
  methods: [
    {
      name: "getCapabilities",
      effect: "read",
      requiredGrants: [PRS_WRITE],
      inputSchema: prsEmptyInputSchema,
      outputSchema: prsWriteCapabilitiesResultSchema,
    },
    {
      name: "runAction",
      effect: "write",
      requiredGrants: [PRS_WRITE],
      inputSchema: prsWriteActionInputSchema,
      outputSchema: prsEmptyOutputSchema,
    },
    {
      name: "update",
      effect: "write",
      requiredGrants: [PRS_WRITE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["repository", "number"],
        properties: {
          host: prsHostField,
          repository: prsRepositoryField,
          number: { type: "integer", minimum: 1 },
          title: { type: "string", minLength: 1, maxLength: 1024 },
          body: { type: "string", maxLength: 65536 },
        },
      },
      outputSchema: prsEmptyOutputSchema,
    },
    {
      name: "comment",
      effect: "write",
      requiredGrants: [PRS_WRITE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["repository", "number", "body"],
        properties: {
          host: prsHostField,
          repository: prsRepositoryField,
          number: { type: "integer", minimum: 1 },
          body: prsWriteBodySchema,
        },
      },
      outputSchema: prsEmptyOutputSchema,
    },
    {
      name: "updateComment",
      effect: "write",
      requiredGrants: [PRS_WRITE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["repository", "number", "commentId", "kind", "body"],
        properties: {
          host: prsHostField,
          repository: prsRepositoryField,
          number: { type: "integer", minimum: 1 },
          commentId: { type: "string", minLength: 1, maxLength: 512 },
          kind: { enum: ["issue-comment", "review-comment"] },
          body: prsWriteBodySchema,
        },
      },
      outputSchema: prsEmptyOutputSchema,
    },
    {
      name: "submitReview",
      effect: "write",
      requiredGrants: [PRS_WRITE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["repository", "number", "verdict", "body", "comments"],
        properties: {
          host: prsHostField,
          repository: prsRepositoryField,
          number: { type: "integer", minimum: 1 },
          verdict: { enum: ["comment", "approve", "request-changes"] },
          body: { type: "string", maxLength: 65536 },
          comments: { type: "array", maxItems: 100, items: prsWriteReviewCommentDraftSchema },
        },
      },
      outputSchema: prsEmptyOutputSchema,
    },
    {
      name: "replyToThread",
      effect: "write",
      requiredGrants: [PRS_WRITE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["repository", "number", "threadId", "body"],
        properties: {
          host: prsHostField,
          repository: prsRepositoryField,
          number: { type: "integer", minimum: 1 },
          threadId: { type: "string", minLength: 1, maxLength: 512 },
          body: prsWriteBodySchema,
        },
      },
      outputSchema: prsEmptyOutputSchema,
    },
    {
      name: "setThreadResolution",
      effect: "write",
      requiredGrants: [PRS_WRITE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["repository", "number", "threadId", "resolved"],
        properties: {
          host: prsHostField,
          repository: prsRepositoryField,
          number: { type: "integer", minimum: 1 },
          threadId: { type: "string", minLength: 1, maxLength: 512 },
          resolved: { type: "boolean" },
        },
      },
      outputSchema: prsEmptyOutputSchema,
    },
    {
      name: "setReaction",
      effect: "write",
      requiredGrants: [PRS_WRITE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["repository", "number", "content", "reacted"],
        properties: {
          host: prsHostField,
          repository: prsRepositoryField,
          number: { type: "integer", minimum: 1 },
          subjectId: { type: "string", minLength: 1, maxLength: 512 },
          content: {
            enum: [
              "thumbs-up",
              "thumbs-down",
              "laugh",
              "hooray",
              "confused",
              "heart",
              "rocket",
              "eyes",
            ],
          },
          reacted: { type: "boolean" },
        },
      },
      outputSchema: prsEmptyOutputSchema,
    },
    {
      name: "requestReviewers",
      effect: "write",
      requiredGrants: [PRS_WRITE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["repository", "number", "reviewers", "requested"],
        properties: {
          host: prsHostField,
          repository: prsRepositoryField,
          number: { type: "integer", minimum: 1 },
          reviewers: {
            type: "array",
            minItems: 1,
            maxItems: 25,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "kind"],
              properties: {
                id: { type: "string", minLength: 1, maxLength: 512 },
                kind: { enum: ["user", "team"] },
              },
            },
          },
          requested: { type: "boolean" },
        },
      },
      outputSchema: prsEmptyOutputSchema,
    },
    {
      name: "setLabels",
      effect: "write",
      requiredGrants: [PRS_WRITE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["repository", "number", "labels", "applied"],
        properties: {
          host: prsHostField,
          repository: prsRepositoryField,
          number: { type: "integer", minimum: 1 },
          labels: {
            type: "array",
            minItems: 1,
            maxItems: 25,
            items: { type: "string", minLength: 1, maxLength: 512 },
          },
          applied: { type: "boolean" },
        },
      },
      outputSchema: prsEmptyOutputSchema,
    },
  ],
});
export const PRS_WRITE_API = prsWriteApi.definition;

/* ------------------------------------------------------------------------
 * t3.browser/sessions — per-thread browser session metadata.
 *
 * Metadata only: the API projects the server's preview-manager state and
 * dispatches the native commands that exist today (open/navigate/close/
 * resize). The remaining command verbs stay in the contract but return a
 * named BrowserSessionCommandUnsupported error — a receipt must mean
 * accepted-for-work, and no server-side dispatch exists for them until
 * authenticated host command routing lands. getCapabilities therefore
 * advertises only `resize`. The API deliberately exposes no reportStatus/
 * registerWebview/createTab/automation path — engine status may only
 * enter through the authenticated engine-host registration, and
 * presentation lives behind the separate `t3.browser/surface` lease.
 *
 * Grants: `t3.browser/sessions` is the read grant (shared with the
 * `browser-surface` lease mint above). Every write additionally requires
 * `t3.browser/operate`; reads never confer interaction. Receipts are
 * acceptance records — `outcome:"accepted"` means the command was validated
 * and dispatched, never that a page loaded.
 *
 * Navigation honesty: the native navigate write marks Success before any
 * engine report, so `navigation.kind` tracks which side wrote last —
 * "pending" while only a dispatch is recorded, then the engine-reported
 * state once the authenticated report path writes. Engine state is
 * projected from authenticated host state only; this slice has none, so it
 * is always `unavailable`/`desktop-required`, never fabricated.
 * --------------------------------------------------------------------- */
export const BROWSER_OPERATE = "t3.browser/operate";

export const BROWSER_SESSION_COMMANDS = [
  "back",
  "forward",
  "reload",
  "hardReload",
  "resize",
  "zoom",
  "setAppearance",
  "setAudioMuted",
] as const;
export type BrowserSessionCommand = (typeof BROWSER_SESSION_COMMANDS)[number];

export const BROWSER_SESSION_URL_MAX_LENGTH = 2048;
export const BROWSER_SESSION_TITLE_MAX_LENGTH = 512;
export const BROWSER_SESSION_LIMIT = 64;

export type BrowserSessionViewport =
  | { readonly _tag: "fill" }
  | { readonly _tag: "freeform"; readonly width: number; readonly height: number }
  | {
      readonly _tag: "preset";
      readonly width: number;
      readonly height: number;
      readonly presetId: string;
    };

export type BrowserSessionFailureCode =
  | "aborted"
  | "dns"
  | "offline"
  | "timeout"
  | "refused"
  | "reset"
  | "certificate"
  | "blocked"
  | "redirect"
  | "invalid-url"
  | "crash"
  | "unknown";

export type BrowserSessionNavigation = {
  readonly kind: "idle" | "pending" | "loading" | "loaded" | "failed";
  readonly url: string | null;
  readonly title: string;
  readonly failureCode?: BrowserSessionFailureCode;
};

export type BrowserSessionEngine = {
  readonly state: "unavailable" | "starting" | "ready" | "recovering" | "crashed";
  readonly generation: string | null;
  readonly reason?: string;
};

export type BrowserSession = {
  readonly tabId: string;
  readonly requestedUrl: string | null;
  readonly navigation: BrowserSessionNavigation;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly viewport: BrowserSessionViewport;
  readonly profileId?: string;
  readonly engine: BrowserSessionEngine;
  readonly zoomFactor: number | null;
  readonly appearance: "system" | "light" | "dark" | null;
  readonly audioMuted: boolean | null;
  readonly audible: boolean | null;
};

export type BrowserSessionsSnapshot = {
  readonly serverEpoch: string;
  readonly revision: number;
  readonly sessions: readonly BrowserSession[];
};

export type BrowserSessionCapabilities = {
  readonly metadata: { readonly supported: true };
  readonly presentation: {
    readonly supported: boolean;
    readonly reason?: "desktop-required";
  };
  readonly commands: readonly BrowserSessionCommand[];
};

export type BrowserSessionReceipt = {
  readonly commandId: string;
  /** "accepted" records dispatch, never load completion or engine execution. */
  readonly outcome: "accepted" | "rejected" | "unknown";
  readonly serverEpoch: string;
  readonly revision: number;
  readonly session: BrowserSession;
};

export type BrowserSessionCloseResult = {
  readonly outcome: "closed" | "already-closed";
  readonly serverEpoch: string;
  readonly revision: number;
};

export type BrowserSessionOpenInput = {
  readonly url?: string;
  readonly viewport?: BrowserSessionViewport;
  readonly profileId?: string;
};
export type BrowserSessionNavigateInput = {
  readonly tabId: string;
  readonly serverEpoch: string;
  readonly url: string;
  readonly expectedEngineGeneration: string | null;
};
export type BrowserSessionCloseInput = {
  readonly tabId: string;
  readonly serverEpoch: string;
};
export type BrowserSessionCommandInput = {
  readonly tabId: string;
  readonly serverEpoch: string;
  readonly expectedEngineGeneration: string | null;
};
export type BrowserSessionResizeInput = BrowserSessionCommandInput & {
  readonly viewport: BrowserSessionViewport;
};
export type BrowserSessionZoomInput = BrowserSessionCommandInput & {
  readonly zoomFactor: number;
};
export type BrowserSessionAppearanceInput = BrowserSessionCommandInput & {
  readonly appearance: "system" | "light" | "dark";
};
export type BrowserSessionAudioMutedInput = BrowserSessionCommandInput & {
  readonly muted: boolean;
};

export type BrowserSessionStreamCloseReason =
  | "epoch-changed"
  | "host-disconnected"
  | "scope-invalidated"
  | "grant-revoked"
  | "installation-changed"
  | "overflow"
  | "source-unavailable";

export type BrowserSessionStreamValue =
  | {
      readonly kind: "snapshot-start";
      readonly snapshotId: string;
      readonly serverEpoch: string;
      readonly revision: number;
      readonly sessionCount: number;
    }
  | {
      readonly kind: "snapshot-chunk";
      readonly snapshotId: string;
      readonly chunkIndex: number;
      readonly sessions: readonly BrowserSession[];
    }
  | {
      readonly kind: "snapshot-complete";
      readonly snapshotId: string;
      readonly serverEpoch: string;
      readonly revision: number;
      readonly sessionCount: number;
    }
  | {
      readonly kind: "session-upsert";
      readonly revision: number;
      readonly session: BrowserSession;
    }
  | {
      readonly kind: "session-removed";
      readonly revision: number;
      readonly tabId: string;
      readonly reason: "user-closed" | "thread-deleted";
    }
  | { readonly kind: "closed"; readonly reason: BrowserSessionStreamCloseReason };

const browserSessionTabId = {
  type: "string",
  minLength: 1,
  maxLength: 128,
} as const;
const browserSessionEpoch = {
  type: "string",
  minLength: 1,
  maxLength: 128,
} as const;
const browserSessionRevision = { type: "integer", minimum: 0 } as const;
const browserSessionUrl = {
  type: "string",
  minLength: 1,
  maxLength: BROWSER_SESSION_URL_MAX_LENGTH,
} as const;
const browserSessionViewport = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["_tag"],
      properties: { _tag: { const: "fill" } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["_tag", "width", "height"],
      properties: {
        _tag: { const: "freeform" },
        width: { type: "integer", minimum: 240, maximum: 3840 },
        height: { type: "integer", minimum: 240, maximum: 3840 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["_tag", "width", "height", "presetId"],
      properties: {
        _tag: { const: "preset" },
        width: { type: "integer", minimum: 240, maximum: 3840 },
        height: { type: "integer", minimum: 240, maximum: 3840 },
        presetId: { type: "string", minLength: 1, maxLength: 64 },
      },
    },
  ],
} as const;
const browserSessionObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "tabId",
    "requestedUrl",
    "navigation",
    "canGoBack",
    "canGoForward",
    "viewport",
    "engine",
    "zoomFactor",
    "appearance",
    "audioMuted",
    "audible",
  ],
  properties: {
    tabId: browserSessionTabId,
    requestedUrl: {
      type: ["string", "null"],
      minLength: 1,
      maxLength: BROWSER_SESSION_URL_MAX_LENGTH,
    },
    navigation: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "url", "title"],
      properties: {
        kind: { enum: ["idle", "pending", "loading", "loaded", "failed"] },
        url: {
          type: ["string", "null"],
          minLength: 1,
          maxLength: BROWSER_SESSION_URL_MAX_LENGTH,
        },
        title: { type: "string", maxLength: BROWSER_SESSION_TITLE_MAX_LENGTH },
        failureCode: {
          enum: [
            "aborted",
            "dns",
            "offline",
            "timeout",
            "refused",
            "reset",
            "certificate",
            "blocked",
            "redirect",
            "invalid-url",
            "crash",
            "unknown",
          ],
        },
      },
    },
    canGoBack: { type: "boolean" },
    canGoForward: { type: "boolean" },
    viewport: browserSessionViewport,
    profileId: { type: "string", minLength: 1, maxLength: 64 },
    engine: {
      type: "object",
      additionalProperties: false,
      required: ["state", "generation"],
      properties: {
        state: { enum: ["unavailable", "starting", "ready", "recovering", "crashed"] },
        generation: { type: ["string", "null"], minLength: 1, maxLength: 128 },
        reason: { type: "string", minLength: 1, maxLength: 256 },
      },
    },
    zoomFactor: { type: ["number", "null"] },
    appearance: { enum: ["system", "light", "dark", null] },
    audioMuted: { type: ["boolean", "null"] },
    audible: { type: ["boolean", "null"] },
  },
} as const;
const browserSessionReceipt = {
  type: "object",
  additionalProperties: false,
  required: ["commandId", "outcome", "serverEpoch", "revision", "session"],
  properties: {
    commandId: { type: "string", minLength: 1, maxLength: 64 },
    outcome: { enum: ["accepted", "rejected", "unknown"] },
    serverEpoch: browserSessionEpoch,
    revision: browserSessionRevision,
    session: browserSessionObject,
  },
} as const;
const browserSessionCommandGuard = {
  tabId: browserSessionTabId,
  serverEpoch: browserSessionEpoch,
  expectedEngineGeneration: { type: ["string", "null"], minLength: 1, maxLength: 128 },
} as const;
const browserSessionGuardRequired = ["tabId", "serverEpoch", "expectedEngineGeneration"];
const browserSessionCommandMethod = (
  name: BrowserSessionCommand,
  extraProperties: Record<string, JsonObject> = {},
  extraRequired: readonly string[] = [],
) => ({
  name,
  effect: "write" as const,
  requiredGrants: [BROWSER_SESSIONS, BROWSER_OPERATE],
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: [...browserSessionGuardRequired, ...extraRequired],
    properties: { ...browserSessionCommandGuard, ...extraProperties },
  },
  outputSchema: browserSessionReceipt,
});
export const BROWSER_SESSION_ZOOM_LEVELS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0,
] as const;
const browserSessionEmptyInput = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

export const browserSessionsApi: TypedApi<{
  getCapabilities: {
    input: Record<string, never>;
    output: BrowserSessionCapabilities;
  };
  list: { input: Record<string, never>; output: BrowserSessionsSnapshot };
  open: { input: BrowserSessionOpenInput; output: BrowserSessionReceipt };
  navigate: { input: BrowserSessionNavigateInput; output: BrowserSessionReceipt };
  close: { input: BrowserSessionCloseInput; output: BrowserSessionCloseResult };
  back: { input: BrowserSessionCommandInput; output: BrowserSessionReceipt };
  forward: { input: BrowserSessionCommandInput; output: BrowserSessionReceipt };
  reload: { input: BrowserSessionCommandInput; output: BrowserSessionReceipt };
  hardReload: { input: BrowserSessionCommandInput; output: BrowserSessionReceipt };
  resize: { input: BrowserSessionResizeInput; output: BrowserSessionReceipt };
  zoom: { input: BrowserSessionZoomInput; output: BrowserSessionReceipt };
  setAppearance: { input: BrowserSessionAppearanceInput; output: BrowserSessionReceipt };
  setAudioMuted: { input: BrowserSessionAudioMutedInput; output: BrowserSessionReceipt };
}> &
  TypedStreamApi<{
    events: { input: Record<string, never>; event: BrowserSessionStreamValue };
  }> = defineStreamApi<{
  events: { input: Record<string, never>; event: BrowserSessionStreamValue };
}>({
  id: BROWSER_SESSIONS,
  version: "1.0.0",
  methods: [
    {
      name: "getCapabilities",
      effect: "read",
      requiredGrants: [BROWSER_SESSIONS],
      inputSchema: browserSessionEmptyInput,
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["metadata", "presentation", "commands"],
        properties: {
          metadata: {
            type: "object",
            additionalProperties: false,
            required: ["supported"],
            properties: { supported: { const: true } },
          },
          presentation: {
            type: "object",
            additionalProperties: false,
            required: ["supported"],
            properties: {
              supported: { type: "boolean" },
              reason: { enum: ["desktop-required"] },
            },
          },
          commands: {
            type: "array",
            maxItems: BROWSER_SESSION_COMMANDS.length,
            uniqueItems: true,
            items: { enum: [...BROWSER_SESSION_COMMANDS] },
          },
        },
      },
    },
    {
      name: "list",
      effect: "read",
      requiredGrants: [BROWSER_SESSIONS],
      inputSchema: browserSessionEmptyInput,
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["serverEpoch", "revision", "sessions"],
        properties: {
          serverEpoch: browserSessionEpoch,
          revision: browserSessionRevision,
          sessions: {
            type: "array",
            maxItems: BROWSER_SESSION_LIMIT,
            items: browserSessionObject,
          },
        },
      },
    },
    {
      name: "open",
      effect: "write",
      requiredGrants: [BROWSER_SESSIONS, BROWSER_OPERATE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: browserSessionUrl,
          viewport: browserSessionViewport,
          profileId: { type: "string", minLength: 1, maxLength: 64 },
        },
      },
      outputSchema: browserSessionReceipt,
    },
    {
      name: "navigate",
      effect: "write",
      requiredGrants: [BROWSER_SESSIONS, BROWSER_OPERATE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["tabId", "serverEpoch", "url", "expectedEngineGeneration"],
        properties: { ...browserSessionCommandGuard, url: browserSessionUrl },
      },
      outputSchema: browserSessionReceipt,
    },
    {
      name: "close",
      effect: "write",
      requiredGrants: [BROWSER_SESSIONS, BROWSER_OPERATE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["tabId", "serverEpoch"],
        properties: { tabId: browserSessionTabId, serverEpoch: browserSessionEpoch },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["outcome", "serverEpoch", "revision"],
        properties: {
          outcome: { enum: ["closed", "already-closed"] },
          serverEpoch: browserSessionEpoch,
          revision: browserSessionRevision,
        },
      },
    },
    browserSessionCommandMethod("back"),
    browserSessionCommandMethod("forward"),
    browserSessionCommandMethod("reload"),
    browserSessionCommandMethod("hardReload"),
    browserSessionCommandMethod("resize", { viewport: browserSessionViewport }, ["viewport"]),
    browserSessionCommandMethod(
      "zoom",
      { zoomFactor: { enum: [...BROWSER_SESSION_ZOOM_LEVELS] } },
      ["zoomFactor"],
    ),
    browserSessionCommandMethod(
      "setAppearance",
      { appearance: { enum: ["system", "light", "dark"] } },
      ["appearance"],
    ),
    browserSessionCommandMethod("setAudioMuted", { muted: { type: "boolean" } }, ["muted"]),
  ],
  streams: [
    {
      name: "events",
      requiredGrants: [BROWSER_SESSIONS],
      inputSchema: browserSessionEmptyInput,
      eventSchema: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "snapshotId", "serverEpoch", "revision", "sessionCount"],
            properties: {
              kind: { const: "snapshot-start" },
              snapshotId: { type: "string", minLength: 1, maxLength: 64 },
              serverEpoch: browserSessionEpoch,
              revision: browserSessionRevision,
              sessionCount: { type: "integer", minimum: 0, maximum: BROWSER_SESSION_LIMIT },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "snapshotId", "chunkIndex", "sessions"],
            properties: {
              kind: { const: "snapshot-chunk" },
              snapshotId: { type: "string", minLength: 1, maxLength: 64 },
              chunkIndex: { type: "integer", minimum: 0 },
              sessions: {
                type: "array",
                maxItems: BROWSER_SESSION_LIMIT,
                items: browserSessionObject,
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "snapshotId", "serverEpoch", "revision", "sessionCount"],
            properties: {
              kind: { const: "snapshot-complete" },
              snapshotId: { type: "string", minLength: 1, maxLength: 64 },
              serverEpoch: browserSessionEpoch,
              revision: browserSessionRevision,
              sessionCount: { type: "integer", minimum: 0, maximum: BROWSER_SESSION_LIMIT },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "revision", "session"],
            properties: {
              kind: { const: "session-upsert" },
              revision: browserSessionRevision,
              session: browserSessionObject,
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "revision", "tabId", "reason"],
            properties: {
              kind: { const: "session-removed" },
              revision: browserSessionRevision,
              tabId: browserSessionTabId,
              reason: { enum: ["user-closed", "thread-deleted"] },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "reason"],
            properties: {
              kind: { const: "closed" },
              reason: {
                enum: [
                  "epoch-changed",
                  "host-disconnected",
                  "scope-invalidated",
                  "grant-revoked",
                  "installation-changed",
                  "overflow",
                  "source-unavailable",
                ],
              },
            },
          },
        ],
      },
    },
  ],
});
export const BROWSER_SESSIONS_API = browserSessionsApi.definition;

/* ------------------------------------------------------------------------
 * t3.browser/frames — remote pixel transport for a browser session
 *
 * Actions never ride this contract; automation stays on t3.browser/sessions
 * and no raw CDP surface is exposed. The methods mint lease-bound tickets —
 * the frames themselves move over `/api/browser-frames/*`, not through the
 * invoke channel.
 */

export const BROWSER_FRAMES = "t3.browser/frames";
export const BROWSER_FRAMES_VERSION = "1.0.0";

/** Fencing identity for one live browser session, as advertised by the engine. */
export type BrowserFrameSessionIdentity = {
  readonly environmentId: string;
  readonly threadId: string;
  readonly serverEpoch: string;
  readonly tabId: string;
  /**
   * Engine generation the mint observed, if the caller asserted one.
   * `null` means "not asserted"; the authoritative generation is always in
   * `/config`, `/sessions`, and frame headers — never in this descriptor.
   */
  readonly engineGeneration: string | null;
};

export type BrowserFrameStreamDescriptor = {
  readonly session: BrowserFrameSessionIdentity;
  /** Engine-host id to pass as `hostId` on the proxy, or null for the default host. */
  readonly hostId: string | null;
  /**
   * Paths on the environment HTTP origin. Append `frameTicket` (or a session
   * `wsTicket`) plus the session tuple as query parameters. Geometry,
   * dimensions, and the authoritative engine generation come from `config`
   * and stream part headers — they are deliberately not duplicated here.
   */
  readonly paths: {
    readonly stream: string;
    readonly snapshot: string;
    readonly config: string;
  };
  /** Lease-bound stream ticket; expires at `expiresAt` (epoch ms). */
  readonly ticket: string;
  readonly expiresAt: number;
};

export type BrowserFrameInputLease = {
  readonly leaseId: string;
  /** Bearer credential for `GET /sessions/<tabId>/input` (WS upgrade). */
  readonly inputTicket: string;
  readonly expiresAt: number;
  readonly paths: { readonly input: string };
};

export type BrowserFramesCapabilities = {
  readonly metadata: { readonly supported: true };
  readonly stream:
    | { readonly supported: true }
    | { readonly supported: false; readonly reason: "engine-unavailable" };
  readonly input: { readonly supported: boolean };
};

const browserFrameSessionIdentity = {
  type: "object",
  additionalProperties: false,
  required: ["environmentId", "threadId", "serverEpoch", "tabId", "engineGeneration"],
  properties: {
    environmentId: { type: "string", minLength: 1, maxLength: 128 },
    threadId: { type: "string", minLength: 1, maxLength: 128 },
    serverEpoch: { type: "string", minLength: 1, maxLength: 128 },
    tabId: browserSessionTabId,
    engineGeneration: { type: ["string", "null"], minLength: 1, maxLength: 128 },
  },
} as const;
const browserFrameTarget = {
  type: "object",
  additionalProperties: false,
  required: ["tabId", "serverEpoch", "surfaceLease"],
  properties: {
    tabId: browserSessionTabId,
    serverEpoch: browserSessionEpoch,
    expectedEngineGeneration: { type: ["string", "null"], minLength: 1, maxLength: 128 },
    /**
     * Held-presentation evidence: a `browser-surface` claim token minted
     * through `t3.resources/lease` `createPresentationUrl` for this exact
     * session tuple. Minting a frame ticket without one is denied.
     */
    surfaceLease: { type: "string", minLength: 1, maxLength: 4096 },
  },
} as const;
const browserFrameStreamDescriptor = {
  type: "object",
  additionalProperties: false,
  required: ["session", "hostId", "paths", "ticket", "expiresAt"],
  properties: {
    session: browserFrameSessionIdentity,
    hostId: { type: ["string", "null"], minLength: 1, maxLength: 128 },
    paths: {
      type: "object",
      additionalProperties: false,
      required: ["stream", "snapshot", "config"],
      properties: {
        stream: { type: "string", minLength: 1, maxLength: 512 },
        snapshot: { type: "string", minLength: 1, maxLength: 512 },
        config: { type: "string", minLength: 1, maxLength: 512 },
      },
    },
    ticket: { type: "string", minLength: 1, maxLength: 256 },
    expiresAt: { type: "integer", minimum: 1 },
  },
} as const;
const browserFrameInputLease = {
  type: "object",
  additionalProperties: false,
  required: ["leaseId", "inputTicket", "expiresAt", "paths"],
  properties: {
    leaseId: { type: "string", minLength: 1, maxLength: 128 },
    inputTicket: { type: "string", minLength: 1, maxLength: 256 },
    expiresAt: { type: "integer", minimum: 1 },
    paths: {
      type: "object",
      additionalProperties: false,
      required: ["input"],
      properties: { input: { type: "string", minLength: 1, maxLength: 512 } },
    },
  },
} as const;

export const browserFramesApi: TypedApi<{
  getCapabilities: { input: Record<string, never>; output: BrowserFramesCapabilities };
  openStream: {
    input: {
      readonly tabId: string;
      readonly serverEpoch: string;
      readonly expectedEngineGeneration?: string | null;
      readonly surfaceLease: string;
    };
    output: BrowserFrameStreamDescriptor;
  };
  openInput: {
    input: {
      readonly tabId: string;
      readonly serverEpoch: string;
      readonly expectedEngineGeneration?: string | null;
      readonly surfaceLease: string;
    };
    output: BrowserFrameInputLease;
  };
  closeInput: {
    input: { readonly leaseId: string; readonly surfaceLease?: string };
    output: { readonly closed: boolean };
  };
}> = defineApi<{
  getCapabilities: { input: Record<string, never>; output: BrowserFramesCapabilities };
  openStream: {
    input: {
      readonly tabId: string;
      readonly serverEpoch: string;
      readonly expectedEngineGeneration?: string | null;
      readonly surfaceLease: string;
    };
    output: BrowserFrameStreamDescriptor;
  };
  openInput: {
    input: {
      readonly tabId: string;
      readonly serverEpoch: string;
      readonly expectedEngineGeneration?: string | null;
      readonly surfaceLease: string;
    };
    output: BrowserFrameInputLease;
  };
  closeInput: {
    input: { readonly leaseId: string; readonly surfaceLease?: string };
    output: { readonly closed: boolean };
  };
}>({
  id: BROWSER_FRAMES,
  version: BROWSER_FRAMES_VERSION,
  methods: [
    {
      name: "getCapabilities",
      effect: "read",
      requiredGrants: [BROWSER_FRAMES],
      inputSchema: browserSessionEmptyInput,
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["metadata", "stream", "input"],
        properties: {
          metadata: {
            type: "object",
            additionalProperties: false,
            required: ["supported"],
            properties: { supported: { const: true } },
          },
          stream: {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["supported"],
                properties: { supported: { const: true } },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["supported", "reason"],
                properties: {
                  supported: { const: false },
                  reason: { enum: ["engine-unavailable"] },
                },
              },
            ],
          },
          input: {
            type: "object",
            additionalProperties: false,
            required: ["supported"],
            properties: { supported: { type: "boolean" } },
          },
        },
      },
    },
    {
      name: "openStream",
      effect: "read",
      requiredGrants: [BROWSER_SESSIONS, BROWSER_FRAMES],
      inputSchema: browserFrameTarget,
      outputSchema: browserFrameStreamDescriptor,
    },
    {
      name: "openInput",
      effect: "write",
      requiredGrants: [BROWSER_SESSIONS, BROWSER_OPERATE, BROWSER_FRAMES],
      inputSchema: browserFrameTarget,
      outputSchema: browserFrameInputLease,
    },
    {
      name: "closeInput",
      effect: "write",
      requiredGrants: [BROWSER_SESSIONS, BROWSER_OPERATE, BROWSER_FRAMES],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["leaseId"],
        properties: {
          leaseId: { type: "string", minLength: 1, maxLength: 128 },
          // The closing slot's own presentation claim — leases are keyed to
          // the slot that minted them, so a close without it names no slot.
          surfaceLease: { type: "string", minLength: 1, maxLength: 2048 },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["closed"],
        properties: { closed: { type: "boolean" } },
      },
    },
  ],
});
export const BROWSER_FRAMES_API = browserFramesApi.definition;

/* ------------------------------------------------------------------------
 * t3.browser/surface — host-local presentation lease for a browser session
 * that attaches the engine's view to a host slot.
 *
 * Unlike the brokered APIs above, this contract is a CLIENT HOST capability:
 * `ClientHost.browserSurface`. `present()` runs at ResizeObserver rate and the
 * compositor (the Electron `<webview>` host) lives in the renderer, so none of
 * it crosses `invokeApi`. The string doubles as the installation grant —
 * presenting requires it AND `t3.browser/sessions`, enforced by the host
 * bridge on every acquire; both denials are named.
 *
 * Semantics mirror the private `browserSurfaceStore`: a lease binds one
 * session (public tabId + serverEpoch) to one plugin-owned slot. Ownership is
 * single — a second acquire supersedes the first lease (the named
 * `superseded` end state reaches its `onDidChangeState` listeners; the first
 * holder may acquire again). `present` is latest-wins and frame-coalesced:
 * calls within one frame collapse to a single store write, so a plugin must
 * re-send after every geometry change rather than stream per frame. `release`
 * ends presentation only — it never closes the browser session.
 * --------------------------------------------------------------------- */
export const BROWSER_SURFACE = "t3.browser/surface";
export const BROWSER_SURFACE_VERSION = "1.0.0";
/** Both grants are required to acquire a presentation lease. */
export const BROWSER_SURFACE_REQUIRED_GRANTS = [BROWSER_SESSIONS, BROWSER_SURFACE] as const;

/**
 * Integer CSS-pixel bounds, viewport-relative. The composited surface is not
 * a DOM descendant of the slot — ancestor overflow does not clip it — so the
 * caller must present only the region the slot can actually show.
 * `useBrowserSurfaceSlot` intersects the slot with its overflow-clipping
 * ancestors' padding boxes and the viewport, and hides the surface while the
 * slot's visible center is covered by an unrelated element — a center-point
 * heuristic, not arbitrary-region clipping.
 */
export interface BrowserSurfaceRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Public session identity, as reported by `t3.browser/sessions`. */
export interface BrowserSurfaceSessionRef {
  readonly tabId: string;
  readonly serverEpoch: string;
}

/**
 * Where this client can composite native browser content. Only the Electron
 * renderer has the engine host today; every other client reports the named
 * `desktop-required` state instead of silently dropping `present` calls.
 */
export type BrowserSurfacePresentationSupport =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: "desktop-required" };

export type BrowserSurfaceDenialReason =
  /** `grant` names the missing installation grant. */
  | "grant-denied"
  /** Context is not a thread scope inside this environment and granted project. */
  | "scope-invalid"
  /** The session identity is malformed or not a `t3.browser/sessions` ref. */
  | "session-invalid"
  /** The synced server epoch already moved past the session's. */
  | "epoch-changed"
  /**
   * The host could not verify the lease scope right now — the thread's
   * shell state is still synchronizing, or the calling client's install
   * lifetime ended. Transient for a live installation; SDK callers retry
   * with bounded backoff before treating the slot as dead.
   */
  | "host-unavailable";

export interface BrowserSurfaceDenial {
  readonly reason: BrowserSurfaceDenialReason;
  readonly detail: string;
  /** Set when reason is "grant-denied". */
  readonly grant?: string;
}

export type BrowserSurfaceEndReason =
  /** `release()` ran — the session itself is unaffected. */
  | "released"
  /** Another lease claimed the session; ownership is single. */
  | "superseded"
  /** The caller-supplied signal aborted — view disposed or thread closed. */
  | "scope-invalidated"
  /** The installation's grant set or lifetime ended underneath the lease. */
  | "grant-revoked"
  /** The session was observed in synced state and then removed. */
  | "session-closed"
  /**
   * The session was never verified: every arbitrating `preview.list`
   * request failed or the bounded wait elapsed with no completed list.
   * Unlike `session-closed` this asserts nothing about the session — the
   * host simply could not prove it exists within the bound.
   */
  | "session-unverified"
  /** Synced state moved to a different server epoch. */
  | "epoch-changed";

export type BrowserSurfaceLeaseState =
  | {
      readonly kind: "active";
      readonly presentation: BrowserSurfacePresentationSupport;
    }
  | { readonly kind: "ended"; readonly reason: BrowserSurfaceEndReason };

export type BrowserSurfacePresentOutcome =
  /** Accepted into the frame-coalesced channel; latest wins, one write/frame. */
  | "accepted"
  /** Lease held but this host cannot composite — nothing is on screen. */
  | "uncomposited"
  /** Lease is over; `state` carries the named reason. */
  | "ended";

export interface BrowserSurfaceLease {
  readonly session: BrowserSurfaceSessionRef;
  readonly state: BrowserSurfaceLeaseState;
  /** Fires on every state transition; the listener receives the new state. */
  onDidChangeState(listener: (state: BrowserSurfaceLeaseState) => void): () => void;
  /**
   * Latest-wins, frame-coalesced bounds/visibility update. The rect is the
   * surface's footprint — pass the visible (clipped) region, not the raw slot
   * bounds, and set `visible` false while the slot is clipped away or
   * occluded. Rect fields must be finite numbers; width/height are clamped to
   * at least one pixel, matching the native slot. Ended leases return "ended"
   * and never present again.
   */
  present(
    rect: BrowserSurfaceRect,
    visible: boolean,
    cornerRadius?: number,
    zIndex?: number,
  ): BrowserSurfacePresentOutcome;
  /** Idempotent. Ends the lease with reason "released"; the session survives. */
  release(): void;
}

export interface BrowserSurfaceAcquireRequest {
  /**
   * The calling view's own context. It must resolve to a thread inside this
   * environment and a granted project; a plugin cannot present a session from
   * another environment or thread.
   */
  readonly context: ViewContext;
  readonly session: BrowserSurfaceSessionRef;
  /**
   * Caller lifetime — pass `ViewSession.signal`. Its abort ends the lease
   * with "scope-invalidated" so a disposed view never retains presentation.
   */
  readonly signal?: AbortSignal;
}

export type BrowserSurfaceAcquireResult =
  | { readonly ok: true; readonly lease: BrowserSurfaceLease }
  | { readonly ok: false; readonly denial: BrowserSurfaceDenial };

/**
 * The host side of `t3.browser/surface@1.0.0`. Present on `ClientHost` as
 * `browserSurface`; absence means the host predates the contract (treat as
 * `host-unavailable`).
 */
export interface BrowserSurfaceHost {
  readonly id: typeof BROWSER_SURFACE;
  readonly version: string;
  /** Static for the host's lifetime — compositing cannot appear mid-session. */
  readonly presentation: BrowserSurfacePresentationSupport;
  acquire(request: BrowserSurfaceAcquireRequest): BrowserSurfaceAcquireResult;
}

/* ------------------------------------------------------------------------
 * t3.browser/frames — remote pixel transport presenter
 *
 * The host-side half of `t3.browser/frames@1.0.0`, mirroring
 * `BrowserSurfaceHost`: a `ClientHost.browserFrames` capability, not a
 * brokered method. A host that can run the remote-frame transport (fetch +
 * MJPEG decode + input WebSocket) mounts a frame view inside a caller-owned
 * element. Authorization is never asserted through this capability — the
 * caller supplies the lease-bound mints (`openStream`/`openInput`), and a
 * caller without the grants simply cannot produce working tickets.
 *
 * Present when the host can present remote frames; absent on hosts that
 * predate the contract or cannot run the transport (treat as the named
 * "host-unavailable" state). Presentation support is not tied to
 * `browserSurface` compositing — a host may do either, both, or neither.
 * --------------------------------------------------------------------- */

/** Public session identity, as reported by `t3.browser/sessions`. */
export interface BrowserFramesSessionRef {
  readonly tabId: string;
  readonly serverEpoch: string;
}

/** A lease-bound stream ticket minted by `t3.browser/frames` `openStream`. */
export interface BrowserFramesStreamMint {
  readonly ticket: string;
  /** Epoch milliseconds; the stream ends when the ticket floor passes. */
  readonly expiresAt: number;
}

/** An input lease minted by `t3.browser/frames` `openInput`. */
export interface BrowserFramesInputMint {
  readonly leaseId: string;
  readonly inputTicket: string;
  /** Epoch milliseconds; the input socket closes when the lease floor passes. */
  readonly expiresAt: number;
}

export interface BrowserFramesPresentRequest {
  /**
   * The calling view's own context. It must resolve to a thread inside this
   * environment; a plugin cannot present a session from another
   * environment or thread.
   */
  readonly context: ViewContext;
  readonly session: BrowserFramesSessionRef;
  /**
   * Caller-owned mount point. The host appends its frame element and wires
   * pointer/wheel/keyboard input on it; the caller keeps layout and paint
   * order (overlays render above the frame element as ordinary DOM).
   */
  readonly slot: HTMLElement;
  /** Caller lifetime — pass `ViewSession.signal`. Aborting detaches the view. */
  readonly signal?: AbortSignal;
  /**
   * Mint (or re-mint) a stream ticket through `openStream`. Called at
   * present, again when the hub/proxy reports the credential rejected, and
   * ahead of expiry. Returning `null` keeps the view connecting.
   */
  readonly openStream: () => Promise<BrowserFramesStreamMint | null>;
  /**
   * Mint (or renew) an input lease through `openInput`. Called on the
   * viewer's first input and on lease renewal; returning `null` keeps the
   * view present-but-not-controlling. Absent means the caller never wants
   * input — a presenter need not control.
   */
  readonly openInput?: () => Promise<BrowserFramesInputMint | null>;
}

export type BrowserFramesDenialReason =
  /** `grant` names the missing installation grant. */
  | "grant-denied"
  /** The host could not resolve this environment's frame endpoint right now. */
  | "host-unavailable"
  /** Context is not a thread scope inside this environment. */
  | "scope-invalid"
  /** The session identity is malformed or not a `t3.browser/sessions` ref. */
  | "session-invalid"
  /** This host has no remote-frame transport to offer. */
  | "frames-unsupported";

export interface BrowserFramesDenial {
  readonly reason: BrowserFramesDenialReason;
  readonly detail: string;
  /** Set when reason is "grant-denied". */
  readonly grant?: string;
}

export type BrowserFramesViewStatus = "connecting" | "streaming" | "error";

export interface BrowserFramesViewState {
  readonly status: BrowserFramesViewStatus;
  /** Whether the input lease is bound and accepting packets. */
  readonly inputConnected: boolean;
  /** Frames the engine produced that this client dropped before painting. */
  readonly droppedFrames: number;
  /** Input packets the hub rejected (replay, stale geometry, rate limit, …). */
  readonly rejectedInput: number;
  readonly detail?: string;
}

export interface BrowserFramesView {
  readonly state: BrowserFramesViewState;
  onDidChangeState(listener: (state: BrowserFramesViewState) => void): () => void;
  /** Idempotent. Stops the transport and removes the frame element. */
  detach(): void;
}

export type BrowserFramesPresentResult =
  | { readonly ok: true; readonly view: BrowserFramesView }
  | { readonly ok: false; readonly denial: BrowserFramesDenial };

/**
 * The host side of `t3.browser/frames@1.0.0`. Present on `ClientHost` as
 * `browserFrames`; absence means the host predates the contract or has no
 * remote-frame transport (treat as "host-unavailable").
 */
export interface BrowserFramesHost {
  readonly id: typeof BROWSER_FRAMES;
  readonly version: string;
  present(request: BrowserFramesPresentRequest): BrowserFramesPresentResult;
}

/**
 * Grants enforced by host-local capability contracts that have no brokered
 * methods — the settings UI lists these alongside catalogue `requiredGrants`
 * so they can be granted at install time. A grant id here is not an
 * invocable API id.
 */
export const HOST_CAPABILITY_GRANTS: readonly string[] = [BROWSER_SURFACE];

export const COMPOSER_CONTEXT = "t3.composer/context";
export const COMPOSER_WRITE = "t3.composer/write";
export const MESSAGES_ENRICHMENT = "t3.messages/enrichment";
export const MESSAGES_WRITE = "t3.messages/write";

export type ComposerContextRef = {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly excerpt?: string;
};
export type ComposerContextInsertInput = {
  readonly threadId?: string;
  readonly refs: readonly ComposerContextRef[];
};
export type ComposerContextInsertResult = {
  readonly inserted: number;
  readonly target: string;
};
export type ComposerDraftStateResult = {
  readonly draft: {
    readonly prompt: string;
    readonly promptTruncated: boolean;
    readonly contextCounts: {
      readonly files: number;
      readonly images: number;
      readonly terminalContexts: number;
      readonly elementContexts: number;
      readonly previewAnnotations: number;
      readonly reviewComments: number;
    };
  } | null;
};
export type ComposerTerminalContextInsertInput = {
  readonly threadId?: string;
  readonly terminalId: string;
  readonly terminalLabel: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly text: string;
};
export type ComposerTerminalContextInsertResult = {
  readonly inserted: boolean;
  readonly reason?: "duplicate";
  readonly target: string;
};
export type ComposerMentionInsertInput = {
  readonly threadId?: string;
  readonly paths: readonly string[];
};
export type ComposerMentionInsertResult = {
  readonly inserted: number;
  readonly target: string;
};
export type ComposerCapabilities = {
  readonly adapter: string;
  readonly transport: "server" | "client" | "unavailable";
  readonly detail: string | null;
  readonly operations: {
    readonly insertContext: boolean;
    readonly getDraftState: boolean;
    readonly insertMention: boolean;
    readonly insertTerminalContext: boolean;
  };
};
export type MessagesFileAnnotation = {
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly body: string;
  readonly excerpt?: string;
};
/** Mirrors what `buildDiffReviewComment` produces for a native diff comment. */
export type MessagesDiffAnnotation = {
  readonly kind: "diff";
  readonly filePath: string;
  readonly sectionId: string;
  readonly sectionTitle: string;
  readonly rangeLabel: string;
  /** Hunk text with leading +/-/space markers per line. */
  readonly diff: string;
  readonly selection: {
    readonly start: number;
    readonly side: "additions" | "deletions";
    readonly end: number;
    readonly endSide: "additions" | "deletions";
  };
  readonly startIndex?: number;
  readonly endIndex?: number;
  readonly body: string;
};
export type MessagesEnrichmentAnnotation = MessagesFileAnnotation | MessagesDiffAnnotation;
export type MessagesAttachAnnotationInput = {
  readonly threadId?: string;
  readonly annotation: MessagesEnrichmentAnnotation;
};
export type MessagesAttachAnnotationResult = {
  readonly annotationId: string;
};
export type MessagesListAnnotationsInput = {
  readonly threadId?: string;
};
export type MessagesListedAnnotation = {
  readonly annotationId: string;
  readonly kind: "file" | "diff";
  readonly filePath: string;
  readonly rangeLabel: string;
  readonly sectionTitle: string;
};
export type MessagesListAnnotationsResult = {
  readonly annotations: readonly MessagesListedAnnotation[];
};
export type MessagesRemoveAnnotationInput = {
  readonly threadId?: string;
  readonly annotationId: string;
};
export type MessagesRemoveAnnotationResult = {
  readonly removed: boolean;
};
export type MessagesEnrichmentCapabilities = {
  readonly adapter: string;
  readonly transport: "server" | "client" | "unavailable";
  readonly detail: string | null;
  readonly operations: {
    readonly attachAnnotation: boolean;
    readonly listAnnotations: boolean;
    readonly removeAnnotation: boolean;
  };
};

const composerThreadIdInput = { type: "string", minLength: 1, maxLength: 128 } as const;
const composerLineInput = { type: "integer", minimum: 1, maximum: 1_000_000 } as const;
const composerContextRefSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: 512 },
    startLine: composerLineInput,
    endLine: composerLineInput,
    // 8 refs at these bounds encode to ≤51 KB worst-case (6 bytes/char for
    // C0 escapes) — inside the broker's 64 KiB copyJson envelope.
    excerpt: { type: "string", maxLength: 512 },
  },
} as const;
const composerTransportOutput = (operations: readonly string[]) =>
  ({
    type: "object",
    additionalProperties: false,
    required: ["adapter", "transport", "detail", "operations"],
    properties: {
      adapter: { type: "string", maxLength: 64 },
      transport: { enum: ["server", "client", "unavailable"] },
      detail: { type: ["string", "null"], maxLength: 512 },
      operations: {
        type: "object",
        additionalProperties: false,
        required: [...operations],
        properties: Object.fromEntries(operations.map((name) => [name, { type: "boolean" }])),
      },
    },
  }) as const;
const composerEmptyInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;
const composerTerminalIdInput = { type: "string", minLength: 1, maxLength: 128 } as const;
// 10,000 chars worst-case encodes to 60,000 UTF-8 bytes (6/char for C0
// escapes); with both ids at 128 chars the whole serialized invoke stays
// under the broker's 64 KiB copyJson envelope.
const composerTerminalTextInput = { type: "string", minLength: 1, maxLength: 10000 } as const;
const composerInsertResultOutput = {
  type: "object",
  additionalProperties: false,
  required: ["inserted", "target"],
  properties: {
    inserted: { type: "integer", minimum: 0, maximum: 8 },
    target: { type: "string", minLength: 1, maxLength: 256 },
  },
} as const;
const annotationSelectionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["start", "side", "end", "endSide"],
  properties: {
    start: composerLineInput,
    side: { enum: ["additions", "deletions"] },
    end: composerLineInput,
    endSide: { enum: ["additions", "deletions"] },
  },
} as const;
const diffAnnotationSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "kind",
    "filePath",
    "sectionId",
    "sectionTitle",
    "rangeLabel",
    "diff",
    "selection",
    "body",
  ],
  properties: {
    kind: { const: "diff" },
    filePath: { type: "string", minLength: 1, maxLength: 512 },
    sectionId: { type: "string", minLength: 1, maxLength: 512 },
    sectionTitle: { type: "string", minLength: 1, maxLength: 256 },
    rangeLabel: { type: "string", minLength: 1, maxLength: 128 },
    diff: { type: "string", minLength: 1, maxLength: 4096 },
    selection: annotationSelectionSchema,
    startIndex: { type: "integer", minimum: 0, maximum: 1_000_000 },
    endIndex: { type: "integer", minimum: 0, maximum: 1_000_000 },
    body: { type: "string", minLength: 1, maxLength: 4096 },
  },
} as const;

/**
 * Composer draft context. The draft store is client-local, so the insert
 * operations and `getDraftState` apply only once a client-adapter transport
 * exists; until then the host adapter reports them unsupported through
 * `getCapabilities` and fails invocations with a named error rather than
 * silently no-opping. Free-form send stays with `t3.orchestration/control` —
 * this contract only ever mutates draft content.
 *
 * 1.1.0 adds the two insert shapes the native panels use: file mentions
 * (`insertMention`, byte-identical to Files "Add to chat") and terminal
 * context chips (`insertTerminalContext`, the Terminal drawer's selection).
 */
export const composerContextApi = defineApi<{
  getCapabilities: { input: Record<string, never>; output: ComposerCapabilities };
  insertContext: {
    input: ComposerContextInsertInput;
    output: ComposerContextInsertResult;
  };
  getDraftState: { input: { threadId?: string }; output: ComposerDraftStateResult };
  insertMention: { input: ComposerMentionInsertInput; output: ComposerMentionInsertResult };
  insertTerminalContext: {
    input: ComposerTerminalContextInsertInput;
    output: ComposerTerminalContextInsertResult;
  };
}>({
  id: COMPOSER_CONTEXT,
  version: "1.1.0",
  methods: [
    {
      name: "getCapabilities",
      effect: "read",
      // Capability discovery is grant-free so callers can tell "no capability"
      // apart from "no grant" — authority gates the mutations, not the report.
      requiredGrants: [],
      inputSchema: composerEmptyInputSchema,
      outputSchema: composerTransportOutput([
        "insertContext",
        "getDraftState",
        "insertMention",
        "insertTerminalContext",
      ]),
    },
    {
      name: "insertContext",
      effect: "write",
      requiredGrants: [COMPOSER_WRITE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["refs"],
        properties: {
          threadId: composerThreadIdInput,
          refs: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: composerContextRefSchema,
          },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["inserted", "target"],
        properties: {
          inserted: { type: "integer", minimum: 0, maximum: 8 },
          target: { type: "string", minLength: 1, maxLength: 256 },
        },
      },
    },
    {
      name: "getDraftState",
      effect: "read",
      // Draft state carries the user's unsent words — it sits under the same
      // write authority as the mutations on this contract.
      requiredGrants: [COMPOSER_WRITE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { threadId: composerThreadIdInput },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["draft"],
        properties: {
          draft: {
            type: ["object", "null"],
            additionalProperties: false,
            required: ["prompt", "promptTruncated", "contextCounts"],
            properties: {
              // 10,000 chars worst-case encodes to 60,000 UTF-8 bytes
              // (6/char for C0 escapes) — the response always fits the
              // broker's 64 KiB copyJson envelope. Longer drafts are cut
              // on a char boundary and disclosed via promptTruncated.
              prompt: { type: "string", maxLength: 10000 },
              promptTruncated: { type: "boolean" },
              contextCounts: {
                type: "object",
                additionalProperties: false,
                required: [
                  "files",
                  "images",
                  "terminalContexts",
                  "elementContexts",
                  "previewAnnotations",
                  "reviewComments",
                ],
                properties: {
                  files: { type: "integer", minimum: 0, maximum: 10000 },
                  images: { type: "integer", minimum: 0, maximum: 10000 },
                  terminalContexts: { type: "integer", minimum: 0, maximum: 10000 },
                  elementContexts: { type: "integer", minimum: 0, maximum: 10000 },
                  previewAnnotations: { type: "integer", minimum: 0, maximum: 10000 },
                  reviewComments: { type: "integer", minimum: 0, maximum: 10000 },
                },
              },
            },
          },
        },
      },
    },
    {
      name: "insertMention",
      effect: "write",
      requiredGrants: [COMPOSER_WRITE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["paths"],
        properties: {
          threadId: composerThreadIdInput,
          paths: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: { type: "string", minLength: 1, maxLength: 512 },
          },
        },
      },
      outputSchema: composerInsertResultOutput,
    },
    {
      name: "insertTerminalContext",
      effect: "write",
      requiredGrants: [COMPOSER_WRITE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["terminalId", "terminalLabel", "lineStart", "lineEnd", "text"],
        properties: {
          threadId: composerThreadIdInput,
          terminalId: composerTerminalIdInput,
          terminalLabel: composerTerminalIdInput,
          lineStart: composerLineInput,
          lineEnd: composerLineInput,
          text: composerTerminalTextInput,
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["inserted", "target"],
        properties: {
          inserted: { type: "boolean" },
          reason: { enum: ["duplicate"] },
          target: { type: "string", minLength: 1, maxLength: 256 },
        },
      },
    },
  ],
});

/**
 * Review-style draft annotation. The native path is composer-insert only —
 * `buildFileReviewComment` + `addReviewComment` on the client draft store —
 * and annotations serialize into the next sent message. There is no
 * message-level annotation entity, so turn/sent-message enrichment is not
 * expressible and stays deferred.
 *
 * 1.1.0 adds the diff kind the diff viewer inserts (`buildDiffReviewComment`
 * records, `fenceLanguage: "diff"`), plus own-ids-only list/remove so an
 * installation can enumerate and retract what it attached.
 */
export const messagesEnrichmentApi = defineApi<{
  getCapabilities: { input: Record<string, never>; output: MessagesEnrichmentCapabilities };
  attachAnnotation: {
    input: MessagesAttachAnnotationInput;
    output: MessagesAttachAnnotationResult;
  };
  listAnnotations: {
    input: MessagesListAnnotationsInput;
    output: MessagesListAnnotationsResult;
  };
  removeAnnotation: {
    input: MessagesRemoveAnnotationInput;
    output: MessagesRemoveAnnotationResult;
  };
}>({
  id: MESSAGES_ENRICHMENT,
  version: "1.1.0",
  methods: [
    {
      name: "getCapabilities",
      effect: "read",
      requiredGrants: [],
      inputSchema: composerEmptyInputSchema,
      outputSchema: composerTransportOutput([
        "attachAnnotation",
        "listAnnotations",
        "removeAnnotation",
      ]),
    },
    {
      name: "attachAnnotation",
      effect: "write",
      requiredGrants: [MESSAGES_WRITE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["annotation"],
        properties: {
          threadId: composerThreadIdInput,
          annotation: {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["filePath", "startLine", "endLine", "body"],
                properties: {
                  filePath: { type: "string", minLength: 1, maxLength: 512 },
                  startLine: composerLineInput,
                  endLine: composerLineInput,
                  // body + excerpt at 4,096 chars each keep the worst-case
                  // encoded request (~53 KB) inside the 64 KiB invoke envelope.
                  body: { type: "string", minLength: 1, maxLength: 4096 },
                  excerpt: { type: "string", maxLength: 4096 },
                },
              },
              diffAnnotationSchema,
            ],
          },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["annotationId"],
        properties: {
          annotationId: { type: "string", minLength: 1, maxLength: 256 },
        },
      },
    },
    {
      name: "listAnnotations",
      effect: "read",
      // Lists the caller's own unsent annotations only, but the draft itself
      // is the user's unsent words — same write-authority stance as
      // getDraftState on the composer contract.
      requiredGrants: [MESSAGES_WRITE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { threadId: composerThreadIdInput },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["annotations"],
        properties: {
          annotations: {
            // 8 entries at field maxima stay inside the 64 KiB frame envelope.
            type: "array",
            maxItems: 8,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["annotationId", "kind", "filePath", "rangeLabel", "sectionTitle"],
              properties: {
                annotationId: { type: "string", minLength: 1, maxLength: 256 },
                kind: { enum: ["file", "diff"] },
                filePath: { type: "string", minLength: 1, maxLength: 512 },
                rangeLabel: { type: "string", minLength: 1, maxLength: 128 },
                sectionTitle: { type: "string", minLength: 1, maxLength: 256 },
              },
            },
          },
        },
      },
    },
    {
      name: "removeAnnotation",
      effect: "write",
      requiredGrants: [MESSAGES_WRITE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["annotationId"],
        properties: {
          threadId: composerThreadIdInput,
          annotationId: { type: "string", minLength: 1, maxLength: 256 },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["removed"],
        properties: { removed: { type: "boolean" } },
      },
    },
  ],
});
export const COMPOSER_CONTEXT_API = composerContextApi.definition;
export const MESSAGES_ENRICHMENT_API = messagesEnrichmentApi.definition;

/* ------------------------------------------------------------------------
 * t3.ui/* — client-local UI state behind the client-provider seam.
 *
 * These contracts are backed by host-owned `t3.client/*` providers registered
 * over the per-connection clientProviders connect stream (see
 * ./clientProviders.ts for the private area definitions). Every adapter
 * resolves an explicit target — the caller's own same-session connection
 * (`self`) or a `connectionId` from `listClientTargets` — and never silently
 * falls back to another client.
 * --------------------------------------------------------------------- */
export const UI_THEME = "t3.ui/theme";
export const UI_THEME_READ = "t3.ui/theme.read";
export const UI_THEME_WRITE = "t3.ui/theme.write";
export const UI_KEYBINDINGS = "t3.ui/keybindings";
export const UI_KEYBINDINGS_GLOBAL = "t3.ui/keybindings.global";
/**
 * 1.1.0 adds the client-local `ClientHost.keybindings` capability
 * (`UiKeybindingsHost`); the brokered methods are unchanged from 1.0.0.
 */
export const UI_KEYBINDINGS_VERSION = "1.1.0";
export const UI_NOTIFY = "t3.ui/notify";
export const UI_PANELS = "t3.ui/panels";

const uiClientTargetSchema = {
  type: "object",
  additionalProperties: false,
  required: ["connectionId", "providers", "connectedAt"],
  properties: {
    connectionId: { type: "string", minLength: 1, maxLength: 160 },
    announcedOrigin: {
      type: "object",
      additionalProperties: false,
      properties: {
        surface: { type: "string", maxLength: 80 },
        appVersion: { type: "string", maxLength: 80 },
        os: { type: "string", maxLength: 120 },
        deviceType: { type: "string", maxLength: 80 },
        connectionMethod: { type: "string", maxLength: 40 },
      },
    },
    providers: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "version"],
        properties: {
          id: { type: "string", maxLength: 80 },
          version: { type: "string", maxLength: 40 },
        },
      },
    },
    connectedAt: { type: "string", maxLength: 80 },
  },
} as const;

/** `getCapabilities` reports per-op support plus the `listClientTargets` directory. */
const uiCapabilitiesOutput = (operations: readonly string[]) =>
  ({
    type: "object",
    additionalProperties: false,
    required: ["adapter", "operations", "clients"],
    properties: {
      adapter: { type: "string", maxLength: 64 },
      operations: {
        type: "object",
        additionalProperties: false,
        required: [...operations],
        properties: Object.fromEntries(operations.map((name) => [name, { type: "boolean" }])),
      },
      clients: { type: "array", maxItems: 64, items: uiClientTargetSchema },
    },
  }) as const;

export type UiThemeState = {
  readonly theme: string;
  readonly resolvedTheme: "light" | "dark";
  readonly systemDark: boolean;
  readonly followSystem: boolean;
  readonly appearanceMode: "light" | "dark" | "system";
  readonly themeHalves: { readonly light?: string; readonly dark?: string } | null;
  readonly effectiveTheme:
    | { readonly kind: "stored"; readonly theme: string }
    | { readonly kind: "session-overlay"; readonly theme: string; readonly writer: string }
    | {
        readonly kind: "external-preview";
        readonly tokens: Readonly<Record<string, string>>;
        readonly writer?: string;
      };
  readonly sessionOverlay: {
    readonly theme: string;
    readonly appearanceMode?: "light" | "dark" | "system";
    readonly themeHalves?: { readonly light?: string; readonly dark?: string };
    readonly writer: string;
  } | null;
};

export type UiThemeSetPreferenceInput = {
  readonly theme?: string;
  readonly appearanceMode?: "light" | "dark" | "system";
  readonly themeHalves?: { readonly light?: string; readonly dark?: string };
  readonly mode: "persist" | "session";
  readonly clear?: boolean;
};

export type UiTerminalAppearance = {
  readonly theme: {
    readonly background: string;
    readonly foreground: string;
    readonly cursor: string;
    readonly selectionBackground?: string;
  };
  readonly font: {
    readonly family?: string;
    readonly size?: number;
    readonly lineHeight?: number;
    readonly ligatures?: boolean;
  };
  readonly appearance: "light" | "dark";
};

export type UiCapabilities = {
  readonly adapter: string;
  readonly operations: Readonly<Record<string, boolean>>;
  readonly clients: readonly {
    readonly connectionId: string;
    readonly announcedOrigin?: {
      readonly surface?: string;
      readonly appVersion?: string;
      readonly os?: string;
      readonly deviceType?: string;
      readonly connectionMethod?: string;
    };
    readonly providers: readonly { readonly id: string; readonly version: string }[];
    readonly connectedAt: string;
  }[];
};

export const uiThemeApi = defineApi<{
  getCapabilities: { input: Record<string, never>; output: UiCapabilities };
  getState: { input: Record<string, never>; output: UiThemeState };
  getTokens: {
    input: { appearance?: "light" | "dark" };
    output: { tokens: Record<string, string>; cssVars: Record<string, string> };
  };
  setPreference: {
    input: UiThemeSetPreferenceInput;
    output: {
      applied: boolean;
      reason?: string;
      propagatedTo?: "storage-origin" | "connection";
    };
  };
  getTerminalAppearance: { input: Record<string, never>; output: UiTerminalAppearance };
}>({
  id: UI_THEME,
  version: "1.0.0",
  methods: [
    {
      name: "getCapabilities",
      effect: "read",
      requiredGrants: [],
      inputSchema: composerEmptyInputSchema,
      outputSchema: uiCapabilitiesOutput([
        "getState",
        "getTokens",
        "setPreference",
        "subscribeState",
        "getTerminalAppearance",
        "subscribeTerminalAppearance",
      ]),
    },
    {
      name: "getState",
      effect: "read",
      requiredGrants: [UI_THEME_READ],
      inputSchema: composerEmptyInputSchema,
      outputSchema: themeProviderStateSchema,
    },
    {
      name: "getTokens",
      effect: "read",
      requiredGrants: [UI_THEME_READ],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { appearance: { enum: ["light", "dark"] } },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["tokens", "cssVars"],
        properties: {
          tokens: { type: "object", additionalProperties: { type: "string", maxLength: 400 } },
          cssVars: { type: "object", additionalProperties: { type: "string", maxLength: 80 } },
        },
      },
    },
    {
      name: "setPreference",
      effect: "write",
      requiredGrants: [UI_THEME_WRITE],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["mode"],
        properties: {
          theme: { type: "string", minLength: 1, maxLength: 160 },
          appearanceMode: { enum: ["light", "dark", "system"] },
          themeHalves: themeHalvesSchema,
          mode: { enum: ["persist", "session"] },
          clear: { type: "boolean" },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["applied"],
        properties: {
          applied: { type: "boolean" },
          reason: { type: "string", maxLength: 200 },
          propagatedTo: { enum: ["storage-origin", "connection"] },
        },
      },
    },
    {
      name: "getTerminalAppearance",
      effect: "read",
      requiredGrants: [UI_THEME_READ],
      inputSchema: composerEmptyInputSchema,
      outputSchema: terminalAppearanceSchema,
    },
  ],
  streams: [
    {
      name: "subscribeState",
      inputSchema: composerEmptyInputSchema,
      eventSchema: themeProviderStateSchema,
      requiredGrants: [UI_THEME_READ],
    },
    {
      name: "subscribeTerminalAppearance",
      inputSchema: composerEmptyInputSchema,
      eventSchema: terminalAppearanceSchema,
      requiredGrants: [UI_THEME_READ],
    },
  ],
});

export const uiKeybindingsApi = defineApi<{
  getCapabilities: { input: Record<string, never>; output: UiCapabilities };
  registerCommands: {
    input: { commands: readonly GlobalCommandDescriptor[] };
    output: {
      commandSetToken: string;
      results: readonly {
        commandId: string;
        status: "registered" | "rejected";
        reason?: string;
      }[];
    };
  };
  unregisterCommands: {
    input: { commandSetToken: string };
    output: { unregistered: boolean };
  };
  listConflicts: {
    input: Record<string, never>;
    output: {
      conflicts: readonly {
        command: string;
        key: string;
        winner: "user" | "native" | "plugin";
        loser: string;
      }[];
    };
  };
}>({
  id: UI_KEYBINDINGS,
  version: UI_KEYBINDINGS_VERSION,
  methods: [
    {
      name: "getCapabilities",
      effect: "read",
      requiredGrants: [],
      inputSchema: composerEmptyInputSchema,
      outputSchema: uiCapabilitiesOutput([
        "registerCommands",
        "unregisterCommands",
        "listConflicts",
      ]),
    },
    {
      name: "registerCommands",
      effect: "write",
      requiredGrants: [UI_KEYBINDINGS],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["commands"],
        properties: {
          commands: {
            type: "array",
            minItems: 1,
            maxItems: 64,
            items: commandDescriptorSchema,
          },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["commandSetToken", "results"],
        properties: {
          commandSetToken: { type: "string", minLength: 1, maxLength: 160 },
          results: { type: "array", maxItems: 64, items: commandResultSchema },
        },
      },
    },
    {
      name: "unregisterCommands",
      effect: "write",
      requiredGrants: [UI_KEYBINDINGS],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["commandSetToken"],
        properties: {
          commandSetToken: { type: "string", minLength: 1, maxLength: 160 },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["unregistered"],
        properties: { unregistered: { type: "boolean" } },
      },
    },
    {
      name: "listConflicts",
      effect: "read",
      requiredGrants: [UI_KEYBINDINGS],
      inputSchema: composerEmptyInputSchema,
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["conflicts"],
        properties: {
          conflicts: {
            type: "array",
            maxItems: 256,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["command", "key", "winner", "loser"],
              properties: {
                command: { type: "string", maxLength: 256 },
                key: { type: "string", maxLength: 64 },
                winner: { enum: ["user", "native", "plugin"] },
                loser: { type: "string", maxLength: 256 },
              },
            },
          },
        },
      },
    },
  ],
});

/**
 * A keydown as the host keymap matches it: the `KeyboardEvent` fields its
 * resolver reads, so a live event passes as-is.
 */
export type UiKeybindingChord = {
  readonly key: string;
  readonly code?: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly getModifierState?: (key: "AltGraph") => boolean;
};

/**
 * The client-local half of `t3.ui/keybindings@1.1.0`, present on `ClientHost`
 * as `keybindings` for installations holding the `t3.ui/keybindings` grant.
 * Absence means the host predates 1.1.0 or the grant is missing — treat it
 * as "host-unavailable". Resolution runs in the renderer against the keymap
 * the client already holds, so it is synchronous (a keydown handler can act
 * on the answer before the event moves on) and never crosses the network.
 */
export interface UiKeybindingsHost {
  readonly id: typeof UI_KEYBINDINGS;
  readonly version: string;
  /**
   * The command the host's keydown dispatcher resolves `chord` to while a
   * terminal surface owns focus (`terminalFocus` true, every other `when`
   * key as the dispatcher currently sees it), or null when no user or
   * native rule claims the chord. This is the dispatcher's own resolver and
   * rule set, not a copy. Plugin `defaultKey`s are not rules — the host
   * dispatches those itself on a null answer.
   */
  resolveTerminalFocusKey(chord: UiKeybindingChord): string | null;
}

const uiNotificationActionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "label"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 80 },
    label: { type: "string", minLength: 1, maxLength: 80 },
    variant: { enum: ["default", "primary", "destructive"] },
  },
} as const;

export type UiNotificationInput = {
  readonly severity: "info" | "success" | "warning" | "error" | "loading";
  readonly title: string;
  readonly body?: string;
  readonly threadId?: string;
  readonly projectId?: string;
  readonly anchor?: "global" | "thread";
  readonly dismissible?: boolean;
  readonly durationMs?: number;
  readonly actions?: readonly {
    readonly id: string;
    readonly label: string;
    readonly variant?: "default" | "primary" | "destructive";
  }[];
};

export const uiNotificationsApi = defineApi<{
  getCapabilities: { input: Record<string, never>; output: UiCapabilities };
  notify: { input: UiNotificationInput; output: { notificationId: string } };
  update: {
    input: {
      notificationId: string;
      severity?: UiNotificationInput["severity"];
      title?: string;
      body?: string;
      dismissible?: boolean;
    };
    output: { applied: boolean };
  };
  dismiss: { input: { notificationId: string }; output: { dismissed: boolean } };
  awaitAction: {
    input: { notificationId: string };
    output: { actionId: string } | { dismissed: true };
  };
}>({
  id: "t3.ui/notifications",
  version: "1.0.0",
  methods: [
    {
      name: "getCapabilities",
      effect: "read",
      requiredGrants: [],
      inputSchema: composerEmptyInputSchema,
      outputSchema: uiCapabilitiesOutput(["notify", "update", "dismiss", "awaitAction"]),
    },
    {
      name: "notify",
      effect: "write",
      requiredGrants: [UI_NOTIFY],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "title"],
        properties: {
          severity: { enum: ["info", "success", "warning", "error", "loading"] },
          title: { type: "string", minLength: 1, maxLength: 200 },
          body: { type: "string", maxLength: 2000 },
          threadId: { type: "string", maxLength: 128 },
          projectId: { type: "string", maxLength: 128 },
          anchor: { enum: ["global", "thread"] },
          dismissible: { type: "boolean" },
          durationMs: { type: "integer", minimum: 0, maximum: 60_000 },
          actions: { type: "array", maxItems: 3, items: uiNotificationActionSchema },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["notificationId"],
        properties: { notificationId: { type: "string", minLength: 1, maxLength: 160 } },
      },
    },
    {
      name: "update",
      effect: "write",
      requiredGrants: [UI_NOTIFY],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["notificationId"],
        properties: {
          notificationId: { type: "string", minLength: 1, maxLength: 160 },
          severity: { enum: ["info", "success", "warning", "error", "loading"] },
          title: { type: "string", minLength: 1, maxLength: 200 },
          body: { type: "string", maxLength: 2000 },
          dismissible: { type: "boolean" },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["applied"],
        properties: { applied: { type: "boolean" } },
      },
    },
    {
      name: "dismiss",
      effect: "write",
      requiredGrants: [UI_NOTIFY],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["notificationId"],
        properties: { notificationId: { type: "string", minLength: 1, maxLength: 160 } },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["dismissed"],
        properties: { dismissed: { type: "boolean" } },
      },
    },
    {
      name: "awaitAction",
      effect: "read",
      requiredGrants: [UI_NOTIFY],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["notificationId"],
        properties: { notificationId: { type: "string", minLength: 1, maxLength: 160 } },
      },
      outputSchema: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["actionId"],
            properties: { actionId: { type: "string", minLength: 1, maxLength: 80 } },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["dismissed"],
            properties: { dismissed: { const: true } },
          },
        ],
      },
    },
  ],
});

export const uiPanelsApi = defineApi<{
  getCapabilities: { input: Record<string, never>; output: UiCapabilities };
  openSurface: {
    input: {
      surfaceId: string;
      title?: string;
      placement?: "side-panel" | "bottom-dock";
      threadId?: string;
    };
    output: { surfaceId: string };
  };
  activateSurface: {
    input: { surfaceId: string; threadId?: string };
    output: { applied: boolean };
  };
  closeSurface: {
    input: { surfaceId: string; threadId?: string };
    output: { applied: boolean };
  };
  listSurfaces: {
    input: { threadId: string };
    output: {
      surfaces: readonly {
        id: string;
        title: string;
        placement: "side-panel" | "bottom-dock";
        active: boolean;
      }[];
    };
  };
  hideDock: { input: { threadId: string }; output: { applied: boolean } };
  showDock: { input: { threadId: string }; output: { applied: boolean } };
}>({
  id: "t3.ui/panels",
  version: "1.0.0",
  methods: [
    {
      name: "getCapabilities",
      effect: "read",
      requiredGrants: [],
      inputSchema: composerEmptyInputSchema,
      outputSchema: uiCapabilitiesOutput([
        "openSurface",
        "activateSurface",
        "closeSurface",
        "listSurfaces",
        "hideDock",
        "showDock",
      ]),
    },
    {
      name: "openSurface",
      effect: "write",
      requiredGrants: [UI_PANELS],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["surfaceId"],
        properties: {
          surfaceId: { type: "string", minLength: 1, maxLength: 160 },
          title: { type: "string", minLength: 1, maxLength: 200 },
          placement: { enum: ["side-panel", "bottom-dock"] },
          threadId: { type: "string", maxLength: 128 },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["surfaceId"],
        properties: { surfaceId: { type: "string", maxLength: 160 } },
      },
    },
    {
      name: "activateSurface",
      effect: "write",
      requiredGrants: [UI_PANELS],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["surfaceId"],
        properties: {
          surfaceId: { type: "string", minLength: 1, maxLength: 160 },
          threadId: { type: "string", maxLength: 128 },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["applied"],
        properties: { applied: { type: "boolean" } },
      },
    },
    {
      name: "closeSurface",
      effect: "write",
      requiredGrants: [UI_PANELS],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["surfaceId"],
        properties: {
          surfaceId: { type: "string", minLength: 1, maxLength: 160 },
          threadId: { type: "string", maxLength: 128 },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["applied"],
        properties: { applied: { type: "boolean" } },
      },
    },
    {
      name: "listSurfaces",
      effect: "read",
      requiredGrants: [UI_PANELS],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["threadId"],
        properties: { threadId: { type: "string", minLength: 1, maxLength: 128 } },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["surfaces"],
        properties: {
          surfaces: {
            type: "array",
            maxItems: 64,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "title", "placement", "active"],
              properties: {
                id: { type: "string", maxLength: 160 },
                title: { type: "string", maxLength: 200 },
                placement: { enum: ["side-panel", "bottom-dock"] },
                active: { type: "boolean" },
              },
            },
          },
        },
      },
    },
    {
      name: "hideDock",
      effect: "write",
      requiredGrants: [UI_PANELS],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["threadId"],
        properties: { threadId: { type: "string", minLength: 1, maxLength: 128 } },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["applied"],
        properties: { applied: { type: "boolean" } },
      },
    },
    {
      name: "showDock",
      effect: "write",
      requiredGrants: [UI_PANELS],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["threadId"],
        properties: { threadId: { type: "string", minLength: 1, maxLength: 128 } },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["applied"],
        properties: { applied: { type: "boolean" } },
      },
    },
  ],
});

export const UI_THEME_API = uiThemeApi.definition;
export const UI_KEYBINDINGS_API = uiKeybindingsApi.definition;
export const UI_NOTIFICATIONS_API = uiNotificationsApi.definition;
export const UI_PANELS_API = uiPanelsApi.definition;

/**
 * Contracts only: their presence does not advertise a functioning or
 * authorized provider. Shared ids may hold multiple frozen versions (newest
 * first); providers must match one of them canonically.
 */
export const orchestrationStatusApi = defineOrchestrationStatusApi(vcsDiffPreviewStreamEventSchema);
export const ORCHESTRATION_STATUS_API = orchestrationStatusApi.definition;

export const GENERIC_API_CATALOGUE: readonly ApiDefinition[] = [
  orchestrationStatusApi.definition,
  orchestrationControlApi.definition,
  browserLocalServersApi.definition,
  browserSessionsApi.definition,
  browserFramesApi.definition,
  workspaceFilesApi.definition,
  workspaceTreeApi.definition,
  workspaceSearchApi.definition,
  workspaceChangesApi.definition,
  textEditsApi.definition,
  textEditsApiV1.definition,
  filePresentationApi.definition,
  terminalSessionsApi.definition,
  terminalOutputApi.definition,
  terminalOutputEventsApi.definition,
  terminalSessionsApiV1.definition,
  terminalControlApi.definition,
  vcsStatusApi.definition,
  vcsRefsApi.definition,
  vcsChangesApi.definition,
  vcsDiffApi.definition,
  vcsRepositoryApi.definition,
  vcsRepositoryApiV1.definition,
  vcsDiffApiV1.definition,
  vcsActionsApi.definition,
  resourcesLeaseApi.definition,
  resourcesLeaseApiV1.definition,
  workspaceResourcesApi.definition,
  prsReadApi.definition,
  prsWriteApi.definition,
  composerContextApi.definition,
  messagesEnrichmentApi.definition,
  uiThemeApi.definition,
  uiKeybindingsApi.definition,
  uiNotificationsApi.definition,
  uiPanelsApi.definition,
];
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => JSON.stringify(key) + ":" + canonical(child))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function assertProvidedApiOwner(pluginId: string, definition: ApiDefinition): void {
  if (definition.id.startsWith(pluginId + "/")) return;
  const owned = GENERIC_API_CATALOGUE.some(
    (item) => item.id === definition.id && canonical(item) === canonical(definition),
  );
  if (!owned) throw new Error("Foreign API namespace or incompatible shared API contract");
}

export const WORKSPACE_FILES_API = workspaceFilesApi.definition;
export const WORKSPACE_SEARCH_API = workspaceSearchApi.definition;
export const WORKSPACE_CHANGES_API = workspaceChangesApi.definition;
export const FILE_PRESENTATION_API = filePresentationApi.definition;
export const TERMINAL_SESSIONS_API = terminalSessionsApi.definition;
export const TERMINAL_SESSIONS_API_V1 = terminalSessionsApiV1.definition;

export const TERMINAL_OUTPUT_API = terminalOutputApi.definition;
export const TERMINAL_OUTPUT_EVENTS_API = terminalOutputEventsApi.definition;
export const TERMINAL_CONTROL_API = terminalControlApi.definition;
