import * as Context from "effect/Context";

/**
 * The images of the two Containers bound to each native Durable Object.
 * `tools: undefined` drops the async Worker's `Tools` Container from its
 * class (and leaves the Effect-native `NativeTools` without an image).
 */
export interface NativeImageSet {
  readonly shell: string;
  readonly tools: string | undefined;
}

export const NativeImages = Context.Reference<NativeImageSet>("NativeImages", {
  defaultValue: () => ({ shell: "alpine:3.21", tools: "alpine:3.20" }),
});
