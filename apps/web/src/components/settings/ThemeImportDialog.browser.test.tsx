import type { ClientSettings } from "@t3tools/contracts";
import { getTranslationsSnapshot, GTProvider } from "gt-react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import {
  __resetClientSettingsPersistenceForTests,
  updateClientSettings,
} from "../../hooks/useSettings";
import { I18nProvider } from "../../i18n/I18nProvider";
import { initializeI18n } from "../../i18n/initializeI18n";
import { setActiveLocale } from "../../i18n/messages";
import { startI18n, whenLocaleReady } from "../../i18n/runtime";
import { ensureLocalApi } from "../../localApi";
import {
  CUSTOM_THEMES_STORAGE_KEY,
  getCustomThemes,
  installCustomTheme,
  invalidateCustomThemes,
  parseThemeFile,
  themeColorToHex,
  THEME_FILE_VERSION,
} from "../../themePalette";
import { importOpenVsxThemeExtension, type OpenVsxThemeExtension } from "../../openVsxThemes";
import { AppRouteModal } from "../AppRouteModal";
import { SharedTooltipProvider } from "../ui/shared-tooltip";
import { ThemeImportDialog } from "./ThemeImportDialog";
import { ThemeLibrary } from "./ThemeSettings";

const searchOpenVsxThemes = vi.hoisted(() => vi.fn());

vi.mock("../chat/GlobalVoiceInputIndicator", () => ({ GlobalVoiceInputIndicator: () => null }));
vi.mock("../../hooks/useEnvironmentTheme", () => ({ useEnvironmentThemeDefinitions: () => [] }));
vi.mock("../../openVsxThemes", () => ({
  searchOpenVsxThemes,
  importOpenVsxThemeExtension: vi.fn(),
}));

const extension: OpenVsxThemeExtension = {
  id: "acme.nightfall",
  collectionId: "acme.nightfall",
  name: "Nightfall",
  publisher: "acme",
  description: "A dark theme",
  downloadCount: 10,
  iconUrl: null,
  sourceUrl: null,
  manifestUrl: "https://example.test/manifest",
  sha256Url: "https://example.test/sha256",
  vsixUrl: "https://example.test/vsix",
  version: "1.0.0",
  license: "MIT",
};

