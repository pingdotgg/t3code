import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { RedactedSensitiveText } from "./RedactedSensitiveText";

it("exposes the value to assistive technology only while revealed", async () => {
  await using screen = await render(
    <RedactedSensitiveText
      value="account@example.com"
      ariaLabel="Toggle account email visibility"
      revealTooltip="Click to reveal email"
      hideTooltip="Click to hide email"
    />,
  );
  const button = screen.getByRole("button");
  await expect.element(button).toHaveAccessibleName("Toggle account email visibility");
  await expect.element(button).toHaveAttribute("aria-pressed", "false");
  await userEvent.click(button);
  await expect.element(button).toHaveAccessibleName("account@example.com");
  await expect.element(button).toHaveAttribute("aria-pressed", "true");
  await userEvent.click(button);
  await expect.element(button).toHaveAccessibleName("Toggle account email visibility");
  await expect.element(button).toHaveAttribute("aria-pressed", "false");
});
