import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  PREVIEW_VIEWPORT_MAX_AREA,
  PreviewRenderedViewportSize,
  PreviewTabId,
  PreviewViewportPresetId,
  PreviewViewportSetting,
  PreviewViewportSize,
} from "./preview.ts";
import { BrowserProfileId } from "./browserProfile.ts";

const BoundedUrl = Schema.String.check(Schema.isTrimmed())
  .check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(2048));

const URL_GUIDANCE = "Absolute http(s) URL, or a bare host (https; http for loopback).";

const PROFILE_GUIDANCE =
  "Profile id or name from preview_status, for a new tab. Default: the user's. A tab keeps its profile.";

export const OptionalTimeoutMs = Schema.optional(
  Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(60_000)),
).annotate({ description: "Default 15000." });

export const PREVIEW_AUTOMATION_V1_OPERATIONS = [
  "status",
  "open",
  "navigate",
  "snapshot",
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "waitFor",
  "recordingStart",
  "recordingStop",
] as const;

const PREVIEW_AUTOMATION_OPERATIONS = [
  ...PREVIEW_AUTOMATION_V1_OPERATIONS,
  "resize",
  "setColorScheme",
] as const;

export const PREVIEW_AUTOMATION_SERVER_OPERATIONS = [
  ...PREVIEW_AUTOMATION_OPERATIONS,
  "dialog",
  "close",
  "upload",
  "hover",
  "select",
  "drag",
] as const;

export const PreviewAutomationOperation = Schema.Literals(PREVIEW_AUTOMATION_SERVER_OPERATIONS);
export type PreviewAutomationOperation = typeof PreviewAutomationOperation.Type;

export const PreviewAutomationTabTargetFields = {
  tabId: Schema.optional(PreviewTabId),
};

export const PreviewAutomationTabTargetInput = Schema.Struct(PreviewAutomationTabTargetFields);
export type PreviewAutomationTabTargetInput = typeof PreviewAutomationTabTargetInput.Type;

const PreviewAutomationTabOwner = Schema.Literals(["agent", "human", "unclaimed"]);

const PreviewAutomationProfile = Schema.Struct({
  id: BrowserProfileId,
  name: Schema.String,
  incognito: Schema.optional(Schema.Boolean),
});
type PreviewAutomationProfile = typeof PreviewAutomationProfile.Type;

export const PreviewAutomationStatus = Schema.Struct({
  available: Schema.Boolean,
  visible: Schema.Boolean,
  tabId: Schema.NullOr(PreviewTabId),
  url: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  loading: Schema.Boolean,
  control: Schema.optional(
    Schema.Struct({
      owner: PreviewAutomationTabOwner,
      ownedByCaller: Schema.Boolean,
      generation: Schema.Number,
    }),
  ),
  dialog: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        type: Schema.String,
        message: Schema.String,
        defaultValue: Schema.String,
      }),
    ),
  ),
  viewportSetting: Schema.optional(PreviewViewportSetting),
  viewport: Schema.optional(PreviewRenderedViewportSize),
  fileChooser: Schema.optional(
    Schema.NullOr(Schema.Struct({ multiple: Schema.Boolean, accept: Schema.String })),
  ),
  downloads: Schema.optional(
    Schema.Array(
      Schema.Struct({
        fileName: Schema.String,
        path: Schema.String,
        sizeBytes: Schema.Number,
        url: Schema.String,
        completedAt: Schema.String,
      }),
    ),
  ),
  /** Server hosts: all thread tabs are readable; actions require ownedByCaller or an unclaimed tab without human control. */
  tabs: Schema.optional(
    Schema.Array(
      Schema.Struct({
        tabId: PreviewTabId,
        url: Schema.NullOr(Schema.String),
        openerTabId: Schema.optional(PreviewTabId),
        owner: Schema.optional(PreviewAutomationTabOwner),
        ownedByCaller: Schema.optional(Schema.Boolean),
        visible: Schema.optional(Schema.Boolean),
        profileId: Schema.optional(BrowserProfileId),
      }),
    ),
  ),
  profiles: Schema.optional(Schema.Array(PreviewAutomationProfile)),
  defaultProfileId: Schema.optional(BrowserProfileId),
});
export type PreviewAutomationStatus = typeof PreviewAutomationStatus.Type;

