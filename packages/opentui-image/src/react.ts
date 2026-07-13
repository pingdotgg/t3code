import { extend, type ExtendedComponentProps } from "@opentui/react";
import { createElement } from "react";
import type * as React from "react";

import { ImageRenderable } from "./ImageRenderable.ts";

declare module "@opentui/react" {
  interface OpenTUIComponents {
    image: typeof ImageRenderable;
  }
}

extend({ image: ImageRenderable });

export type ImageProps = ExtendedComponentProps<typeof ImageRenderable>;

export function Image(props: ImageProps): React.ReactElement<ImageProps> {
  return createElement("image", props);
}

export * from "./index.ts";
