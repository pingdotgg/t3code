import { validateApiDefinition, type ApiDefinition } from "./capabilities.js";
import {
  browserMiniPlayerInputProperties,
  browserMiniPlayerStateSchema,
  composerPreviewAnnotationResultSchema,
} from "./browserPresentation.js";

/**
 * Private `t3.client/*` client-provider area definitions.
 *
 * These are host-owned ambient providers (theme, notifications, keybindings,
 * panels, composer, terminal appearance, preferences, external open, browser
 * history, navigation) reached only through the
 * client-provider connect stream — never registered with the public API
 * broker, never discoverable, never grantable, and never plugin-provided.
 *
 * Every op input carries `target`: `{kind:"self"}` (the caller's own
 * connection, verified against the authenticated session) or
 * `{kind:"connection", connectionId}` (explicit, root-authority callers only).
 * The field is adapter-set — plugin envelopes never carry it. The connect
 * stream delivers the frame to the resolved socket; providers may ignore it.
 */

const targetSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: { enum: ["self", "connection"] },
    connectionId: { type: "string", minLength: 1, maxLength: 160 },
  },
} as const;

const withTarget = (properties: Record<string, unknown>, required: string[] = []) =>
  ({
    type: "object",
    additionalProperties: false,
    required: ["target", ...required],
    properties: { target: targetSchema, ...properties },
  }) as const;

const okOutput = {
  type: "object",
  additionalProperties: false,
  required: ["applied"],
  properties: { applied: { type: "boolean" } },
} as const;

const themeAppearance = { enum: ["light", "dark"] } as const;
export const themeHalvesSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    light: { type: "string", maxLength: 160 },
    dark: { type: "string", maxLength: 160 },
  },
} as const;

/**
 * What the theme provider reports: the stored-preference snapshot plus the
 * provider-owned session overlay and the actually-painted effective theme.
 */
export const themeProviderStateSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "theme",
    "resolvedTheme",
    "systemDark",
    "followSystem",
    "appearanceMode",
    "themeHalves",
    "effectiveTheme",
    "sessionOverlay",
  ],
  properties: {
    theme: { type: "string", maxLength: 160 },
    resolvedTheme: themeAppearance,
    systemDark: { type: "boolean" },
    followSystem: { type: "boolean" },
    appearanceMode: { enum: ["light", "dark", "system"] },
    themeHalves: { anyOf: [themeHalvesSchema, { type: "null" }] },
    effectiveTheme: {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: { enum: ["stored", "session-overlay", "external-preview"] },
        theme: { type: "string", maxLength: 160 },
        writer: { type: "string", maxLength: 160 },
        tokens: {
          type: "object",
          additionalProperties: { type: "string", maxLength: 400 },
        },
      },
    },
    sessionOverlay: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["theme", "writer"],
          properties: {
            theme: { type: "string", maxLength: 160 },
            appearanceMode: { enum: ["light", "dark", "system"] },
            themeHalves: themeHalvesSchema,
            writer: { type: "string", minLength: 1, maxLength: 160 },
          },
        },
        { type: "null" },
      ],
    },
  },
} as const;

const themeTokensOutput = {
  type: "object",
  additionalProperties: false,
  required: ["tokens", "cssVars"],
  properties: {
    tokens: { type: "object", additionalProperties: { type: "string", maxLength: 400 } },
    cssVars: { type: "object", additionalProperties: { type: "string", maxLength: 80 } },
  },
} as const;

export const terminalAppearanceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["theme", "font", "appearance"],
  properties: {
    theme: {
      type: "object",
      additionalProperties: false,
      required: ["background", "foreground", "cursor"],
      properties: {
        background: { type: "string", maxLength: 400 },
        foreground: { type: "string", maxLength: 400 },
        cursor: { type: "string", maxLength: 400 },
        selectionBackground: { type: "string", maxLength: 400 },
      },
    },
    font: {
      type: "object",
      additionalProperties: false,
      properties: {
        family: { type: "string", maxLength: 400 },
        size: { type: "number", minimum: 1, maximum: 128 },
        lineHeight: { type: "number", minimum: 0.1, maximum: 10 },
        ligatures: { type: "boolean" },
      },
    },
    appearance: themeAppearance,
  },
} as const;

export const CLIENT_THEME_API = validateApiDefinition({
  id: "t3.client/theme",
  version: "1.0.0",
  methods: [
    {
      name: "getState",
      effect: "read",
      requiredGrants: [],
      inputSchema: withTarget({}),
      outputSchema: themeProviderStateSchema,
    },
    {
      name: "resolveTokens",
      effect: "read",
      requiredGrants: [],
      inputSchema: withTarget({ appearance: themeAppearance }),
      outputSchema: themeTokensOutput,
    },
    {
      name: "applyPreference",
      effect: "write",
      requiredGrants: [],
      inputSchema: withTarget(
        {
          writer: { type: "string", minLength: 1, maxLength: 160 },
          preference: {
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
        },
        ["writer", "preference"],
      ),
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
  ],
  streams: [
    {
      name: "watchState",
      inputSchema: withTarget({}),
      eventSchema: themeProviderStateSchema,
      requiredGrants: [],
    },
  ],
});

export const notificationActionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "label"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 80 },
    label: { type: "string", minLength: 1, maxLength: 80 },
    variant: { enum: ["default", "primary", "destructive"] },
    keepOpen: { type: "boolean" },
  },
} as const;

