import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { applyLocale } from "../../i18n/locale";
import { LanguageSettings } from "./LanguageSettings";

vi.mock(import("../../i18n/locale"), async (original) => ({
  ...(await original()),
  applyLocale: vi.fn(),
}));

it.each([
  ["Deutsch", "de"],
  ["Français", "fr"],
  ["Español", "es"],
  ["简体中文", "zh-CN"],
])("stages %s until the user applies it", async (label, locale) => {
  vi.mocked(applyLocale).mockReset();
  await using screen = await render(<LanguageSettings />);
  const apply = screen.getByRole("button", { name: "Apply and reload" });
  await expect.element(apply).toBeDisabled();

  await userEvent.click(screen.getByRole("combobox", { name: "Interface language" }));
  await userEvent.click(screen.getByRole("option", { name: label }));
  expect(applyLocale).not.toHaveBeenCalled();
  await expect.element(apply).toBeEnabled();
  await userEvent.click(apply);
  expect(applyLocale).toHaveBeenCalledExactlyOnceWith(locale);
});

it("keeps the selected language available for retry when persistence fails", async () => {
  vi.mocked(applyLocale)
    .mockReset()
    .mockImplementation(() => {
      throw new Error("Storage blocked");
    });
  await using screen = await render(<LanguageSettings />);
  await userEvent.click(screen.getByRole("combobox", { name: "Interface language" }));
  await userEvent.click(screen.getByRole("option", { name: "简体中文" }));
  await userEvent.click(screen.getByRole("button", { name: "Apply and reload" }));
  await expect.element(screen.getByRole("alert")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Apply and reload" })).toBeEnabled();
  expect(applyLocale).toHaveBeenCalledExactlyOnceWith("zh-CN");
});
