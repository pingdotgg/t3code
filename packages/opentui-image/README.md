# `@t3tools/opentui-image`

T3 Code's bounded image preview decoder and Kitty clipboard adapter.

`decodeImage` uses Sharp to rotate, resize, and encode an attachment as a bounded
PNG preview. T3 Code passes that encoded source directly to OpenTUI's built-in
`<image>` element. OpenTUI owns decoding, layout, clipping, and terminal output.

The package keeps two T3-specific pieces:

- bounded Sharp decoding for formats accepted by chat attachments;
- Kitty clipboard reads, including tmux passthrough for remote sessions.

```tsx
import { decodeImage } from "@t3tools/opentui-image";

const preview = await decodeImage(encoded, { maxWidth: 720, maxHeight: 480 });

<image source={preview.source} width={40} height={12} fit="fill" />;
```