/** `keepOpen` actions and `flashAction` need a 1.1.0 client. */
export const CLIENT_NOTIFICATIONS_V11_RANGE = "^1.1.0";

const notificationBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["notificationId", "severity", "title"],
  properties: {
    notificationId: { type: "string", minLength: 1, maxLength: 160 },
    severity: { enum: ["info", "success", "warning", "error", "loading"] },
    title: { type: "string", minLength: 1, maxLength: 200 },
    body: { type: "string", maxLength: 2000 },
    threadId: { type: "string", maxLength: 128 },
    projectId: { type: "string", maxLength: 128 },
    anchor: { enum: ["global", "thread"] },
    dismissible: { type: "boolean" },
    durationMs: { type: "integer", minimum: 0, maximum: 60_000 },
    actions: {
      type: "array",
      maxItems: 3,
      items: notificationActionSchema,
    },
  },
} as const;

export const CLIENT_NOTIFICATIONS_API = validateApiDefinition({
  id: "t3.client/notifications",
  version: "1.1.0",
  methods: [
    {
      name: "notify",
      effect: "write",
      requiredGrants: [],
      inputSchema: withTarget({ notification: notificationBodySchema }, ["notification"]),
      outputSchema: okOutput,
    },
    {
      name: "update",
      effect: "write",
      requiredGrants: [],
      inputSchema: withTarget(
        {
          notificationId: { type: "string", minLength: 1, maxLength: 160 },
          patch: {
            type: "object",
            additionalProperties: false,
            properties: {
              severity: { enum: ["info", "success", "warning", "error", "loading"] },
              title: { type: "string", minLength: 1, maxLength: 200 },
              body: { type: "string", maxLength: 2000 },
              dismissible: { type: "boolean" },
              flashAction: {
                type: "object",
                additionalProperties: false,
                required: ["actionId", "label", "durationMs"],
                properties: {
                  actionId: { type: "string", minLength: 1, maxLength: 80 },
                  label: { type: "string", minLength: 1, maxLength: 80 },
                  durationMs: { type: "integer", minimum: 0, maximum: 10_000 },
                },
              },
            },
          },
        },
        ["notificationId", "patch"],
      ),
      outputSchema: okOutput,
    },
    {
      name: "dismiss",
      effect: "write",
      requiredGrants: [],
      inputSchema: withTarget(
        { notificationId: { type: "string", minLength: 1, maxLength: 160 } },
        ["notificationId"],
      ),
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["dismissed"],
        properties: { dismissed: { type: "boolean" } },
      },
    },
  ],
});

export const commandDescriptorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "title", "scope"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 80 },
    title: { type: "string", minLength: 1, maxLength: 200 },
    description: { type: "string", maxLength: 1000 },
    defaultKey: {
      oneOf: [
        { type: "string", minLength: 1, maxLength: 64 },
        {
          type: "array",
          minItems: 1,
          maxItems: 4,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 64 },
        },
      ],
    },
    defaultKeyLogicalOnly: { type: "boolean" },
    when: { type: "string", minLength: 1, maxLength: 256 },
    scope: { enum: ["surface", "thread", "global"] },
    activation: {
      type: "object",
      additionalProperties: false,
      required: ["surfaceId", "placement"],
      properties: {
        surfaceId: { type: "string", minLength: 1, maxLength: 160 },
        placement: { enum: ["side-panel", "bottom-dock"] },
      },
    },
  },
} as const;

export const commandResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["commandId", "status"],
  properties: {
    commandId: { type: "string", minLength: 1, maxLength: 80 },
    status: { enum: ["registered", "rejected"] },
    reason: { type: "string", maxLength: 400 },
  },
} as const;

