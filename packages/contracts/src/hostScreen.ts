import * as Schema from "effect/Schema";

export const HostScreenFrame = Schema.Struct({
  jpegBase64: Schema.String.check(Schema.isMaxLength(2_800_000)),
  width: Schema.Int,
  height: Schema.Int,
});
export type HostScreenFrame = typeof HostScreenFrame.Type;

export class HostScreenError extends Schema.TaggedError<HostScreenError>()("HostScreenError", {
  cause: Schema.optional(Schema.Defect()),
  reason: Schema.Literals(["unsupported", "unavailable", "busy", "invalid-image"]),
}) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported":
        return "Screen viewing is available only for Mac environments.";
      case "busy":
        return "The Mac is capturing another frame. Try again shortly.";
      case "invalid-image":
        return "The Mac returned an invalid or oversized screen image.";
      case "unavailable":
        return "Could not capture the Mac screen. Allow Screen Recording for T3 Code (or the terminal running its server) in macOS System Settings, and make sure the Mac is awake.";
    }
  }
}
