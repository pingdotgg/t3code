import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../test/render";
import { CustomSnoozeDialogHost, requestCustomSnooze } from "./CustomSnoozeDialog";

describe("CustomSnoozeDialog layout", () => {
  it("lines the Date button up with the Time field side by side", async () => {
    // Below the sm breakpoint the fields stack, so the two-column layout needs a wide viewport.
    await page.viewport(1280, 900);
    await using _screen = await render(<CustomSnoozeDialogHost />);
    await act(async () => void requestCustomSnooze());

    const dateTop = page.getByLabelText("Date").element().getBoundingClientRect().top;
    // The bordered box around the native input is what the user sees, not the input inside it.
    const timeTop = page
      .getByLabelText("Time")
      .element()
      .parentElement!.getBoundingClientRect().top;

    expect(dateTop, `Date top ${dateTop}px, Time top ${timeTop}px`).toBe(timeTop);
  });
});
