# `@t3tools/opentui-image`

An OpenTUI custom renderable for RGBA images using the Kitty graphics protocol.
It packages the user-facing behavior from
[OpenTUI PR #633](https://github.com/anomalyco/opentui/pull/633) without requiring
a forked OpenTUI native binary.

## Core

```ts
import { createCliRenderer } from "@opentui/core";
import { ImageRenderable, installKittyImageExtension } from "@t3tools/opentui-image";

const renderer = await createCliRenderer();
installKittyImageExtension(renderer);

const image = new ImageRenderable(renderer, {
  data: rgba,
  imageWidth: 320,
  imageHeight: 180,
});

renderer.root.add(image);
```

The `data` array must contain exactly `imageWidth * imageHeight * 4` bytes in
RGBA order. Reassign `image.data` after replacing the pixels. If pixels are
mutated in place, call `image.invalidate()`.

Encoded PNG, JPEG, WebP, GIF, AVIF, TIFF, and SVG bytes can be converted to a
bounded RGBA preview with `decodeImage`:

```ts
import { decodeImage } from "@t3tools/opentui-image";

const preview = await decodeImage(encoded, { maxWidth: 720, maxHeight: 480 });
```

## React

Import the React entry point once to register the custom intrinsic element:

```tsx
import "@t3tools/opentui-image/react";

function Preview() {
  return <image data={rgba} imageWidth={320} imageHeight={180} />;
}
```

The extension only emits images when OpenTUI reports Kitty graphics support.
Pass `{ capability: "always" }` to `installKittyImageExtension` only when the
host has already established support itself.

Kitty graphics commands must be wrapped in tmux's DCS passthrough envelope. If
the host has positively identified a Kitty-capable outer terminal, pass
`{ tmuxPassthrough: true }`. tmux also needs passthrough enabled:

```tmux
set -g allow-passthrough on
```

The option is deliberately not inferred from tmux alone: an unidentified outer
terminal may not implement Kitty graphics and should retain the text/link
fallback.

## Difference from the native PR

The PR adds pixel buffers to OpenTUI's Zig renderer, allowing image and text
output to be emitted in the same native render operation. A package extension
cannot access that private native pipeline, so this implementation flushes one
deduplicated Kitty command batch immediately after each OpenTUI frame. Images
remain terminal overlays: text cannot occlude them, and partially clipped image
regions are not cropped. Those constraints match the PR's current compositing
model, while native atomic buffering remains the one material limitation.