export const CLIENT_KEYBINDINGS_API = validateApiDefinition({
  id: "t3.client/keybindings",
  version: "1.0.0",
  methods: [
    {
      name: "registerCommands",
      effect: "write",
      requiredGrants: [],
      inputSchema: withTarget(
        {
          installationScoped: { type: "boolean" },
          commands: {
            type: "array",
            minItems: 1,
            maxItems: 64,
            items: commandDescriptorSchema,
          },
        },
        ["commands"],
      ),
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
      requiredGrants: [],
      inputSchema: withTarget(
        { commandSetToken: { type: "string", minLength: 1, maxLength: 160 } },
        ["commandSetToken"],
      ),
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
      requiredGrants: [],
      inputSchema: withTarget({}),
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

const panelThreadInput = {
  threadId: { type: "string", minLength: 1, maxLength: 128 },
} as const;

export const CLIENT_PANELS_API = validateApiDefinition({
  id: "t3.client/panels",
  version: "1.1.0",
  methods: [
    {
      name: "getCapabilities",
      effect: "read",
      requiredGrants: [],
      inputSchema: withTarget({}),
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["browserMiniPlayer"],
        properties: { browserMiniPlayer: { type: "boolean" } },
      },
    },
    {
      name: "getBrowserMiniPlayer",
      effect: "read",
      requiredGrants: [],
      inputSchema: withTarget({ ...panelThreadInput }, ["threadId"]),
      outputSchema: browserMiniPlayerStateSchema,
    },
    {
      name: "setBrowserMiniPlayer",
      effect: "write",
      requiredGrants: [],
      inputSchema: withTarget({ ...panelThreadInput, ...browserMiniPlayerInputProperties }, [
        "threadId",
        "tabId",
        "serverEpoch",
        "open",
      ]),
      outputSchema: browserMiniPlayerStateSchema,
    },
    {
      name: "openSurface",
      effect: "write",
      requiredGrants: [],
      inputSchema: withTarget(
        {
          surfaceId: { type: "string", minLength: 1, maxLength: 160 },
          title: { type: "string", minLength: 1, maxLength: 200 },
          placement: { enum: ["side-panel", "bottom-dock"] },
          ...panelThreadInput,
        },
        // Optional fields mirror the public contract: the client fills them
        // from the surface's own declared metadata when omitted.
        ["surfaceId", "threadId"],
      ),
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
      requiredGrants: [],
      inputSchema: withTarget(
        {
          surfaceId: { type: "string", minLength: 1, maxLength: 160 },
          ...panelThreadInput,
        },
        ["surfaceId", "threadId"],
      ),
      outputSchema: okOutput,
    },
    {
      name: "closeSurface",
      effect: "write",
      requiredGrants: [],
      inputSchema: withTarget(
        {
          surfaceId: { type: "string", minLength: 1, maxLength: 160 },
          ...panelThreadInput,
        },
        ["surfaceId", "threadId"],
      ),
      outputSchema: okOutput,
    },
    {
      name: "listSurfaces",
      effect: "read",
      requiredGrants: [],
      inputSchema: withTarget({ ...panelThreadInput }, ["threadId"]),
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
      requiredGrants: [],
      inputSchema: withTarget({ ...panelThreadInput }, ["threadId"]),
      outputSchema: okOutput,
    },
    {
      name: "showDock",
      effect: "write",
      requiredGrants: [],
      inputSchema: withTarget({ ...panelThreadInput }, ["threadId"]),
      outputSchema: okOutput,
    },
  ],
});

const composerRefSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: 512 },
    startLine: { type: "integer", minimum: 1, maximum: 1_000_000 },
    endLine: { type: "integer", minimum: 1, maximum: 1_000_000 },
    excerpt: { type: "string", maxLength: 512 },
  },
} as const;

// Both annotation variants the public t3.messages/enrichment@1.1.0 accepts;
// `kind` absent is the 1.0.0 file comment, `kind: "diff"` the review comment.
const composerAnnotationSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["filePath", "startLine", "endLine", "body"],
      properties: {
        filePath: { type: "string", minLength: 1, maxLength: 512 },
        startLine: { type: "integer", minimum: 1, maximum: 1_000_000 },
        endLine: { type: "integer", minimum: 1, maximum: 1_000_000 },
        body: { type: "string", minLength: 1, maxLength: 4096 },
        excerpt: { type: "string", maxLength: 4096 },
      },
    },
    {
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
        selection: {
          type: "object",
          additionalProperties: false,
          required: ["start", "side", "end", "endSide"],
          properties: {
            start: { type: "integer", minimum: 1, maximum: 1_000_000 },
            side: { enum: ["additions", "deletions"] },
            end: { type: "integer", minimum: 1, maximum: 1_000_000 },
            endSide: { enum: ["additions", "deletions"] },
          },
        },
        startIndex: { type: "integer", minimum: 0, maximum: 1_000_000 },
        endIndex: { type: "integer", minimum: 0, maximum: 1_000_000 },
        body: { type: "string", minLength: 1, maxLength: 4096 },
      },
    },
  ],
} as const;

const composerThreadIdInput = {
  threadId: { type: "string", minLength: 1, maxLength: 128 },
} as const;
// Mirrors the catalogue's BROWSER_CAPTURE_ARTIFACT_REF_PATTERN; importing the
// catalogue here would close a module cycle. A test pins the two equal.
const BROWSER_CAPTURE_ARTIFACT_REF_PATTERN =
  "^pending-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

/**
 * Bound on the comment text `listAnnotations` returns when asked (1.2.0 public,
 * 1.3.0 seam): a preview, so eight entries at every field maximum still fit
 * the 64 KiB frame envelope. The composer chip holds the whole comment.
 */
export const LISTED_ANNOTATION_TEXT_MAX = 160;

/**
 * `getAnnotation`'s answer: one own comment's whole text. Attached bodies
 * are at most 4,096 units, so even a body that JSON-escapes every unit to six
 * bytes (~24 KiB) fits the 64 KiB frame envelope.
 */
export const annotationTextSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["found", "text"],
      properties: { found: { const: true }, text: { type: "string", maxLength: 4096 } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["found"],
      properties: { found: { const: false } },
    },
  ],
} as const;

/** `listAnnotations` `include`: the optional members a caller asks for. */
export const listAnnotationsIncludeSchema = {
  type: "array",
  maxItems: 1,
  uniqueItems: true,
  items: { enum: ["text"] },
} as const;

