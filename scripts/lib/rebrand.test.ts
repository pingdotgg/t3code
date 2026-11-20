// @effect-diagnostics nodeBuiltinImport:off - Reads the committed catalogs.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  catalogKey,
  rebrandCatalog,
  rebrandName,
  rebrandStrings,
  rebrandText,
  resolveAppName,
} from "./rebrand.ts";

const NAME = "EasyDev Code";

describe("rebrandText", () => {
  it.each([
    ["Restart T3 Code.", "Restart EasyDev Code."],
    ["T3 Code's MCP server", "EasyDev Code's MCP server"],
    ["Restart the T3 server", "Restart the EasyDev Code server"],
    ["passing --base-dir with this T3 home", "passing --base-dir with this EasyDev Code home"],
    [
      "{status, select, inProgress {Starting a T3 thread} other {Started a T3 thread}}",
      "{status, select, inProgress {Starting a EasyDev Code thread} other {Started a EasyDev Code thread}}",
    ],
    ["Open T3\n          Code", "Open EasyDev Code"],
    ["Sem o T3 Code, o T3 home fica", "Sem o EasyDev Code, o EasyDev Code home fica"],
    ["T3 Codeのサーバー", "EasyDev Codeのサーバー"],
  ])("renames %j", (text, expected) => {
    expect(rebrandText(text, NAME)).toBe(expected);
  });

  it.each([
    "Link T3 Connect for a public URL.",
    "Could not unlink T3 Chat account.",
    "Sign in to your T3 account",
    "Open T3 Account",
    "Copyright (c) T3 Tools Inc.",
    "T3CODE_HOME=~/.t3 t3 serve --base-dir t3code",
    'import { x } from "@t3tools/shared"',
    "T3-Code-${version}-${arch}.${ext}",
    "com.t3tools.T3Code",
  ])("leaves %j alone", (text) => {
    expect(rebrandText(text, NAME)).toBe(text);
  });
});

describe("rebrandName", () => {
  it("names only standalone builds that set their own name", () => {
    expect(rebrandName({ T3CODE_APP_NAME: NAME })).toBeNull();
    expect(rebrandName({ T3CODE_STANDALONE: "1" })).toBeNull();
    expect(rebrandName({ T3CODE_STANDALONE: "true", T3CODE_APP_NAME: ` ${NAME} ` })).toBe(NAME);
    expect(() => resolveAppName({ T3CODE_APP_NAME: 'Fork "Code"' })).toThrow("plain product name");
  });
});

describe("rebrandCatalog", () => {
  it("renames the product however a translation writes it", () => {
    const source = { [catalogKey("Send to a T3 thread", "ICU")]: "Send to a T3 thread" };
    const translated = {
      [catalogKey("Send to a T3 thread", "ICU")]: "An einen T3-Thread senden über T3 Connect",
    };
    expect(rebrandCatalog(source, translated, NAME)).toEqual({
      [catalogKey("Send to a EasyDev Code thread", "ICU")]:
        "An einen EasyDev Code-Thread senden über T3 Connect",
    });
  });

  const root = NodePath.resolve(import.meta.dirname, "../..");
  const read = (path: string) => JSON.parse(NodeFS.readFileSync(NodePath.join(root, path), "utf8"));

  it.each(["apps/web", "apps/mobile", "apps/desktop"])(
    "moves every %s translation that names the product to its renamed source's key",
    (app) => {
      const source: Record<string, unknown> = read(`${app}/src/i18n/translations/en.json`);
      const portuguese: Record<string, unknown> = read(`${app}/src/i18n/translations/pt-BR.json`);
      const rebranded = rebrandCatalog(source, portuguese, NAME);
      const named = Object.entries(source).filter(
        ([, text]) => JSON.stringify(rebrandStrings(text, NAME)) !== JSON.stringify(text),
      );
      expect(named.length).toBeGreaterThan(0);
      for (const [key, text] of named) {
        // Proves the hash matches GT's: the CLI wrote `key` for the unrenamed source.
        const format = (["ICU", "JSX"] as const).find((f) => catalogKey(text, f) === key);
        expect(format, key).toBeDefined();
        if (!format) continue;
        const renamed = rebrandedKey(text, format);
        expect(rebranded[renamed]).toBeDefined();
        expect(JSON.stringify(rebranded[renamed])).not.toContain("T3 Code");
      }
      expect(Object.keys(rebranded)).toHaveLength(Object.keys(portuguese).length);
    },
  );
});

const rebrandedKey = (text: unknown, format: "ICU" | "JSX") =>
  catalogKey(rebrandStrings(text, NAME), format);
