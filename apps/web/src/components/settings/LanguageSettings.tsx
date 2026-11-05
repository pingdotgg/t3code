import { Trans } from "@palamedes/react/macro";
import { t } from "@palamedes/core/macro";
import { useState } from "react";

import {
  APP_LOCALES,
  LOCALE_LABELS,
  applyLocale,
  currentLocale,
  isAppLocale,
} from "../../i18n/locale";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function LanguageSettings() {
  const activeLocale = currentLocale();
  const [locale, setLocale] = useState(activeLocale);
  const [failed, setFailed] = useState(false);

  return (
    <SettingsSection id="language" title={t`Language`}>
      <SettingsRow
        id="interface-language"
        title={t`Interface language`}
        description={t`Applies to this browser or desktop app. Applying the language reloads the page. Save any unfinished work first.`}
        control={
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <Select
              value={locale}
              onValueChange={(value) => {
                if (isAppLocale(value)) {
                  setLocale(value);
                  setFailed(false);
                }
              }}
            >
              <SelectTrigger size="sm" aria-label={t`Interface language`}>
                <SelectValue>{LOCALE_LABELS[locale]}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {APP_LOCALES.map((value) => (
                  <SelectItem key={value} value={value}>
                    <span lang={value}>{LOCALE_LABELS[value]}</span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              size="sm"
              disabled={locale === activeLocale}
              onClick={() => {
                try {
                  applyLocale(locale);
                } catch {
                  setFailed(true);
                }
              }}
            >
              <Trans>Apply and reload</Trans>
            </Button>
          </div>
        }
      />
      {failed ? (
        <p role="alert" className="px-4 py-2 text-sm text-destructive">
          <Trans>Could not save the language. Allow local storage and try again.</Trans>
        </p>
      ) : null}
    </SettingsSection>
  );
}
