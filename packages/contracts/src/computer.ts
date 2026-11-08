import * as Schema from "effect/Schema";

/** One monitor, in the desktop's logical coordinates. */
export const ComputerDisplay = Schema.Struct({
  index: Schema.Int,
  x: Schema.Int,
  y: Schema.Int,
  width: Schema.Int,
  height: Schema.Int,
});
export type ComputerDisplay = typeof ComputerDisplay.Type;

export const ComputerScreenshotInput = Schema.Struct({
  display: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description: "Capture one display by its `index` from `displays`. Default: every display.",
    }),
  ),
});
export type ComputerScreenshotInput = typeof ComputerScreenshotInput.Type;

export const ComputerScreenshotResult = Schema.Struct({
  desktop: Schema.String,
  displays: Schema.Array(ComputerDisplay),
  display: Schema.NullOr(Schema.Int),
  screenshot: Schema.Struct({
    mimeType: Schema.Literal("image/png"),
    data: Schema.String,
    width: Schema.Int,
    height: Schema.Int,
  }),
});
export type ComputerScreenshotResult = typeof ComputerScreenshotResult.Type;

export const ComputerAction = Schema.Literals([
  "click",
  "double_click",
  "right_click",
  "middle_click",
  "move",
  "drag",
  "scroll",
  "type",
  "key",
]);
export type ComputerAction = typeof ComputerAction.Type;

const ImagePixel = Schema.Finite;
const ScrollNotches = Schema.Int.check(Schema.isBetween({ minimum: -50, maximum: 50 }));

export const ComputerActInput = Schema.Struct({
  action: ComputerAction,
  x: Schema.optional(
    ImagePixel.annotate({
      description:
        "Pixel in the latest `computer_screenshot` image. Needed for clicks, move, drag; optional for scroll.",
    }),
  ),
  y: Schema.optional(ImagePixel),
  toX: Schema.optional(ImagePixel.annotate({ description: "Drag end, in the same image." })),
  toY: Schema.optional(ImagePixel),
  text: Schema.optional(
    Schema.String.check(Schema.isMaxLength(4000)).annotate({
      description: "For `type`: text to enter. `\\n` presses Enter.",
    }),
  ),
  keys: Schema.optional(
    Schema.String.check(Schema.isMaxLength(64)).annotate({
      description:
        "For `key`: one key or combo, such as `Return`, `Escape`, `ctrl+shift+t`, `alt+F4`.",
    }),
  ),
  scrollX: Schema.optional(
    ScrollNotches.annotate({ description: "Wheel notches. Positive is right." }),
  ),
  scrollY: Schema.optional(
    ScrollNotches.annotate({ description: "Wheel notches. Positive is down." }),
  ),
});
export type ComputerActInput = typeof ComputerActInput.Type;

export const ComputerStopInput = Schema.Struct({
  forget: Schema.optional(
    Schema.Boolean.annotate({
      description: "Also forget the user's saved permission, so the next screenshot asks again.",
    }),
  ),
});
export type ComputerStopInput = typeof ComputerStopInput.Type;

export class ComputerUseUnavailableError extends Schema.TaggedError<ComputerUseUnavailableError>()(
  "ComputerUseUnavailableError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export class ComputerUseInvalidActionError extends Schema.TaggedError<ComputerUseInvalidActionError>()(
  "ComputerUseInvalidActionError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/** The user did not allow remote control, or ended it. Never retry without asking them. */
export class ComputerUseConsentError extends Schema.TaggedError<ComputerUseConsentError>()(
  "ComputerUseConsentError",
  { outcome: Schema.Literals(["cancelled", "denied", "timeout", "ended"]) },
) {
  override get message(): string {
    switch (this.outcome) {
      case "cancelled":
        return "The user declined remote control of their desktop. Ask them before trying again.";
      case "denied":
        return "The desktop refused remote control. Ask the user to check their system's remote desktop permission.";
      case "timeout":
        return "Nobody answered the desktop's remote control prompt. Ask the user before trying again.";
      case "ended":
        return "The user ended remote control of their desktop. Ask them before starting again.";
    }
  }
}

export class ComputerUseOperationError extends Schema.TaggedError<ComputerUseOperationError>()(
  "ComputerUseOperationError",
  {
    operation: Schema.Literals(["screenshot", "input", "session"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    switch (this.operation) {
      case "screenshot":
        return "Could not capture the desktop.";
      case "input":
        return "The desktop did not accept the input. Take a screenshot to check its state.";
      case "session":
        return "Could not start remote control of the desktop.";
    }
  }
}

export const ComputerUseError = Schema.Union([
  ComputerUseUnavailableError,
  ComputerUseInvalidActionError,
  ComputerUseConsentError,
  ComputerUseOperationError,
]);
export type ComputerUseError = typeof ComputerUseError.Type;
