import { describe, expect, it } from "vite-plus/test";
import { resources } from "./resources";

function interpolationNames(value: string): ReadonlyArray<string> {
  return [...value.matchAll(/\{\{\s*([\w.]+)\s*\}\}/gu)].map((match) => match[1]!).toSorted();
}

function translationEntries(value: object, prefix = ""): ReadonlyArray<readonly [string, string]> {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof child === "string"
      ? [[path, child] as const]
      : translationEntries(child as object, path);
  });
}

describe("translation resources", () => {
  it("keeps every locale's keys and interpolation variables in sync", () => {
    for (const namespace of Object.keys(resources.en) as ReadonlyArray<keyof typeof resources.en>) {
      const english = translationEntries(resources.en[namespace]);
      const chinese = translationEntries(resources["zh-CN"][namespace]);
      expect(chinese.map(([key]) => key).toSorted(), `${namespace} keys`).toEqual(
        english.map(([key]) => key).toSorted(),
      );

      const chineseByKey = new Map(chinese);
      for (const [key, englishValue] of english) {
        expect(
          interpolationNames(chineseByKey.get(key)!),
          `${namespace}.${key} interpolations`,
        ).toEqual(interpolationNames(englishValue));
      }
    }
  });
});