export const PreviewAutomationDialogInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  accept: Schema.Boolean,
  promptText: Schema.optional(Schema.String),
});
export type PreviewAutomationDialogInput = typeof PreviewAutomationDialogInput.Type;

export const PreviewAutomationOpenInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  url: Schema.optional(BoundedUrl).annotate({
    description: `First page URL. ${URL_GUIDANCE} Omit to open a blank tab.`,
  }),
  open: Schema.optional(
    Schema.Boolean.annotate({
      description: "Show the preview to the user. Default true. False for background only.",
    }),
  ),
  show: Schema.optional(
    Schema.Boolean.annotate({
      description: "Old alias for `open`.",
    }),
  ),
  reuseExistingTab: Schema.optional(
    Schema.Boolean.annotate({
      description: "Reuse `tabId`, or your current tab. Default true. False makes a new tab.",
    }),
  ),
  profileId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))).annotate({
    description: PROFILE_GUIDANCE,
  }),
}).check(
  Schema.makeFilter(
    (input) =>
      !(input.tabId !== undefined && input.reuseExistingTab === false) ||
      "tabId cannot be combined with reuseExistingTab=false.",
  ),
);
export type PreviewAutomationOpenInput = typeof PreviewAutomationOpenInput.Type;

export const BrowserNavigationTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("url"),
    url: BoundedUrl.annotate({
      description: `Website URL. ${URL_GUIDANCE}`,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("environment-port"),
    port: Schema.Int.check(Schema.isGreaterThan(0))
      .check(Schema.isLessThan(65_536))
      .annotate({ description: "Dev-server port here." }),
    protocol: Schema.optional(
      Schema.Literals(["http", "https"]).annotate({
        description: "Default http.",
      }),
    ),
    path: Schema.optional(
      Schema.String.annotate({
        description: "Path, query, and fragment, such as /settings?tab=account.",
      }),
    ),
  }),
]);
export type BrowserNavigationTarget = typeof BrowserNavigationTarget.Type;

export const PreviewAutomationNavigateInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  url: Schema.optional(BoundedUrl).annotate({
    description: `Website URL. ${URL_GUIDANCE} For public pages.`,
  }),
  target: Schema.optional(BrowserNavigationTarget),
  readiness: Schema.optional(Schema.Literals(["load", "domContentLoaded", "none"])).annotate({
    description: "Default 'load'. 'none': return at once.",
  }),
  timeoutMs: OptionalTimeoutMs,
}).check(
  Schema.makeFilter(
    (input) =>
      Number(input.url !== undefined) + Number(input.target !== undefined) === 1 ||
      "Provide exactly one of url or target.",
  ),
);
export type PreviewAutomationNavigateInput = typeof PreviewAutomationNavigateInput.Type;

export const PreviewAutomationResizeInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  mode: Schema.Literals(["fill", "freeform", "preset"]),
  preset: Schema.optional(PreviewViewportPresetId),
  width: Schema.optional(PreviewViewportSize.fields.width),
  height: Schema.optional(PreviewViewportSize.fields.height),
  orientation: Schema.optional(Schema.Literals(["portrait", "landscape"])),
  timeoutMs: OptionalTimeoutMs,
}).check(
  Schema.makeFilter((input) => {
    const hasPreset = input.preset !== undefined;
    const hasWidth = input.width !== undefined;
    const hasHeight = input.height !== undefined;
    if (hasWidth !== hasHeight) return "Custom dimensions require both width and height.";
    if (input.mode === "fill") {
      return !hasPreset && !hasWidth && input.orientation === undefined
        ? true
        : "Fill mode does not accept a preset, dimensions, or orientation.";
    }
    if (input.mode === "freeform") {
      if (!hasWidth || !hasHeight || hasPreset || input.orientation !== undefined) {
        return "Freeform mode requires width and height and does not accept a preset or orientation.";
      }
    } else if (!hasPreset || hasWidth || hasHeight) {
      return "Preset mode requires a preset and does not accept custom dimensions.";
    }
    if (hasWidth && hasHeight && input.width! * input.height! > PREVIEW_VIEWPORT_MAX_AREA) {
      return `Custom viewport area must not exceed ${PREVIEW_VIEWPORT_MAX_AREA} pixels.`;
    }
    return true;
  }),
);
export type PreviewAutomationResizeInput = typeof PreviewAutomationResizeInput.Type;

