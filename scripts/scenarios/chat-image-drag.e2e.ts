import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Uploaded image drops follow paste's thumbnail and inline-reference rules",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("image-drag");
    await t3.thread({ project, title: "Image source", messages: ["Source fixture"] });
    await t3.thread({ project, title: "Image target", messages: ["Target fixture"] });
    await t3.open();
    const sourceRow = screen.getByRole("button", /^Image source, /);
    await expect(sourceRow).toBeVisible({ timeout: 120_000 });
    await sourceRow.tap();
    await screen.getByRole("textbox", "Message Image source").tap();
    await browser.evaluate(`(async () => {
    const bytes = Uint8Array.from(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZYkAAAAASUVORK5CYII='),
      char => char.charCodeAt(0),
    );
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'picture.png', { type: 'image/png' }));
    document.querySelector('[data-testid="composer-editor"]').dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
    );
    return true;
  })()`);
    await expect(screen.getByRole("button", "Preview picture.png")).toBeVisible();
    await browser.evaluate(`(async () => {
    const { useComposerDraftStore } = await import('/src/composerDraftStore.ts');
    const { awaitAttachmentUploads, getUploadedAttachments } = await import('/src/lib/attachmentUploadQueue.ts');
    const environmentId = location.pathname.split('/')[1];
    const image = Object.values(useComposerDraftStore.getState().draftsByThreadKey)
      .flatMap(draft => draft.images).find(image => image.name === 'picture.png');
    await awaitAttachmentUploads([image.id]);
    const uploaded = getUploadedAttachments({ environmentId, images: [image] })[0];
    const { attachmentDragProps, CHAT_ITEM_DRAG_TYPE } = await import('/src/components/chat/chatItemDrag.ts');
    const data = new DataTransfer();
    attachmentDragProps(environmentId, uploaded).onDragStartCapture(
      new DragEvent('dragstart', { dataTransfer: data }),
    );
    window.imageDragPayload = data.getData(CHAT_ITEM_DRAG_TYPE);
    return true;
  })()`);
    await screen.getByRole("button", /^Image target, /).tap();
    const destination = screen.getByRole("textbox", "Message Image target");
    await app.screenshot("before-drop");
    const drop = () =>
      browser.evaluate(`(() => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('application/x-t3code-chat-item', window.imageDragPayload);
    document.querySelector('[data-testid="composer-editor"]').dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }),
    );
    return true;
  })()`);
    await drop();
    await expect(screen.getByRole("button", "Preview picture.png")).toBeVisible();
    await app.screenshot("after-drop");
    await expect(destination).toHaveText("");
    await screen.getByRole("button", "Remove picture.png").tap();
    await destination.fill("Describe this image.");
    await drop();
    await expect(screen.getByRole("button", "Preview picture.png")).toBeVisible();
    await expect(destination).toContainText("Describe this image.");
    await expect(destination).toContainText("picture.png");
    await sourceRow.tap();
    await expect(screen.getByRole("button", "Preview picture.png")).toBeVisible();
  },
);
