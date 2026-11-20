import { ComposerContextId, EnvironmentId } from "@t3tools/contracts";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  decodeComposerContextClipboardHtml,
  encodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";
import { expect, it } from "vite-plus/test";

import { copySnapshot } from "./copySnapshot";

it.each([false, true])(
  "preserves image bytes and snapshot metadata, custom format rejected: %s",
  async (rejectCustom) => {
    class Item {
      constructor(readonly data: Record<string, Blob | Promise<Blob>>) {}
    }
    let clipboard: Item | undefined;
    const write = async ([item]: Item[]) => {
      if (rejectCustom && item?.data[COMPOSER_CONTEXT_CLIPBOARD_MIME])
        throw new Error("Unsupported format");
      clipboard = item;
      await Promise.all(Object.values(item!.data));
    };
    const originals = {
      navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
      ClipboardItem: Object.getOwnPropertyDescriptor(globalThis, "ClipboardItem"),
    };
    using _globals = {
      [Symbol.dispose]() {
        for (const key of ["navigator", "ClipboardItem"] as const) {
          const descriptor = originals[key];
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else Reflect.deleteProperty(globalThis, key);
        }
      },
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { write } },
    });
    Object.defineProperty(globalThis, "ClipboardItem", { configurable: true, value: Item });
    const fragment = encodeComposerContextFragment({
      version: 1,
      source: { environmentId: EnvironmentId.make("snapshot-source") },
      records: [
        {
          version: 1,
          kind: "image",
          contextId: ComposerContextId.make("image_snapshot"),
          label: "Snapshot",
          attachmentId: "snapshot",
          name: "snapshot.png",
          mimeType: "image/png",
          sizeBytes: 3,
          source: {
            kind: "snap-shot",
            capturedAt: "2026-01-01T00:00:00.000Z",
            appName: "Finder",
            windowTitle: "Downloads",
            accessibleText: "Downloads",
          },
        },
      ],
    })!;
    const image = "data:image/png;base64,AQID";
    await copySnapshot(image, "Snapshot", fragment);
    const png = await clipboard!.data["image/png"]!;
    expect(png.type).toBe("image/png");
    expect([...new Uint8Array(await png.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(
      decodeComposerContextClipboardHtml(await (await clipboard!.data["text/html"]!).text()),
    ).toEqual(JSON.parse(fragment));
    expect(await (await clipboard!.data["text/plain"]!).text()).toBe("Snapshot");
  },
);