export const PreviewAutomationResizeResult = Schema.Struct({
  tabId: PreviewTabId,
  setting: PreviewViewportSetting,
  viewport: PreviewRenderedViewportSize,
});
export type PreviewAutomationResizeResult = typeof PreviewAutomationResizeResult.Type;

// Mirrors DesktopPreviewColorScheme without importing ipc.ts.
const PreviewAutomationColorScheme = Schema.Literals(["system", "light", "dark"]);
type PreviewAutomationColorScheme = typeof PreviewAutomationColorScheme.Type;

export const PreviewAutomationSetColorSchemeInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  colorScheme: PreviewAutomationColorScheme,
});
export type PreviewAutomationSetColorSchemeInput = typeof PreviewAutomationSetColorSchemeInput.Type;

export const PreviewAutomationSetColorSchemeResult = Schema.Struct({
  tabId: PreviewTabId,
  colorScheme: PreviewAutomationColorScheme,
});
export type PreviewAutomationSetColorSchemeResult =
  typeof PreviewAutomationSetColorSchemeResult.Type;

export const Locator = TrimmedNonEmptyString;

export const LegacySelector = TrimmedNonEmptyString;

const PointerTargetFields = {
  ...PreviewAutomationTabTargetFields,
  selector: Schema.optional(LegacySelector),
  locator: Schema.optional(Locator),
  x: Schema.optional(Schema.Finite),
  y: Schema.optional(Schema.Finite),
  timeoutMs: OptionalTimeoutMs,
};

const singlePointerTarget = Schema.makeFilter(
  (input: {
    readonly selector?: string | undefined;
    readonly locator?: string | undefined;
    readonly x?: number | undefined;
    readonly y?: number | undefined;
  }) => {
    const selectorModes =
      Number(input.selector !== undefined) + Number(input.locator !== undefined);
    const hasX = input.x !== undefined;
    const hasY = input.y !== undefined;
    if (hasX !== hasY) return "Coordinates require both x and y.";
    const coordinateModes = hasX && hasY ? 1 : 0;
    return selectorModes + coordinateModes === 1 || "Provide exactly one target.";
  },
);

export const PreviewAutomationClickInput = Schema.Struct({
  ...PointerTargetFields,
  button: Schema.optional(
    Schema.Literals(["left", "right", "middle"]).annotate({
      description: "Button. Default left. Right opens the menu.",
    }),
  ),
  clickCount: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })).annotate({
      description: "1 click, 2 double, 3 triple. Default 1.",
    }),
  ),
}).check(singlePointerTarget);
export type PreviewAutomationClickInput = typeof PreviewAutomationClickInput.Type;

export const PreviewAutomationHoverInput =
  Schema.Struct(PointerTargetFields).check(singlePointerTarget);
export type PreviewAutomationHoverInput = typeof PreviewAutomationHoverInput.Type;

export const PreviewAutomationSelectInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  selector: Schema.optional(LegacySelector),
  locator: Schema.optional(Locator),
  values: Schema.Array(Schema.String).check(Schema.isMaxLength(100)).annotate({
    description: "Empty clears it.",
  }),
  timeoutMs: OptionalTimeoutMs,
}).check(
  Schema.makeFilter(
    (input) =>
      Number(input.selector !== undefined) + Number(input.locator !== undefined) === 1 ||
      "Provide exactly one of selector or locator.",
  ),
);
export type PreviewAutomationSelectInput = typeof PreviewAutomationSelectInput.Type;

export const PreviewAutomationSelectResult = Schema.Struct({
  selected: Schema.Array(Schema.String).annotate({
    description: "The values of the options now selected.",
  }),
});
export type PreviewAutomationSelectResult = typeof PreviewAutomationSelectResult.Type;

export const PreviewAutomationDragInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  source: Locator,
  target: Locator,
  timeoutMs: OptionalTimeoutMs,
});
export type PreviewAutomationDragInput = typeof PreviewAutomationDragInput.Type;

