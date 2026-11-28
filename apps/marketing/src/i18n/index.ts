import { de } from "./de";
import { en, type Messages } from "./en";
import { es } from "./es";
import { fr } from "./fr";
import { ja } from "./ja";
import { ko } from "./ko";
import { pl } from "./pl";
import type { Locale } from "./locales";
import { ptBR } from "./pt-BR";
import { ru } from "./ru";
import { vi } from "./vi";
import { zh } from "./zh";

const MESSAGES: Record<Locale, Messages> = {
  en,
  es,
  "zh-Hans": zh,
  "pt-BR": ptBR,
  fr,
  de,
  ja,
  ko,
  pl,
  ru,
  vi,
};

export const messagesFor = (locale: Locale): Messages => MESSAGES[locale];
