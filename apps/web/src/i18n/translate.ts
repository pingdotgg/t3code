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

/** Read the active language from non-React formatting and state modules. */
export function getInterfaceLanguage(): InterfaceLanguage {
  return currentLanguage;
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
  const direct = ZH_CN_DICTIONARY[source];
  if (direct !== undefined) return direct;
  const settledCount = /^Settled \((\d+)\)$/.exec(source)?.[1];
  if (settledCount !== undefined) return `已收档 (${settledCount})`;
  const snoozedCount = /^Snoozed \((\d+)\)$/.exec(source)?.[1];
  if (snoozedCount !== undefined) return `已搁置 (${snoozedCount})`;
  const unpinCount = /^Unpin \((\d+)\)$/.exec(source)?.[1];
  if (unpinCount !== undefined) return `取消置顶 (${unpinCount})`;
  const settleCount = /^Settle \((\d+)\)$/.exec(source)?.[1];
  if (settleCount !== undefined) return `收档 (${settleCount})`;
  const snoozeCount = /^Snooze \((\d+)\)$/.exec(source)?.[1];
  if (snoozeCount !== undefined) return `搁置 (${snoozeCount})`;
  const markUnreadCount = /^Mark unread \((\d+)\)$/.exec(source)?.[1];
  if (markUnreadCount !== undefined) return `标记为未读 (${markUnreadCount})`;
  const deleteCount = /^Delete \((\d+)\)$/.exec(source)?.[1];
  if (deleteCount !== undefined) return `删除 (${deleteCount})`;
  const regenerateTitlesCount = /^Regenerate titles \((\d+)\)$/.exec(source)?.[1];
  if (regenerateTitlesCount !== undefined) return `重新生成标题 (${regenerateTitlesCount})`;
  const regeneratingCount = /^Regenerating… \((\d+)\)$/.exec(source)?.[1];
  if (regeneratingCount !== undefined) return `正在重新生成… (${regeneratingCount})`;
  const workedDuration = /^Worked for (.+)$/.exec(source)?.[1];
  if (workedDuration !== undefined) return `运行了 ${workedDuration}`;
  if (source === "Worked") return "运行中";
  const modelPickerJump = /^Model Picker: Jump: (\d+)$/.exec(source)?.[1];
  if (modelPickerJump !== undefined) return `模型选择器：跳转：${modelPickerJump}`;
  const threadJump = /^Thread: Jump: (\d+)$/.exec(source)?.[1];
  if (threadJump !== undefined) return `线程：跳转：${threadJump}`;
  return source;
}

/** React hook translating an English source string. */
export function useTranslate() {
  const language = useInterfaceLanguage();
  return (source: string) => translate(source, language);
}