export const PreviewAutomationUploadInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  paths: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(20)),
  selector: Schema.optional(LegacySelector),
  locator: Schema.optional(Locator).annotate({
    description: "Set files on this <input type=file> instead of the open picker.",
  }),
  timeoutMs: OptionalTimeoutMs,
}).check(
  Schema.makeFilter(
    (input) =>
      !(input.selector !== undefined && input.locator !== undefined) ||
      "Provide at most one of selector or locator.",
  ),
);
export type PreviewAutomationUploadInput = typeof PreviewAutomationUploadInput.Type;

export const PreviewAutomationTypeInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  text: Schema.String,
  selector: Schema.optional(LegacySelector),
  locator: Schema.optional(Locator),
  clear: Schema.optional(
    Schema.Boolean.annotate({
      description: "Clear the input first. Default false.",
    }),
  ),
  timeoutMs: OptionalTimeoutMs,
}).check(
  Schema.makeFilter(
    (input) =>
      !(input.selector !== undefined && input.locator !== undefined) ||
      "Provide at most one of selector or locator.",
  ),
);
export type PreviewAutomationTypeInput = typeof PreviewAutomationTypeInput.Type;

export const PreviewAutomationPressInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  key: Schema.String.check(Schema.isTrimmed()).check(Schema.isNonEmpty()),
  modifiers: Schema.optional(Schema.Array(Schema.Literals(["Alt", "Control", "Meta", "Shift"]))),
});
export type PreviewAutomationPressInput = typeof PreviewAutomationPressInput.Type;

export const PreviewAutomationScrollInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  deltaX: Schema.optional(Schema.Finite),
  deltaY: Schema.optional(Schema.Finite),
  selector: Schema.optional(LegacySelector),
  locator: Schema.optional(Locator),
}).check(
  Schema.makeFilter((input) => {
    if (input.selector !== undefined && input.locator !== undefined) {
      return "Provide at most one of selector or locator.";
    }
    return input.deltaX !== undefined || input.deltaY !== undefined || "Provide deltaX or deltaY.";
  }),
);
export type PreviewAutomationScrollInput = typeof PreviewAutomationScrollInput.Type;

/** Strict input for each `preview_act` action. */
export const PreviewAutomationActInputs = {
  click: PreviewAutomationClickInput,
  type: PreviewAutomationTypeInput,
  hover: PreviewAutomationHoverInput,
  select: PreviewAutomationSelectInput,
  drag: PreviewAutomationDragInput,
  upload: PreviewAutomationUploadInput,
  press: PreviewAutomationPressInput,
  scroll: PreviewAutomationScrollInput,
} as const;

export type PreviewAutomationAction = keyof typeof PreviewAutomationActInputs;

/** One flat shape for every page action. The server decodes it with the action's strict input. */
export const PreviewAutomationActInput = Schema.Struct({
  action: Schema.Literals([
    "click",
    "type",
    "hover",
    "select",
    "drag",
    "upload",
    "press",
    "scroll",
  ]),
  ...PreviewAutomationTabTargetFields,
  locator: Schema.optional(Locator),
  selector: Schema.optional(LegacySelector),
  x: Schema.optional(Schema.Finite),
  y: Schema.optional(Schema.Finite),
  button: Schema.optional(Schema.Literals(["left", "right", "middle"])),
  clickCount: Schema.optional(Schema.Int),
  text: Schema.optional(Schema.String),
  clear: Schema.optional(Schema.Boolean),
  values: Schema.optional(Schema.Array(Schema.String)),
  source: Schema.optional(Locator),
  target: Schema.optional(Locator),
  paths: Schema.optional(Schema.Array(Schema.String)),
  key: Schema.optional(Schema.String),
  modifiers: PreviewAutomationPressInput.fields.modifiers,
  deltaX: Schema.optional(Schema.Finite),
  deltaY: Schema.optional(Schema.Finite),
  timeoutMs: Schema.optional(Schema.Int),
});
export type PreviewAutomationActInput = typeof PreviewAutomationActInput.Type;

export const PreviewAutomationEvaluateInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  expression: Schema.String.check(Schema.isTrimmed())
    .check(Schema.isNonEmpty())
    .check(Schema.isMaxLength(64_000)),
  awaitPromise: Schema.optional(Schema.Boolean.annotate({ description: "Default true." })),
  returnByValue: Schema.optional(
    Schema.Boolean.annotate({
      description: "False returns a ref. Default true.",
    }),
  ),
});
export type PreviewAutomationEvaluateInput = typeof PreviewAutomationEvaluateInput.Type;
