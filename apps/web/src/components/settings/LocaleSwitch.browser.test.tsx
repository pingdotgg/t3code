import { expect, it, vi } from "vite-plus/test";
import { userEvent, page } from "vite-plus/test/browser";

import { act, render, stubGlobal } from "../../../test/render";
import { i18n } from "../../i18nCore";
import { LinkAddressWarning } from "./LinkMachineSelect";
import { NotificationSettings } from "./NotificationSettings";
import { AppearanceSettingsPanel } from "./AppearanceSettingsPanel";

const TEST_SETTINGS = {
  notificationMode: "off",
  environmentIdentificationMode: "artwork",
  appearanceContrast: 100,
  glassOpacity: 80,
  panelAnimationDurationMs: 150,
  chatWidth: "comfortable",
  effortDisplay: "bars",
  mathRenderingEnabled: true,
  persistComposerContextStrip: true,
  fontFamilySans: "",
  fontFamilyComposer: "",
  fontFamilyCode: "",
  fontFamilyTerminal: "",
  fontSizeInterface: 16,
  fontSizePrompt: 14,
  fontSizeCode: 13,
  fontSizeTerminal: 13,
  fontSmoothing: true,
  wordWrap: false,
} as Record<string, unknown>;

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: ((select?: (settings: Record<string, unknown>) => unknown) =>
    select === undefined ? TEST_SETTINGS : select(TEST_SETTINGS)) as never,
  useUpdateScopedSettings: () => vi.fn(),
}));

vi.mock(import("../../hooks/useTheme"), async (original) => ({
  ...(await original()),
  useTheme: (() => ({
    appearanceMode: "system" as const,
    refreshTheme: () => {},
    resolvedTheme: "dark" as const,
    setAppearanceMode: () => false,
    setTheme: () => false,
    setThemeHalf: () => false,
    theme: "dark",
    themeHalves: null,
  })) as never,
}));

vi.mock(import("../../hooks/useCustomThemes"), async (original) => ({
  ...(await original()),
  useCustomThemes: (() => []) as never,
}));

vi.mock(import("../SidebarStageBackdrop"), async (original) => ({
  ...(await original()),
  useEnvironmentStageLabel: (() => "Local") as never,
}));

vi.mock(import("../../hooks/useEnvironmentTheme"), async (original) => ({
  ...(await original()),
  useEnvironmentThemeDefinitions: (() => []) as never,
}));

vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentIdentificationMode: (() => "artwork") as never,
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

it("updates appearance panel labels when the language changes without remounting", async () => {
  const rowTitles = (container: HTMLElement): Array<string | null> =>
    [...container.querySelectorAll("[data-slot='settings-row'] h3")].map(
      (node) => node.textContent,
    );

  await i18n.changeLanguage("en");
  await using screen = await render(<AppearanceSettingsPanel />);
  expect(screen.container.querySelectorAll("h3")[0]?.textContent).toBe("Color scheme");
  expect(rowTitles(screen.container)).toContain("Contrast");
  expect(rowTitles(screen.container)).toContain("Glass opacity");
  expect(rowTitles(screen.container)).toContain("Chat width");

  await act(() => i18n.changeLanguage("zh-Hans"));

  expect(screen.container.querySelectorAll("h3")[0]?.textContent).toBe("配色方案");
  expect(rowTitles(screen.container)).toContain("对比度");
  expect(rowTitles(screen.container)).toContain("玻璃不透明度");
  expect(rowTitles(screen.container)).toContain("聊天宽度");
  await act(() => i18n.changeLanguage("en"));
});
