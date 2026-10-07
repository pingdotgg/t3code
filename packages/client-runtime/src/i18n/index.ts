import type { InterfaceLanguage } from "@t3tools/contracts/settings";

import { zhCN } from "./zhCN";

/** English source messages are the fallback while surfaces migrate incrementally. */
export function createTranslator(language: InterfaceLanguage) {
  return (message: string, values: Readonly<Record<string, string | number>> = {}): string => {
    const translated =
      language === "zh-CN" && Object.prototype.hasOwnProperty.call(zhCN, message)
        ? zhCN[message]!
        : message;
    // Substitute in one pass so user values containing braces are never interpreted as copy.
    return translated.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (placeholder, name: string) =>
      Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : placeholder,
    );
  };
}
