import { describe, expect, it } from "vite-plus/test";

import {
  CODE_BLOCK_LANGUAGES,
  codeLanguageLabel,
  languageOfInfoString,
  withInfoStringLanguage,
} from "./composer-code-languages";

describe("languageOfInfoString", () => {
  it.each([
    ["", ""],
    ["ts", "ts"],
    ["  ts  ", "ts"],
    ["js title=example", "js"],
    ["typescript ", "typescript"],
  ])("reads %j as %j", (info, language) => {
    expect(languageOfInfoString(info)).toBe(language);
  });
});

describe("withInfoStringLanguage", () => {
  it.each([
    ["", "ts", "ts"],
    ["js", "python", "python"],
    ["js title=example", "ts", "ts title=example"],
    ["js  {1,3}", "ts", "ts  {1,3}"],
    ["js", "", ""],
    ["js title=example", "", "text title=example"],
    ["  js title=x", "python", "  python title=x"],
    ["  js title=x", "", "  text title=x"],
    [" js", "go", " go"],
    ["  ", "go", "  go"],
  ])("sets %j to %j as %j", (info, language, expected) => {
    expect(withInfoStringLanguage(info, language)).toBe(expected);
  });
});

describe("codeLanguageLabel", () => {
  it.each([
    ["", "Plain text"],
    ["text", "Plain text"],
    ["cpp", "C++"],
    ["ts", "TypeScript"],
    ["arduino", "arduino"],
  ])("labels %j as %j", (language, label) => {
    expect(codeLanguageLabel(language)).toBe(label);
  });

  it("lists every language once, plain text first", () => {
    const ids = CODE_BLOCK_LANGUAGES.map((language) => language.id);
    expect(ids[0]).toBe("");
    expect(new Set(ids).size).toBe(ids.length);
  });
});