export const CLIENT_COMPOSER_API = validateApiDefinition({
  id: "t3.client/composer",
  version: "1.4.0",
  methods: [
    {
      name: "insertPreviewAnnotation",
      effect: "write",
      requiredGrants: [],
      inputSchema: withTarget(
        {
          ...composerThreadIdInput,
          annotationRef: { type: "string", minLength: 1, maxLength: 128 },
        },
        ["threadId", "annotationRef"],
      ),
      outputSchema: composerPreviewAnnotationResultSchema,
    },
    {
      name: "insertContext",
      effect: "write",
      requiredGrants: [],
      inputSchema: withTarget(
        {
          threadId: { type: "string", minLength: 1, maxLength: 128 },
          refs: { type: "array", minItems: 1, maxItems: 8, items: composerRefSchema },
        },
        ["threadId", "refs"],
      ),
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
      requiredGrants: [],
      inputSchema: withTarget({ threadId: { type: "string", minLength: 1, maxLength: 128 } }, [
        "threadId",
      ]),
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["draft"],
        properties: {
          draft: {
            type: ["object", "null"],
            properties: {
              prompt: { type: "string", maxLength: 10000 },
              promptTruncated: { type: "boolean" },
              contextCounts: { type: "object" },
            },
          },
        },
      },
    },
    {
      name: "attachAnnotation",
      effect: "write",
      requiredGrants: [],
      inputSchema: withTarget(
        {
          ...composerThreadIdInput,
          annotation: composerAnnotationSchema,
        },
        ["threadId", "annotation"],
      ),
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["annotationId"],
        properties: { annotationId: { type: "string", minLength: 1, maxLength: 256 } },
      },
    },
    {
      name: "insertMention",
      effect: "write",
      requiredGrants: [],
      inputSchema: withTarget(
        {
          ...composerThreadIdInput,
          paths: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: { type: "string", minLength: 1, maxLength: 512 },
          },
        },
        ["threadId", "paths"],
      ),
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
      name: "insertTerminalContext",
      effect: "write",
      requiredGrants: [],
      inputSchema: withTarget(
        {
          ...composerThreadIdInput,
          terminalId: { type: "string", minLength: 1, maxLength: 128 },
          terminalLabel: { type: "string", minLength: 1, maxLength: 128 },
          // 10,000 chars keeps the worst-case escaped frame inside the 64 KiB
          // broker envelope; matches the public catalogue bound.
          lineStart: { type: "integer", minimum: 1, maximum: 1_000_000 },
          lineEnd: { type: "integer", minimum: 1, maximum: 1_000_000 },
          text: { type: "string", minLength: 1, maxLength: 10000 },
        },
        ["threadId", "terminalId", "terminalLabel", "lineStart", "lineEnd", "text"],
      ),
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["inserted", "target"],
        properties: {
          inserted: { type: "boolean" },
          target: { type: "string", minLength: 1, maxLength: 256 },
          reason: { type: "string", maxLength: 64 },
        },
      },
    },
    {
      name: "insertImage",
      effect: "write",
      requiredGrants: [],
      inputSchema: withTarget(
        {
          ...composerThreadIdInput,
          artifactRef: {
            type: "string",
            maxLength: 128,
            pattern: BROWSER_CAPTURE_ARTIFACT_REF_PATTERN,
          },
          name: { type: "string", minLength: 1, maxLength: 128 },
        },
        ["threadId", "artifactRef"],
      ),
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["inserted", "target"],
        properties: {
          inserted: { type: "boolean" },
          target: { type: "string", minLength: 1, maxLength: 256 },
        },
      },
    },
    {
      name: "listAnnotations",
      effect: "read",
      requiredGrants: [],
      inputSchema: withTarget({ ...composerThreadIdInput, include: listAnnotationsIncludeSchema }, [
        "threadId",
      ]),
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["annotations"],
        properties: {
          annotations: {
            type: "array",
            // 8 entries at field maxima stay inside the 64 KiB frame envelope.
            maxItems: 8,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["annotationId", "kind", "filePath", "rangeLabel", "sectionTitle"],
              properties: {
                annotationId: { type: "string", minLength: 1, maxLength: 256 },
                kind: { enum: ["file", "diff"] },
                filePath: { type: "string", minLength: 1, maxLength: 512 },
                rangeLabel: { type: "string", maxLength: 128 },
                sectionTitle: { type: "string", maxLength: 256 },
                // 1.3.0, only when `include` asks for it.
                text: { type: "string", maxLength: LISTED_ANNOTATION_TEXT_MAX },
                textTruncated: { type: "boolean" },
              },
            },
          },
        },
      },
    },
    {
      name: "removeAnnotation",
      effect: "write",
      requiredGrants: [],
      inputSchema: withTarget(
        {
          ...composerThreadIdInput,
          annotationId: { type: "string", minLength: 1, maxLength: 256 },
        },
        ["threadId", "annotationId"],
      ),
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["removed"],
        properties: { removed: { type: "boolean" } },
      },
    },
    {
      // 1.3.0: one own comment's whole text.
      name: "getAnnotation",
      effect: "read",
      requiredGrants: [],
      inputSchema: withTarget(
        {
          ...composerThreadIdInput,
          annotationId: { type: "string", minLength: 1, maxLength: 256 },
        },
        ["threadId", "annotationId"],
      ),
      outputSchema: annotationTextSchema,
    },
  ],
});

export const CLIENT_TERMINAL_APPEARANCE_API = validateApiDefinition({
  id: "t3.client/terminal-appearance",
  version: "1.0.0",
  methods: [
    {
      name: "getAppearance",
      effect: "read",
      requiredGrants: [],
      inputSchema: withTarget({}),
      outputSchema: terminalAppearanceSchema,
    },
  ],
  streams: [
    {
      name: "watchAppearance",
      inputSchema: withTarget({}),
      eventSchema: terminalAppearanceSchema,
      requiredGrants: [],
    },
  ],
});

