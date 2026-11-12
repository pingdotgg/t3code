import { type UiLocale, UI_LOCALES } from "@t3tools/contracts/settings";
import { LanguagesIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { i18n } from "../i18n";
import { useUiLocale, writeUiLocale } from "../hooks/useUiLocale";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";

// Language names render in their own language, so only "system" is translated.
const NATIVE_LANGUAGE_LABELS: Record<Exclude<UiLocale, "system">, string> = {
  en: "English",
  "zh-Hans": "简体中文",
};

export function uiLocaleLabel(uiLocale: UiLocale): string {
  return uiLocale === "system" ? i18n.t("uiLocale.system") : NATIVE_LANGUAGE_LABELS[uiLocale];
}

export function useCommandPaletteUiLocaleItems() {
  const { t } = useTranslation("settings");
  const uiLocale = useUiLocale();

  const changeUiLocaleItem: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:change-ui-locale",
    searchTerms: ["change interface language", "language", "中文", "简体中文", "语言", "locale"],
    title: t("uiLocale.change"),
    icon: <LanguagesIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <LanguagesIcon className={ADDON_ICON_CLASS} />,
    shortcutCommand: "uiLocale.cycle",
    groups: [
      {
        value: "ui-locales",
        label: t("uiLocale.change"),
        items: UI_LOCALES.map((locale) => ({
          kind: "action",
          value: `uiLocale:${locale}`,
          title: locale === "system" ? t("uiLocale.system") : NATIVE_LANGUAGE_LABELS[locale],
          searchTerms: [locale, "language", "语言"],
          icon: <LanguagesIcon className={ITEM_ICON_CLASS} />,
          titleTrailingContent:
            uiLocale === locale ? (
              <span className="text-xs text-muted-foreground/70">Current</span>
            ) : undefined,
          run: async () => {
            writeUiLocale(locale);
          },
        })),
      },
    ],
  };

  return { changeUiLocaleItem };
}
