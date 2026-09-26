import { validateApiDefinition, type ApiDefinition } from "./capabilities.js";

/**
 * Private `t3.client/*` client-provider area definitions.
 *
 * These are host-owned ambient providers (theme, notifications, keybindings,
 * panels, composer, terminal appearance) reached only through the
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
  },
} as const;

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
  version: "1.0.0",
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
    defaultKey: { type: "string", minLength: 1, maxLength: 64 },
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
  version: "1.0.0",
  methods: [
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

export const CLIENT_COMPOSER_API = validateApiDefinition({
  id: "t3.client/composer",
  version: "1.1.0",
  methods: [
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
      name: "listAnnotations",
      effect: "read",
      requiredGrants: [],
      inputSchema: withTarget({ ...composerThreadIdInput }, ["threadId"]),
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

/** Host-owned client-provider definitions, keyed by area id. */
export const CLIENT_PROVIDER_APIS: ReadonlyMap<string, ApiDefinition> = new Map(
  [
    CLIENT_THEME_API,
    CLIENT_NOTIFICATIONS_API,
    CLIENT_KEYBINDINGS_API,
    CLIENT_PANELS_API,
    CLIENT_COMPOSER_API,
    CLIENT_TERMINAL_APPEARANCE_API,
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