/**
 * The client-settings projection packs may read. Deliberately a named subset
 * of the host's persisted client settings, not a pass-through: each key lands
 * here only when a pack has a native-parity use for it.
 */
export const clientPreferencesSchema = {
  type: "object",
  additionalProperties: false,
  required: ["wordWrap"],
  properties: {
    wordWrap: { type: "boolean" },
    // 1.1.0 and 1.2.0 respectively, and only when the server asks (`include`).
    renderBrowserFile: { type: "boolean" },
    fileExplorerOpen: { type: "boolean" },
  },
} as const;

/**
 * Later keys a server asks for. An older server validates answers against its
 * closed shapes, so a client includes a key only when asked; a server asks
 * for `renderBrowserFile` only a client satisfying
 * `CLIENT_PREFERENCES_V11_RANGE`, and for `fileExplorerOpen` only one
 * satisfying `CLIENT_PREFERENCES_V12_RANGE`.
 */
const preferencesIncludeProperty = {
  include: {
    type: "array",
    maxItems: 2,
    uniqueItems: true,
    items: { enum: ["renderBrowserFile", "fileExplorerOpen"] },
  },
} as const;

/** The range that carries `renderBrowserFile` and `include`. */
export const CLIENT_PREFERENCES_V11_RANGE = "^1.1.0";

/** The range that carries `fileExplorerOpen`. */
export const CLIENT_PREFERENCES_V12_RANGE = "^1.2.0";

/** The writable subset of `clientPreferencesSchema`. */
export const clientPreferencesPatchSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    wordWrap: { type: "boolean" },
    renderBrowserFile: { type: "boolean" },
    fileExplorerOpen: { type: "boolean" },
  },
} as const;

/** Write receipt: the outcome plus the preferences the client now holds. */
export const clientPreferencesReceiptSchema = {
  type: "object",
  additionalProperties: false,
  required: ["applied", "preferences"],
  properties: {
    applied: { type: "boolean" },
    reason: { type: "string", maxLength: 200 },
    preferences: clientPreferencesSchema,
  },
} as const;

export const CLIENT_PREFERENCES_API = validateApiDefinition({
  id: "t3.client/preferences",
  version: "1.2.0",
  methods: [
    {
      name: "getPreferences",
      effect: "read",
      requiredGrants: [],
      inputSchema: withTarget(preferencesIncludeProperty),
      outputSchema: clientPreferencesSchema,
    },
    {
      name: "applyPreferences",
      effect: "write",
      requiredGrants: [],
      inputSchema: withTarget(
        {
          writer: { type: "string", minLength: 1, maxLength: 160 },
          patch: clientPreferencesPatchSchema,
          ...preferencesIncludeProperty,
        },
        ["writer", "patch"],
      ),
      outputSchema: clientPreferencesReceiptSchema,
    },
  ],
  streams: [
    {
      name: "watchPreferences",
      inputSchema: withTarget(preferencesIncludeProperty),
      eventSchema: clientPreferencesSchema,
      requiredGrants: [],
    },
  ],
});

/** The `t3.ui/external` open receipt, shared by the public and private areas. */
export const uiExternalOpenReceiptSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "url", "opener"],
      properties: {
        status: { const: "opened" },
        url: { type: "string", minLength: 1, maxLength: 4096 },
        opener: { enum: ["desktop-shell", "browser-window"] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "reason"],
      properties: {
        status: { const: "refused" },
        reason: { enum: ["invalid-url", "scheme-not-allowed", "opener-refused"] },
      },
    },
  ],
} as const;

/**
 * The `t3.ui/external` link receipt (1.1.0 `openLink`), shared by the public
 * and private areas: the open receipt plus `in-app-browser` for a link the
 * user's "Open links in" setting sent to the thread's preview browser.
 */
export const uiExternalLinkReceiptSchema = {
  oneOf: [
    {
      ...uiExternalOpenReceiptSchema.oneOf[0],
      properties: {
        ...uiExternalOpenReceiptSchema.oneOf[0].properties,
        opener: { enum: ["desktop-shell", "browser-window", "in-app-browser"] },
      },
    },
    uiExternalOpenReceiptSchema.oneOf[1],
  ],
} as const;

/** `openLink` input: the URL and the Cmd/Ctrl-click escape to the system browser. */
export const uiExternalLinkInputProperties = {
  url: { type: "string", minLength: 1, maxLength: 2048 },
  forceSystem: { type: "boolean" },
} as const;

/**
 * Backs `t3.ui/external`. The adapter forwards only URLs that already passed
 * `checkExternalUrl`; the client re-checks before reaching its OS opener.
 * `openLink` (1.1.0) routes by the client's own "Open links in" setting; the
 * adapter sends it only to a client satisfying `CLIENT_EXTERNAL_V11_RANGE`.
 */
