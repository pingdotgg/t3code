import { getTranslationsSnapshot, GTProvider } from "gt-react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { act, render } from "../../../test/render";
import { initializeI18n } from "../../i18n/initializeI18n";
import { setActiveLocale } from "../../i18n/messages";
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

    await userEvent.click(page.getByRole("button", { name: "Search community themes" }));
    await userEvent.fill(page.getByLabelText("Search Open VSX themes"), "night");

    await expect.element(page.getByRole("button", { name: "Install Nightfall" })).toBeVisible();
    // A slow runner can debounce on a prefix like "ni"; wait for the full query.
    await vi.waitFor(() =>
      expect(searchOpenVsxThemes).toHaveBeenLastCalledWith(
        "night",
        expect.objectContaining({ sortBy: "downloadCount" }),
      ),
    );

    let completeSearch!: (themes: OpenVsxThemeExtension[]) => void;
    const pendingSearch = new Promise<OpenVsxThemeExtension[]>((resolve) => {
      completeSearch = resolve;
    });
    let notifySearchStarted!: (signal: AbortSignal) => void;
    const searchStarted = new Promise<AbortSignal>((resolve) => {
      notifySearchStarted = resolve;
    });
    searchOpenVsxThemes.mockImplementationOnce(
      (_query: string, options: { signal: AbortSignal }) => {
        notifySearchStarted(options.signal);
        return pendingSearch;
      },
    );
    await userEvent.type(page.getByLabelText("Search Open VSX themes"), "fall");
    const searchSignal = await searchStarted;
    await userEvent.click(page.getByRole("button", { name: "Back", exact: true }));
    expect(searchSignal.aborted).toBe(true);
    completeSearch([extension]);

    await userEvent.click(page.getByRole("button", { name: "Search community themes" }));
    await expect.element(page.getByLabelText("Search Open VSX themes")).toHaveValue("");
    await userEvent.type(page.getByLabelText("Search Open VSX themes"), "night");
    await expect.element(page.getByRole("button", { name: "Install Nightfall" })).toBeVisible();
  });

  // The count uses the host locale, not the UI language.
  const compact = (count: number) =>
    new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
      count,
    );
  it.each([
    ["en", 1, "1 download"],
    ["ru", 475_001, compact(475_001)],
  ])("counts %s theme downloads (%d)", async (locale, downloadCount, line) => {
    searchOpenVsxThemes.mockReset();
    searchOpenVsxThemes.mockResolvedValue([{ ...extension, downloadCount }]);
    const translations = await getTranslationsSnapshot(locale);
    using _locale = {
      [Symbol.dispose]() {
        // GTProvider leaves its locale in a cookie; this sets it back to English.
        initializeI18n(() => {});
      },
    };
    await using _screen = await render(
      <GTProvider locale={locale} translations={translations}>
        <ThemeImportDialog
          open
          onOpenChange={() => {}}
          onImported={() => true}
          onImportedMany={() => {}}
        />
      </GTProvider>,
    );

    // The entry button's name is translated, so it is found by its search icon.
    const openSearch = [...document.querySelectorAll("button")].find((button) =>
      button.querySelector(".lucide-search"),
    )!;
    await userEvent.click(openSearch);
    await userEvent.fill(page.getByRole("searchbox"), "night");

    // The download count is in the publisher's tooltip.
    await userEvent.hover(page.getByRole("searchbox"));
    await userEvent.hover(page.getByText("acme", { exact: true }));
    await vi.waitFor(() =>
      expect(document.querySelector("[data-slot=tooltip-popup]")?.textContent ?? "").toContain(
        line,
      ),
    );
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
    await userEvent.click(page.getByRole("button", { name: "Search community themes" }));
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
    await userEvent.click(page.getByRole("button", { name: "Add theme", exact: true }));

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

  // The staged row names the file above its error.
  await expect.element(page.getByText("huge.json", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent(
      "Diese Datei ist 1.00 MB groß. Design-Dateien haben nur wenige KB, daher wurde sie nicht gelesen (Limit 256 KB).",
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

    await expect
      .element(page.getByRole("button", { name: "Add theme", exact: true }))
      .toBeEnabled();
    await page.getByRole("button", { name: "Add theme", exact: true }).click();

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
  await userEvent.click(page.getByRole("button", { name: "Search community themes" }));
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
