import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { GTProvider, type getTranslationsSnapshot } from "gt-react";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "../../i18n/locales";
import { UsageLimitsPooled } from "./UsageLimitsPooled";

const checkedAt = "2026-10-25T16:00:00.000Z";

function managedChatGpt(instanceId: string, displayName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName,
    enabled: true,
    installed: true,
    version: "0.164.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
      externalUsage: { label: "ChatGPT usage", url: CHATGPT_USAGE_URL },
    },
  };
}

describe("UsageLimitsPooled ChatGPT usage card", () => {
  it("names the managed connections it covers", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              managedChatGpt("chatgpt_work", "ChatGPT Work"),
              managedChatGpt("chatgpt_personal", "ChatGPT Personal"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect
      .element(screen.getByText("ChatGPT Work on Desk, ChatGPT Personal on Desk"))
      .toBeVisible();
    await expect
      .element(screen.getByText("View usage in ChatGPT with your connected account."))
      .toBeVisible();
  });
});

type TranslationCatalog = Awaited<ReturnType<typeof getTranslationsSnapshot>>[string];

const loadCatalog = import.meta.glob<TranslationCatalog>("../../i18n/translations/*.json", {
  import: "default",
});

const expectedLabels: Record<string, readonly string[]> = {
  de: [
    "Sitzung",
    "Wöchentlich",
    "Monatlich",
    "Monatliches Kreditlimit",
    "Wöchentlich · Test Model",
  ],
  en: ["Session", "Weekly", "Monthly", "Monthly credit limit", "Weekly · Test Model"],
  es: ["Sesión", "Semanal", "Mensual", "Límite de crédito mensual", "Semanal · Test Model"],
  fr: [
    "Session",
    "Hebdomadaire",
    "Mensuel",
    "Plafond mensuel de crédits",
    "Hebdomadaire · Test Model",
  ],
  ja: ["セッション", "週間", "月間", "月間クレジット上限", "週間 · Test Model"],
  ko: ["세션", "주간", "월간", "월간 크레딧 한도", "주간 · Test Model"],
  "pt-BR": ["Sessão", "Semanal", "Mensal", "Limite mensal de créditos", "Semanal · Test Model"],
  ru: ["За сеанс", "За неделю", "За месяц", "Месячный лимит кредитов", "За неделю · Test Model"],
  sv: ["Session", "Veckovis", "Månadsvis", "Månatlig kreditgräns", "Veckovis · Test Model"],
  zh: ["短期用量", "每周用量", "每月用量", "每月额度", "每周用量 · Test Model"],
};

it.each(SUPPORTED_LOCALES)(
  "localizes built-in window labels in %s and preserves provider-specific labels",
  async (locale) => {
    const provider = {
      ...managedChatGpt("codex", "Codex"),
      usageLimits: {
        checkedAt,
        windows: [
          { id: "primary", kind: "session", label: "Session", usedPercent: 26 },
          { id: "secondary", kind: "weekly", label: "Weekly", usedPercent: 38 },
          { id: "billing", kind: "monthly", label: "Monthly", usedPercent: 14 },
          { id: "credit", kind: "monthly", label: "Monthly credit limit", usedPercent: 12 },
          { id: "model", kind: "weekly", label: "Weekly · Test Model", usedPercent: 30 },
          { id: "custom", kind: "other", label: "Custom API limit", usedPercent: 10 },
        ],
      },
    } satisfies ServerProvider;
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        { entry: { target: { label: "Desk" } }, serverConfig: { providers: [provider] } },
      ],
    ]);
    const translations =
      locale === DEFAULT_LOCALE
        ? {}
        : await loadCatalog[`../../i18n/translations/${locale}.json`]!();
    await using screen = await render(
      <GTProvider locale={locale} translations={{ [locale]: translations }}>
        <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />
      </GTProvider>,
    );

    for (const label of expectedLabels[locale]!) {
      await expect.element(screen.getByText(label, { exact: true })).toBeVisible();
    }
    await expect.element(screen.getByText("Custom API limit", { exact: true })).toBeVisible();
  },
);
