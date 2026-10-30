import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { AnchoredToastProvider } from "../ui/toast";
import { MessageCopyButton } from "./MessageCopyButton";

it("explains a denied clipboard write and lets the same message be copied again", async () => {
  await using screen = await render(
    <AnchoredToastProvider timeout={0}>
      <MessageCopyButton text="A message to copy" />
    </AnchoredToastProvider>,
  );
  using _write = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockRejectedValueOnce(new DOMException("Clipboard access denied", "NotAllowedError"))
    .mockResolvedValue(undefined);
  using _console = vi.spyOn(console, "error").mockImplementation(() => undefined);

  const copy = screen.getByRole("button", { name: "Copy message" });
  await copy.click();

  await expect.element(page.getByText("Failed to copy text to the clipboard.")).toBeVisible();
  await expect.element(copy).toBeEnabled();
  await page.getByRole("button", { name: "Dismiss notification" }).click();
  await copy.click();

  await expect.element(page.getByText("Copied!", { exact: true })).toBeVisible();
  await expect.element(copy).toBeDisabled();
});
