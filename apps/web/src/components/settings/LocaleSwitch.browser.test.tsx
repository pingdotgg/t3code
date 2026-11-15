import { expect, it, vi } from "vite-plus/test";
import { userEvent, page } from "vite-plus/test/browser";

import { act, render, stubGlobal } from "../../../test/render";
import { i18n } from "../../i18nCore";
import { LinkAddressWarning } from "./LinkMachineSelect";
import { NotificationSettings } from "./NotificationSettings";

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: ((select: (settings: { notificationMode: "off" }) => unknown) =>
    select({ notificationMode: "off" })) as never,
  useUpdateScopedSettings: () => vi.fn(),
}));

it("updates the link warning when the language changes", async () => {
  await i18n.changeLanguage("en");
  await using screen = await render(<LinkAddressWarning address="https://example.com" />);
  expect(screen.getByText("Check this address")).toBeTruthy();
  await act(() => i18n.changeLanguage("zh-Hans"));
  await expect.element(screen.getByText("请核对这个地址")).toBeVisible();
  await act(() => i18n.changeLanguage("en"));
});

it("updates an existing notification permission message when the language changes", async () => {
  await i18n.changeLanguage("en");
  using _notification = stubGlobal("Notification", undefined);
  await using screen = await render(<NotificationSettings />);
  await userEvent.click(screen.getByRole("combobox", { name: "Thread notifications" }));
  await userEvent.click(page.getByRole("option", { name: "Notifications only" }));
  await expect
    .element(
      screen.getByText(
        "Notifications need a supported browser over HTTPS, or the desktop app. Sound only is still available.",
      ),
    )
    .toBeVisible();
  await act(() => i18n.changeLanguage("zh-Hans"));
  await expect
    .element(
      screen.getByText("通知需要受支持的浏览器通过 HTTPS 访问，或使用桌面应用。仍可只用声音。"),
    )
    .toBeVisible();
  await act(() => i18n.changeLanguage("en"));
});
