import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerStashMenu } from "./ComposerStashMenu";

describe("ComposerStashMenu", () => {
  it("renders saved prompts as an attached composer drawer", () => {
    const markup = renderToStaticMarkup(
      <ComposerStashMenu
        entries={[]}
        stashShortcutLabel="Ctrl+S"
        onRestore={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain('data-composer-stash-drawer="true"');
    expect(markup).toContain("chat-composer-drawer-surface");
    expect(markup).toContain("chat-composer-drawer-attached");
    expect(markup).toContain('aria-label="Close stash"');
    expect(markup).not.toContain("dropdown-glass");
    expect(markup).not.toContain("Stashed prompts");
    expect(markup).toContain("Press Ctrl+S with a prompt in the composer to stash it.");
  });

  it("does not advertise a shortcut when stash is unbound", () => {
    const markup = renderToStaticMarkup(
      <ComposerStashMenu
        entries={[]}
        stashShortcutLabel={null}
        onRestore={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain("Nothing stashed yet.");
    expect(markup).not.toContain("Press");
  });

  it("shows saved image thumbnails and incomplete image states", () => {
    const markup = renderToStaticMarkup(
      <ComposerStashMenu
        entries={[
          {
            id: "with-images",
            createdAt: new Date(0).toISOString(),
            prompt: "Compare these screenshots",
            attachments: [
              {
                id: "image-one",
                name: "before.png",
                mimeType: "image/png",
                sizeBytes: 128,
                dataUrl: "data:image/png;base64,AA==",
              },
            ],
            droppedImageNames: ["after.png"],
            unreadableImageNames: [],
            pendingImageCount: 0,
          },
          {
            id: "saving-images",
            createdAt: new Date(0).toISOString(),
            prompt: "Save this image",
            attachments: [],
            droppedImageNames: [],
            unreadableImageNames: [],
            pendingImageCount: 1,
          },
        ]}
        stashShortcutLabel="Ctrl+S"
        onRestore={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain('src="data:image/png;base64,AA=="');
    expect(markup).toContain("1 image dropped");
    expect(markup).toContain("saving 1 image");
    expect(markup).not.toContain("absolute top-1/2 right-2");
    expect(markup).toContain("pointer-events-none");
    expect(markup).toContain("pointer-coarse:pointer-events-auto");
    expect(markup).toContain("pointer-coarse:opacity-100");
    expect(markup).not.toContain("bg-popover!");
    expect(markup).toContain("[--control-icon-color:currentColor]");
    expect(markup).toContain("size-3.5 stroke-2");
    expect(markup).not.toContain("bg-background/90");
  });
});