describe("ThemeImportDialog", () => {
  // StrictMode replays ref attach/detach on mount, which must not end the session.
  it("searches Open VSX under StrictMode", async () => {
    searchOpenVsxThemes.mockReset();
    searchOpenVsxThemes.mockResolvedValue([extension]);
    await using _screen = await render(
      <StrictMode>
        <ThemeImportDialog
          open
          onOpenChange={() => {}}
          onImported={() => true}
          onImportedMany={() => {}}
        />
      </StrictMode>,
    );

    // One input event: keystrokes more than the search debounce apart would search a prefix first.
    await userEvent.fill(page.getByLabelText("Search Open VSX themes"), "night");

    await expect.element(page.getByRole("heading", { name: "Nightfall" })).toBeVisible();
    expect(searchOpenVsxThemes).toHaveBeenCalledWith(
      "night",
      expect.objectContaining({ sortBy: "downloadCount" }),
    );
  });

  it("shows the singular label for one download", async () => {
    searchOpenVsxThemes.mockReset();
    searchOpenVsxThemes.mockResolvedValue([{ ...extension, downloadCount: 1 }]);
    await using _screen = await render(
      <ThemeImportDialog
        open
        onOpenChange={() => {}}
        onImported={() => true}
        onImportedMany={() => {}}
      />,
    );

    await userEvent.fill(page.getByRole("searchbox"), "night");

    // The download count is in the publisher's tooltip.
    const tooltipText = () => document.querySelector("[data-slot=tooltip-popup]")?.textContent ?? "";
    await userEvent.hover(page.getByRole("searchbox"));
    await userEvent.hover(page.getByText("acme", { exact: true }));
    await vi.waitFor(() => expect(tooltipText()).toBe("1 download"));
  });

  it("reformats the shown download count when the app language changes", async () => {
    searchOpenVsxThemes.mockReset();
    searchOpenVsxThemes.mockResolvedValue([{ ...extension, downloadCount: 1_200_000 }]);
    const { persistence } = ensureLocalApi();
    let savedSettings: ClientSettings | null = null;
    using _readSettings = vi
      .spyOn(persistence, "getClientSettings")
      .mockImplementation(async () => savedSettings);
    using _writeSettings = vi
      .spyOn(persistence, "setClientSettings")
      .mockImplementation(async (settings) => {
        savedSettings = settings;
      });
    __resetClientSettingsPersistenceForTests();
    const setLanguage = async (language: string) => {
      await act(async () => {
        await updateClientSettings({ language });
        await whenLocaleReady();
      });
    };
    // The download count is in the publisher's tooltip.
    const tooltipText = () => document.querySelector("[data-slot=tooltip-popup]")?.textContent ?? "";
    const hoverPublisher = async () => {
      await userEvent.hover(page.getByRole("searchbox"));
      await userEvent.hover(page.getByText("acme", { exact: true }));
    };

    try {
      startI18n();
      await setLanguage("en");
      await using _screen = await render(
        <I18nProvider>
          <ThemeImportDialog
            open
            onOpenChange={() => {}}
            onImported={() => true}
            onImportedMany={() => {}}
          />
        </I18nProvider>,
      );
      await userEvent.fill(page.getByRole("searchbox"), "night");
      await hoverPublisher();
      await vi.waitFor(() => expect(tooltipText()).toBe("1.2M downloads"));

      await setLanguage("ru");
      await hoverPublisher();
      await vi.waitFor(() => expect(tooltipText()).toMatch(/^Скачиваний: 1,2\s+млн$/));
    } finally {
      await setLanguage("en");
      __resetClientSettingsPersistenceForTests();
      // Restore the GT fallback locale for tests that render without an I18nProvider.
      initializeI18n(() => {});
    }
  });

  it("clears the search on Escape before closing the dialog", async () => {
    searchOpenVsxThemes.mockReset();
    searchOpenVsxThemes.mockResolvedValue([]);
    const onOpenChange = vi.fn();
    await using _screen = await render(
      <ThemeImportDialog
        open
        onOpenChange={onOpenChange}
        onImported={() => true}
        onImportedMany={() => {}}
      />,
    );
    const search = page.getByRole("searchbox", { name: "Search Open VSX themes" });
    await expect.element(search).toHaveAttribute("type", "text");
    await userEvent.fill(search, "nord");
    await userEvent.keyboard("{Escape}");
    await expect.element(search).toHaveValue("");
    search.element().dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
        repeat: true,
      }),
    );
    expect(onOpenChange).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

const theme = (name: string, accent = "#3b82f6", css?: string) => ({
  version: THEME_FILE_VERSION,
  name,
  appearance: "dark",
  colors: { accent },
  ...(css ? { css } : {}),
});

const themeFile = (name: string, accent?: string, css?: string) =>
  new File([JSON.stringify(theme(name, accent, css))], `${name}.json`, {
    type: "application/json",
  });

const DUSK_CSS = ".chat-header { height: 3rem; }";

it.each(["Update existing", "Keep both"])(
  "keeps batch failures visible after %s",
  async (choice) => {
    using _themes = {
      [Symbol.dispose]() {
        window.localStorage.removeItem(CUSTOM_THEMES_STORAGE_KEY);
        invalidateCustomThemes();
      },
    };
    installCustomTheme(parseThemeFile(theme("Dusk")));
    const onOpenChange = vi.fn();
    await using _screen = await render(
      <ThemeImportDialog
        open
        onOpenChange={onOpenChange}
        onImported={() => true}
        onImportedMany={() => {}}
      />,
    );
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await userEvent.upload(input, [
      themeFile("Dawn"),
      themeFile("Dusk", "#f97316", DUSK_CSS),
      new File(["{"], "broken.json", { type: "application/json" }),
    ]);

    await expect.element(page.getByText("Already installed")).toBeVisible();
    await expect.element(page.getByText(/^broken\.json:/)).toBeVisible();
    expect(getCustomThemes().map((theme) => theme.label)).toContain("Dawn");
    await page.getByRole("button", { name: choice }).click();
    invalidateCustomThemes();
    const label = choice === "Update existing" ? "Dusk" : "Dusk (1)";
    expect(getCustomThemes().find((theme) => theme.label === label)).toMatchObject({
      colors: parseThemeFile(theme("Dusk", "#f97316")).colors,
      css: DUSK_CSS,
    });
    await expect.element(page.getByText(/^broken\.json:/)).toBeVisible();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  },
);

function isolateThemes() {
  const previous = localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY);
  localStorage.removeItem(CUSTOM_THEMES_STORAGE_KEY);
  invalidateCustomThemes();
  return {
    [Symbol.dispose]() {
      if (previous === null) localStorage.removeItem(CUSTOM_THEMES_STORAGE_KEY);
      else localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, previous);
      invalidateCustomThemes();
    },
  };
}