export const CLIENT_EXTERNAL_API = validateApiDefinition({
  id: "t3.client/external",
  version: "1.1.0",
  methods: [
    {
      name: "open",
      effect: "write",
      requiredGrants: [],
      inputSchema: withTarget({ url: { type: "string", minLength: 1, maxLength: 4096 } }, ["url"]),
      outputSchema: uiExternalOpenReceiptSchema,
    },
    {
      name: "openLink",
      effect: "write",
      requiredGrants: [],
      inputSchema: withTarget(uiExternalLinkInputProperties, ["url"]),
      outputSchema: uiExternalLinkReceiptSchema,
    },
  ],
});

/** The external range that carries `openLink`. */
export const CLIENT_EXTERNAL_V11_RANGE = "^1.1.0";

/** The `t3.ui/editor` open receipt, shared by the public and private areas. */
export const uiEditorOpenReceiptSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "path", "editor"],
      properties: {
        status: { const: "opened" },
        path: { type: "string", minLength: 1, maxLength: 4096 },
        editor: { type: "string", minLength: 1, maxLength: 64 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "reason", "message"],
      properties: {
        status: { const: "refused" },
        reason: { enum: ["no-editor", "open-failed"] },
        message: { type: "string", maxLength: 1024 },
      },
    },
  ],
} as const;

const editorPathInput = {
  path: { type: "string", minLength: 1, maxLength: 4096 },
  cwd: { type: "string", minLength: 1, maxLength: 4096 },
} as const;

export const uiEditorOpenReceiptV11Schema = {
  oneOf: [
    {
      ...uiEditorOpenReceiptSchema.oneOf[0],
      properties: {
        ...uiEditorOpenReceiptSchema.oneOf[0].properties,
        url: { type: "string", minLength: 1, maxLength: 16384 },
      },
    },
    uiEditorOpenReceiptSchema.oneOf[1],
  ],
} as const;

export const editorWorkspaceInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    ...editorPathInput,
    workspace: { const: true },
    editor: { type: "string", minLength: 1, maxLength: 64 },
    hintShown: { const: true },
  },
  oneOf: [
    { required: ["cwd"], properties: { cwd: editorPathInput.cwd } },
    { required: ["workspace"], properties: { workspace: { const: true } } },
  ],
} as const;

export const editorOptionsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["visible", "editors", "preferredEditor", "remoteHint"],
  properties: {
    visible: { type: "boolean" },
    editors: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 64 },
          label: { type: "string", minLength: 1, maxLength: 128 },
        },
      },
    },
    preferredEditor: { type: ["string", "null"], maxLength: 64 },
    remoteHint: { type: ["string", "null"], maxLength: 1024 },
  },
} as const;

export const editorCapabilitiesSchema = {
  type: "object",
  additionalProperties: false,
  required: ["adapter", "operations", "clients"],
  properties: {
    adapter: { type: "string" },
    operations: {
      type: "object",
      additionalProperties: false,
      required: ["openPath"],
      properties: { openPath: { type: "boolean" } },
    },
    clients: { type: "array", maxItems: 0 },
    editor: editorOptionsSchema,
  },
} as const;

/** Backs `t3.ui/editor`: the client owns the preferred editor and opens through its environment. */
export const CLIENT_EDITOR_API = validateApiDefinition({
  id: "t3.client/editor",
  version: "1.1.0",
  methods: [
    {
      name: "openPath",
      effect: "write",
      requiredGrants: [],
      inputSchema: {
        ...withTarget(editorWorkspaceInputSchema.properties, ["path"]),
        oneOf: editorWorkspaceInputSchema.oneOf,
      },
      outputSchema: uiEditorOpenReceiptV11Schema,
    },
    {
      name: "getCapabilities",
      effect: "read",
      requiredGrants: [],
      inputSchema: withTarget({}, []),
      outputSchema: editorCapabilitiesSchema,
    },
  ],
});

export const CLIENT_EDITOR_V11_RANGE = "^1.1.0";

/**
 * The `t3.browser/history` result, shared by the public and private areas:
 * the project's URL history, most-recently-visited first, at most 50 entries
 * (the native browser history cap). `truncated` is present only when older
 * entries were dropped to keep the response inside the payload envelope.
 */
export const browserHistoryEntriesSchema = {
  type: "object",
  additionalProperties: false,
  required: ["entries"],
  properties: {
    entries: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["url", "lastVisitedAt"],
        properties: {
          url: { type: "string", minLength: 1, maxLength: 2048 },
          lastVisitedAt: { type: "number" },
          title: { type: "string", minLength: 1, maxLength: 512 },
        },
      },
    },
    truncated: { const: true },
  },
} as const;

const historyUrl = { type: "string", minLength: 1, maxLength: 4096 } as const;

/**
 * Backs `t3.browser/history` with the client's native per-project browser
 * history, so a pack and the native preview read and write the same list.
 * The project is the one the client maps the context thread to.
 */
export const CLIENT_BROWSER_HISTORY_API = validateApiDefinition({
  id: "t3.client/browser-history",
  version: "1.1.0",
  methods: [
    {
      name: "list",
      effect: "read",
      requiredGrants: [],
      inputSchema: withTarget({}),
      outputSchema: browserHistoryEntriesSchema,
    },
    {
      name: "record",
      effect: "write",
      requiredGrants: [],
      inputSchema: withTarget({ url: historyUrl }, ["url"]),
      outputSchema: browserHistoryEntriesSchema,
    },
    {
      name: "setTitle",
      effect: "write",
      requiredGrants: [],
      inputSchema: withTarget(
        { url: historyUrl, title: { type: "string", minLength: 1, maxLength: 4096 } },
        ["url", "title"],
      ),
      outputSchema: browserHistoryEntriesSchema,
    },
    {
      name: "remove",
      effect: "write",
      requiredGrants: [],
      inputSchema: withTarget({ url: historyUrl }, ["url"]),
      outputSchema: browserHistoryEntriesSchema,
    },
  ],
});

