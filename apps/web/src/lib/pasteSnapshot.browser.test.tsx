import { expect, it, vi } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { installPasteSnapshot } from "./pasteSnapshot";

function copyToClipboard(text: string) {
  const onCopy = (event: ClipboardEvent) => {
    event.clipboardData?.setData("text/plain", text);
    event.preventDefault();
  };
  document.addEventListener("copy", onCopy, true);
  document.execCommand("copy");
  document.removeEventListener("copy", onCopy, true);
}

it("later paste handlers read the text after the clipboard changes at the first read", async () => {
  using _snapshot = { [Symbol.dispose]: installPasteSnapshot(window) };
  let readByEditor: string | undefined;
  await using _screen = await render(
    <div
      contentEditable
      suppressContentEditableWarning
      data-testid="editor"
      onPaste={(event) => {
        readByEditor = event.clipboardData.getData("text/plain");
        event.preventDefault();
      }}
    />,
    // A bare editable target; the test drives native clipboard dispatch, not navigation.
    { router: false },
  );
  await userEvent.click(page.getByTestId("editor"));
  copyToClipboard("Check this. ");

  // A dictation tool puts its next item on the clipboard as soon as the target reads the text.
  const replaceAfterRead = (event: ClipboardEvent) => {
    event.clipboardData?.getData("text/plain");
    copyToClipboard("next item");
  };
  window.addEventListener("paste", replaceAfterRead, true);
  using _listener = {
    [Symbol.dispose]: () => window.removeEventListener("paste", replaceAfterRead, true),
  };

  await userEvent.keyboard("{ControlOrMeta>}v{/ControlOrMeta}");

  await vi.waitFor(() => expect(readByEditor).toBe("Check this. "));
});

it("leaves a paste into a native text field to the browser", async () => {
  using _snapshot = { [Symbol.dispose]: installPasteSnapshot(window) };
  await using _screen = await render(<textarea data-testid="field" />, {
    // A bare text field; the test drives native clipboard dispatch, not navigation.
    router: false,
  });
  await userEvent.click(page.getByTestId("field"));
  copyToClipboard("Check this. ");
  const getData = vi.spyOn(DataTransfer.prototype, "getData");
  using _spy = { [Symbol.dispose]: () => getData.mockRestore() };

  await userEvent.keyboard("{ControlOrMeta>}v{/ControlOrMeta}");

  await expect.element(page.getByTestId("field")).toHaveValue("Check this. ");
  expect(getData).not.toHaveBeenCalled();
});

async function copyImageToClipboard() {
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 8;
  const dataUrl = canvas.toDataURL("image/png");
  await commands.writeClipboardImage(dataUrl.slice(dataUrl.indexOf(",") + 1));
}

it("later paste handlers get the image after the clipboard changes", async () => {
  using _snapshot = { [Symbol.dispose]: installPasteSnapshot(window) };
  let filesReadByEditor: string[] | undefined;
  await using _screen = await render(
    <div
      contentEditable
      suppressContentEditableWarning
      data-testid="editor"
      onPaste={(event) => {
        filesReadByEditor = Array.from(event.clipboardData.items, (item) => {
          const file = item.getAsFile();
          return file === null ? "none" : file.type;
        });
        event.preventDefault();
      }}
    />,
    // A bare editable target; the test drives native clipboard dispatch, not navigation.
    { router: false },
  );
  await userEvent.click(page.getByTestId("editor"));
  await copyImageToClipboard();

  // A dictation tool puts its next item on the clipboard while the paste is dispatched.
  const replaceDuringPaste = () => copyToClipboard("next item");
  window.addEventListener("paste", replaceDuringPaste, true);
  using _listener = {
    [Symbol.dispose]: () => window.removeEventListener("paste", replaceDuringPaste, true),
  };

  await userEvent.keyboard("{ControlOrMeta>}v{/ControlOrMeta}");

  await vi.waitFor(() => expect(filesReadByEditor).toEqual(["image/png"]));
});