it("keeps a numbered copy when the theme name expands in its ID", async () => {
  using _themes = isolateThemes();
  const name = "İstanbul İncisi İzmir İskenderun İnegöl İpsala";
  const original = installCustomTheme(parseThemeFile(theme(name)));
  const updated = theme(name, "#f97316");
  await using _screen = await render(
    <ThemeImportDialog
      open
      onOpenChange={() => {}}
      onImported={() => true}
      onImportedMany={() => {}}
    />,
  );

  await userEvent.fill(page.getByRole("textbox", { name: "Theme JSON" }), JSON.stringify(updated));
  await page.getByRole("button", { name: "Add theme", exact: true }).click();
  await expect.element(page.getByText("Already installed")).toBeVisible();
  await page.getByRole("button", { name: "Keep both" }).click();

  const themes = getCustomThemes();
  expect(themes).toHaveLength(2);
  expect(themes.find(({ id }) => id === original.id)).toEqual(original);
  expect(themes.find(({ id }) => id !== original.id)).toMatchObject({
    label: "İstanbul İncisi İzmir İskenderun İnegöl İ (1)",
    colors: parseThemeFile(updated).colors,
  });
});

it.each([
  [
    "a different theme label",
    theme("Dusk"),
    theme("Dusk", "#f97316"),
    `${"a".repeat(47)}🌙.json`,
    "a".repeat(47),
  ],
  [
    "the same label after truncating",
    { ...theme("a".repeat(47)), id: "custom-id" },
    { ...theme("a".repeat(47), "#f97316"), id: "custom-id" },
    `${"a".repeat(47)}🌙.json`,
    `${"a".repeat(44)} (1)`,
  ],
  [
    "the same label after truncating at a space",
    { ...theme("a".repeat(46)), id: "custom-id" },
    { ...theme("a".repeat(46), "#f97316"), id: "custom-id" },
    `${"a".repeat(46)} 🌙.json`,
    `${"a".repeat(44)} (1)`,
  ],
])(
  "does not split a surrogate pair when naming a kept copy after its file (%s)",
  async (_caseName, installed, imported, fileName, expectedLabel) => {
    using _themes = isolateThemes();
    const original = installCustomTheme(parseThemeFile(installed));
    const json = JSON.stringify(imported);
    await using _screen = await render(
      <ThemeImportDialog
        open
        onOpenChange={() => {}}
        onImported={() => true}
        onImportedMany={() => {}}
      />,
    );
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await userEvent.upload(input, new File([json], fileName, { type: "application/json" }));
    await expect.element(page.getByRole("textbox", { name: "Theme JSON" })).toHaveValue(json);
    await page.getByRole("button", { name: "Add theme", exact: true }).click();
    await expect.element(page.getByText("Already installed")).toBeVisible();
    await page.getByRole("button", { name: "Keep both" }).click();

    expect(getCustomThemes().find(({ id }) => id !== original.id)?.label).toBe(expectedLabel);
  },
);

it("sizes an oversized theme file just under 1 MB as 1.00 MB", async () => {
  using _themes = isolateThemes();
  await using _screen = await render(
    <ThemeImportDialog
      open
      onOpenChange={() => {}}
      onImported={() => true}
      onImportedMany={() => {}}
    />,
  );
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  await userEvent.upload(
    input,
    new File(["x".repeat(1_048_100)], "huge.json", { type: "application/json" }),
  );

  await expect
    .element(page.getByText(/^That file is/))
    .toHaveTextContent(
      "That file is 1.00 MB. Theme files are only a few KB, so this one was not read (limit 256 KB).",
    );
});

