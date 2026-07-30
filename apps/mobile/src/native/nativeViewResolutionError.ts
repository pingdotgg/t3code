import * as Schema from "effect/Schema";

export class NativeViewResolutionError extends Schema.TaggedErrorClass<NativeViewResolutionError>()(
  "NativeViewResolutionError",
  {
    nativeModuleName: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to resolve native view ${this.nativeModuleName}.`;
  }
}