/** The `t3.ui/navigation` open receipt, shared by the public and private areas. */
export const uiNavigationReceiptSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "threadId"],
      properties: {
        status: { const: "opened" },
        threadId: { type: "string", minLength: 1, maxLength: 128 },
        surfaceId: { type: "string", minLength: 1, maxLength: 160 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "reason"],
      properties: {
        status: { const: "refused" },
        reason: { enum: ["unknown-thread", "out-of-scope", "surface-not-found"] },
      },
    },
  ],
} as const;

const uiNavigationFileReceipt = (reasons: readonly string[]) =>
  ({
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["status", "relativePath"],
        properties: {
          status: { const: "opened" },
          relativePath: { type: "string", minLength: 1, maxLength: 512 },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["status", "reason"],
        properties: {
          status: { const: "refused" },
          reason: { enum: reasons },
        },
      },
    ],
  }) as const;

/** 1.1.0's file-open receipt, before the preview-browser refusals. */
export const uiNavigationFileReceiptSchemaV1_1 = uiNavigationFileReceipt([
  "unknown-thread",
  "out-of-scope",
  "invalid-path",
]);

/** The `t3.ui/navigation` file-open receipt, shared by the public and private areas. */
export const uiNavigationFileReceiptSchema = uiNavigationFileReceipt([
  "unknown-thread",
  "out-of-scope",
  "invalid-path",
  // 1.2.0, only for `openIn: "browser"`.
  "not-previewable",
  "browser-unavailable",
  "open-failed",
]);

/** 1.1.0's `openFile` input: a workspace-relative path and an optional 1-based line. */
export const uiNavigationFileInputPropertiesV1_1 = {
  relativePath: { type: "string", minLength: 1, maxLength: 512 },
  line: { type: "integer", minimum: 1, maximum: 10_000_000 },
} as const;

/**
 * `openFile` input. 1.2.0 adds `openIn`: `"browser"` opens an `.html`,
 * `.htm` or `.pdf` file in the thread's preview browser instead of the file
 * panel, where `line` does not apply.
 */
export const uiNavigationFileInputProperties = {
  ...uiNavigationFileInputPropertiesV1_1,
  openIn: { enum: ["panel", "browser"] },
} as const;

/** The `t3.ui/navigation` agent-session receipt, shared by the public and private areas. */
export const uiNavigationSessionReceiptSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "agentId", "opener"],
      properties: {
        status: { const: "opened" },
        agentId: { type: "string", minLength: 1, maxLength: 256 },
        opener: { enum: ["desktop-shell", "browser-window"] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "reason"],
      properties: {
        status: { const: "refused" },
        reason: { enum: ["unknown-thread", "unknown-agent", "no-session", "opener-refused"] },
      },
    },
  ],
} as const;

/**
 * Backs `t3.ui/navigation`. The adapter forwards only threads it resolved in
 * the caller's own project, only session URLs it resolved from the caller's
 * own thread roster, and only safe workspace paths for the caller's own
 * thread; the client re-checks before routing or opening. `openFile` is
 * 1.1.0: the adapter sends it only to a client satisfying
 * `CLIENT_NAVIGATION_V11_RANGE`, and `openIn` (1.2.0) only to one satisfying
 * `CLIENT_NAVIGATION_V12_RANGE`. `getCapabilities` (1.2.0) says whether this
 * client has a preview browser for `openIn: "browser"`.
 */
export const CLIENT_NAVIGATION_API = validateApiDefinition({
  id: "t3.client/navigation",
  version: "1.2.0",
  methods: [
    {
      name: "openThread",
      effect: "write",
      requiredGrants: [],
      inputSchema: withTarget(
        {
          threadId: { type: "string", minLength: 1, maxLength: 128 },
          surfaceId: { type: "string", minLength: 1, maxLength: 160 },
        },
        ["threadId"],
      ),
      outputSchema: uiNavigationReceiptSchema,
    },
    {
      name: "openSession",
      effect: "write",
      requiredGrants: [],
      inputSchema: withTarget(
        {
          agentId: { type: "string", minLength: 1, maxLength: 256 },
          url: { type: "string", minLength: 1, maxLength: 4096 },
        },
        ["agentId", "url"],
      ),
      outputSchema: uiNavigationSessionReceiptSchema,
    },
    {
      name: "openFile",
      effect: "write",
      requiredGrants: [],
      inputSchema: withTarget(uiNavigationFileInputProperties, ["relativePath"]),
      outputSchema: uiNavigationFileReceiptSchema,
    },
    {
      name: "getCapabilities",
      effect: "read",
      requiredGrants: [],
      inputSchema: withTarget({}),
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["openFileInBrowser"],
        properties: { openFileInBrowser: { type: "boolean" } },
      },
    },
  ],
});

/** The navigation range that carries `openFile`. */
export const CLIENT_NAVIGATION_V11_RANGE = "^1.1.0";

/** The navigation range that carries `openFile`'s `openIn`. */
export const CLIENT_NAVIGATION_V12_RANGE = "^1.2.0";