it("names an oversized file in a batch import in the UI language", async () => {
  using _themes = isolateThemes();
  const translations = await getTranslationsSnapshot("de");
  // Mirrors the runtime: `m()` reads the active locale once its catalog is loaded.
  setActiveLocale("de");
  using _locale = {
    [Symbol.dispose]() {
      setActiveLocale("en");
      // GTProvider leaves its locale in a cookie; this sets it back to English.
      initializeI18n(() => {});
    },
  };
  await using _screen = await render(
    <GTProvider locale="de" translations={translations}>
      <ThemeImportDialog
        open
        onOpenChange={() => {}}
        onImported={() => true}
        onImportedMany={() => {}}
      />
    </GTProvider>,
  );
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  await userEvent.upload(input, [
    themeFile("Dawn"),
    new File(["x".repeat(1_048_100)], "huge.json", { type: "application/json" }),
  ]);

  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent(
      "huge.json: Diese Datei ist 1.00 MB groß. Design-Dateien haben nur wenige KB, daher wurde sie nicht gelesen (Limit 256 KB).",
    );
});

it.each(["failed read", "batch install"])(
  "keeps the oversized replacement warning after a superseded %s",
  async (earlierImport) => {
    using _themes = isolateThemes();
    await using _screen = await render(
      <ThemeImportDialog
        open
        onOpenChange={() => {}}
        onImported={() => true}
        onImportedMany={() => {}}
      />,
    );
    const earlierRead = Promise.withResolvers<string>();
    const readStarted = Promise.withResolvers<void>();
    const earlierFile = Object.assign(themeFile("Dusk"), {
      text() {
        readStarted.resolve();
        return earlierRead.promise;
      },
    });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const files = new DataTransfer();
    if (earlierImport === "batch install") files.items.add(themeFile("Dawn"));
    files.items.add(earlierFile);
    await act(async () => {
      input.files = files.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await readStarted.promise;
    });
    await expect.element(page.getByRole("button", { name: "Reading…" })).toBeDisabled();
    await userEvent.upload(
      input,
      new File([" ".repeat(256 * 1024 + 1)], earlierFile.name, { type: "application/json" }),
    );
    const warning = page.getByText(/^That file is/);
    await expect.element(warning).toBeVisible();

    await act(async () => {
      if (earlierImport === "batch install") {
        earlierRead.resolve(JSON.stringify(theme("Dusk")));
      } else {
        earlierRead.reject(new Error("Could not read Dusk"));
      }
      await earlierRead.promise.catch(() => {});
    });

    expect(getCustomThemes().map((theme) => theme.label)).toEqual([]);
    expect(page.getByRole("alert").element().textContent).toMatch(/^That file is/);
    await expect.element(page.getByRole("button", { name: "Choose files" })).toBeEnabled();
  },
);

function themeJsonc(name: string, background: string) {
  return `{
    // VS Code themes use JSONC even with a .json extension.
    "name": "${name}",
    "colors": {
      "editor.background": "${background}",
    },
    "tokenColors": [],
  }`;
}

describe("ThemeImportDialog JSONC imports", () => {
  it.each(["paste", "file"])("imports a VS Code JSONC theme from %s", async (source) => {
    using _themes = isolateThemes();
    await using _screen = await render(
      <ThemeImportDialog
        open
        onOpenChange={() => {}}
        onImported={() => true}
        onImportedMany={() => {}}
      />,
    );
    const json = themeJsonc("JSONC Night", "#002b36");
    if (source === "paste") {
      await page.getByRole("textbox", { name: "Theme JSON" }).fill(json);
    } else {
      const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
      await userEvent.upload(input, new File([json], "night.json", { type: "application/json" }));
      await expect.element(page.getByRole("textbox", { name: "Theme JSON" })).toHaveValue(json);
    }
    await page.getByRole("button", { name: "Add theme", exact: true }).click();

    expect(getCustomThemes().map((theme) => theme.label)).toEqual(["JSONC Night"]);
    expect(themeColorToHex(getCustomThemes()[0]!.colors.canvas)).toBe("#002b36");
  });

  it("imports each VS Code JSONC theme in a file batch", async () => {
    using _themes = isolateThemes();
    await using _screen = await render(
      <ThemeImportDialog
        open
        onOpenChange={() => {}}
        onImported={() => true}
        onImportedMany={() => {}}
      />,
    );
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await userEvent.upload(input, [
      new File([themeJsonc("JSONC Night", "#002b36")], "night.json", {
        type: "application/json",
      }),
      new File([themeJsonc("JSONC Day", "#fdf6e3")], "day.json", {
        type: "application/json",
      }),
    ]);

    await vi.waitFor(() => {
      expect(getCustomThemes().map((theme) => theme.label)).toEqual(["JSONC Night", "JSONC Day"]);
    });
    expect(getCustomThemes().map((theme) => themeColorToHex(theme.colors.canvas))).toEqual([
      "#002b36",
      "#fdf6e3",
    ]);
  });
});

