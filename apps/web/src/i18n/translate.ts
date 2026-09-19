import { useSyncExternalStore } from "react";

import { DEFAULT_INTERFACE_LANGUAGE, type InterfaceLanguage } from "@t3tools/contracts/settings";

import { ZH_CN_DICTIONARY } from "./dictionary";

type Listener = () => void;

let currentLanguage: InterfaceLanguage = DEFAULT_INTERFACE_LANGUAGE;
let languageConfigured = false;
const listeners = new Set<Listener>();

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): InterfaceLanguage {
  return currentLanguage;
}

/**
 * Imperatively set the active language. Called by the settings row's
 * subscription once client settings hydrate and whenever the persisted value
 * changes, so non-React modules (search, formatting) can read the same value.
 */
export function setInterfaceLanguage(language: InterfaceLanguage): void {
  if (currentLanguage === language) return;
  currentLanguage = language;
  emitChange();
}

/** Mark the language store as configured so React can skip the default flash. */
export function markInterfaceLanguageConfigured(): void {
  languageConfigured = true;
  emitChange();
}

export function isInterfaceLanguageConfigured(): boolean {
  return languageConfigured;
}

/** React hook returning the active interface language. */
export function useInterfaceLanguage(): InterfaceLanguage {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Translate an English source string into the active language. Falls back to
 * the source string when no translation exists, so partial dictionaries ship
 * safely.
 */
export function translate(source: string, language: InterfaceLanguage = currentLanguage): string {
  if (language !== "zh-CN") return source;
  return ZH_CN_DICTIONARY[source] ?? source;
}

/** React hook translating an English source string. */
export function useTranslate() {
  const language = useInterfaceLanguage();
  return (source: string) => translate(source, language);
}