/**
 * The closed set of pull-request tasks the host hands off. Each names a flow
 * the host already runs natively; the host writes any prompt text itself.
 */
export const CLIENT_PR_HANDOFF_TASKS = ["checkout", "resolve-conflicts"] as const;

/**
 * Where a handoff checks the pull request out, as native's checkout menu
 * offers it: its own worktree, or this repository's own checkout. Native
 * resolves conflicts in a worktree only.
 */
export const CLIENT_PR_HANDOFF_MODES = ["worktree", "local"] as const;

/** What a handoff did. No variant carries prompt text or claims a send. */
export const prHandoffResultSchema = {
  oneOf: [
    {
      // The task is in the caller's own thread's composer, for the reader to send.
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: { status: { const: "drafted" } },
    },
    {
      // Checked out, into its own worktree or this repository (`worktreePath`
      // null), with a thread open on it; a task other than checkout is in that
      // thread's composer.
      type: "object",
      additionalProperties: false,
      required: ["status", "branch", "worktreePath", "isOnPullRequestHead"],
      properties: {
        status: { const: "ready" },
        branch: { type: "string", minLength: 1, maxLength: 4096 },
        worktreePath: { type: ["string", "null"], minLength: 1, maxLength: 32768 },
        isOnPullRequestHead: { type: "boolean" },
      },
    },
    {
      // `thread`: no thread could be opened, so nothing was checked out.
      // `checkout`: the checkout failed; `detail` is the host's own sentence.
      // `thread-move`: checked out on `branch`, but the thread stayed put.
      type: "object",
      additionalProperties: false,
      required: ["status", "stage"],
      properties: {
        status: { const: "failed" },
        stage: { enum: ["thread", "checkout", "thread-move"] },
        branch: { type: "string", minLength: 1, maxLength: 4096 },
        detail: { type: "string", minLength: 1, maxLength: 2048 },
      },
    },
  ],
} as const;

/**
 * Backs `t3.vcs/actions#handoffPullRequest`. The adapter resolves the pull
 * request itself and forwards only its host-resolved identity with a closed
 * task kind and checkout mode; the client opens the thread, prepares the
 * checkout (which runs the setup script for that thread), points the thread
 * at it, and writes its own prompt into the composer. It never sends.
 */
export const CLIENT_PR_HANDOFF_API = validateApiDefinition({
  id: "t3.client/pr-handoff",
  version: "1.0.0",
  methods: [
    {
      name: "start",
      effect: "write",
      requiredGrants: [],
      inputSchema: withTarget(
        {
          task: { enum: [...CLIENT_PR_HANDOFF_TASKS] },
          mode: { enum: [...CLIENT_PR_HANDOFF_MODES] },
          pullRequest: {
            type: "object",
            additionalProperties: false,
            required: ["number", "url", "headBranch", "baseBranch"],
            properties: {
              number: { type: "integer", minimum: 1 },
              url: { type: "string", minLength: 1, maxLength: 4096 },
              headBranch: { type: "string", minLength: 1, maxLength: 4096 },
              baseBranch: { type: "string", minLength: 1, maxLength: 4096 },
            },
          },
        },
        ["task", "mode", "pullRequest"],
      ),
      outputSchema: prHandoffResultSchema,
    },
  ],
});

/** Host-owned client-provider definitions, keyed by area id. */
export const CLIENT_PROVIDER_APIS: ReadonlyMap<string, ApiDefinition> = new Map(
  [
    CLIENT_THEME_API,
    CLIENT_NOTIFICATIONS_API,
    CLIENT_KEYBINDINGS_API,
    CLIENT_PANELS_API,
    CLIENT_COMPOSER_API,
    CLIENT_TERMINAL_APPEARANCE_API,
    CLIENT_PREFERENCES_API,
    CLIENT_EXTERNAL_API,
    CLIENT_EDITOR_API,
    CLIENT_BROWSER_HISTORY_API,
    CLIENT_NAVIGATION_API,
    CLIENT_PR_HANDOFF_API,
  ].map((definition) => [definition.id, definition]),
);

/**
 * The server's accepted version range per area. A registering client must name
 * a version inside the range for the area it declares.
 */
export const CLIENT_PROVIDER_SUPPORTED_RANGE = "^1.0.0";

/**
 * The composer range that carries the 1.1.0 operations: `insertMention`,
 * `insertTerminalContext`, `listAnnotations`, `removeAnnotation`, and the
 * `kind: "diff"` annotation variant. A connection still declaring a 1.0.x
 * composer keeps exactly its 1.0.0 surface — `^1.0.0` registration accepts it,
 * so adapters must gate these ops on the targeted connection satisfying this
 * range instead of trusting registration alone.
 */
export const CLIENT_COMPOSER_V11_RANGE = "^1.1.0";

/** The composer range that carries `insertImage`; gated per connection like the 1.1.0 ops. */
export const CLIENT_COMPOSER_V12_RANGE = "^1.2.0";

/** The composer range that answers `listAnnotations` `include: ["text"]`. */
export const CLIENT_COMPOSER_V13_RANGE = "^1.3.0";
export const CLIENT_COMPOSER_V14_RANGE = "^1.4.0";
export const CLIENT_PANELS_V11_RANGE = "^1.1.0";
