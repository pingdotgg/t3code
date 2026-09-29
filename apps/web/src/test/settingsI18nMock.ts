import { resources } from "@t3tools/i18n";

function valueAtPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function useTranslation(namespace = "common") {
  return {
    t: (key: string, options?: Record<string, unknown>) => {
      const dictionary = resources.en[namespace as keyof typeof resources.en];
      const value = valueAtPath(dictionary, key);
      if (typeof value !== "string") return key;
      return value.replace(/\{\{\s*([\w.]+)\s*\}\}/gu, (_match, name: string) =>
        String(options?.[name] ?? ""),
      );
    },
  };
}