it("does not install a pending community theme after leaving Appearance", async () => {
  using _themes = isolateThemes();
  searchOpenVsxThemes.mockReset();
  searchOpenVsxThemes.mockResolvedValue([extension]);
  const download = Promise.withResolvers<ReturnType<typeof parseThemeFile>[]>();
  vi.mocked(importOpenVsxThemeExtension).mockReset();
  vi.mocked(importOpenVsxThemeExtension).mockReturnValue(download.promise);
  await using screen = await render(
    <ThemeImportDialog
      open
      onOpenChange={() => {}}
      onImported={() => true}
      onImportedMany={() => {}}
    />,
  );
  await userEvent.fill(page.getByLabelText("Search Open VSX themes"), "night");
  await page.getByRole("button", { name: "Install Nightfall" }).click();
  await screen.unmount();
  await act(async () => {
    download.resolve([
      {
        ...parseThemeFile(theme("Nightfall")),
        collection: { id: extension.collectionId, label: extension.name },
      },
    ]);
    await download.promise;
  });
  expect(
    getCustomThemes(),
    "expect leaving Appearance to cancel its pending theme installation",
  ).toEqual([]);
});

it("closes an open theme variant radial picker on Escape before closing Settings", async () => {
  const collection = { id: "acme.cat", label: "Catppuccin" };
  const customThemes = [
    {
      ...parseThemeFile({
        version: THEME_FILE_VERSION,
        name: "Catppuccin Latte",
        appearance: "light",
        colors: { accent: "#3b82f6" },
      }),
      collection,
    },
    { ...parseThemeFile(theme("Catppuccin Mocha")), collection },
    { ...parseThemeFile(theme("Catppuccin Frappe", "#f97316")), collection },
  ];
  const renderSettings = (key: string) => (
    <SharedTooltipProvider>
      <AppRouteModal key={key} label="Settings">
        <ThemeLibrary
          appearanceMode="dark"
          customThemes={customThemes}
          initialAppearance="dark"
          isImportOpen={false}
          onImportOpenChange={() => {}}
          refreshTheme={() => {}}
          appearanceChoice="dark"
          setAppearanceChoice={() => true}
          setTheme={() => true}
          setThemeHalf={() => true}
          theme="dark"
          themeHalves={null}
        />
      </AppRouteModal>
    </SharedTooltipProvider>
  );

  await using screen = await render(renderSettings("multi"), { router: "/settings/appearance" });
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect.element(settings).toHaveFocus();

  const darkPicker = page.getByRole("button", {
    name: "Choose dark variant, 2 options, currently Mocha",
  });
  const mochaOption = page.getByRole("button", { name: "Use Mocha for dark mode" });
  (darkPicker.element() as HTMLElement).focus();
  await expect.element(mochaOption).toHaveStyle({ opacity: "1", pointerEvents: "auto" });

  await userEvent.keyboard("{Escape}");
  await expect.element(mochaOption).toHaveStyle({ opacity: "0", pointerEvents: "none" });
  await expect.element(darkPicker).toHaveFocus();
  await expect.element(settings).toHaveAttribute("data-open");

  await userEvent.tab();
  await expect.element(mochaOption).toHaveFocus();
  await expect.element(mochaOption).toHaveStyle({ opacity: "1", pointerEvents: "auto" });

  await userEvent.keyboard("{Escape}");
  await expect.element(mochaOption).toHaveStyle({ opacity: "0", pointerEvents: "none" });
  await expect.element(darkPicker).toHaveFocus();
  await expect.element(settings).toHaveAttribute("data-open");

  await userEvent.keyboard("{Escape}");
  await expect.element(settings).not.toBeInTheDocument();

  await screen.rerender(renderSettings("single"));
  await expect.element(settings).toHaveFocus();

  const lightVariant = page.getByRole("button", { name: "Use light variant, currently Latte" });
  (lightVariant.element() as HTMLElement).focus();
  await userEvent.keyboard("{Escape}");
  await expect.element(settings).not.toBeInTheDocument();
});
