import { describe, expect, it } from "@alchemy.run/test";
import { collectNamespaceImportEdits } from "@/Bundle/NamespaceImportPlugin";

const isAlchemy = (specifier: string) => /^(alchemy|@alchemy\.run\/[^/]+)(\/|$)/.test(specifier);

/** Applies the plugin's edits to `code`, or returns `null` when it leaves the file alone. */
const rewrite = async (code: string, filename = "/proj/src/api.ts") => {
  const edits = await collectNamespaceImportEdits(code, filename, isAlchemy);
  if (edits.length === 0) return null;
  let out = code;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
};

describe("collectNamespaceImportEdits", { tags: ["unit", "local"] }, () => {
  it("rewrites static member access into named imports", async () => {
    const code = [
      `import * as AWS from "@alchemy.run/aws";`,
      `export default class Api extends AWS.Lambda.Function<Api>()("Api", {}) {}`,
      `export const layer = AWS.S3.GetObjectHttp;`,
      `export const lambda = AWS.Lambda;`,
    ].join("\n");
    expect(await rewrite(code)).toBe(
      [
        `import { Lambda as AWS$Lambda, S3 as AWS$S3 } from "@alchemy.run/aws";`,
        `export default class Api extends AWS$Lambda.Function<Api>()("Api", {}) {}`,
        `export const layer = AWS$S3.GetObjectHttp;`,
        `export const lambda = AWS$Lambda;`,
      ].join("\n"),
    );
  });

  it("imports members only read in types as type-only", async () => {
    const code = [
      `import * as AWS from "@alchemy.run/aws";`,
      `export const fn = (props: AWS.Lambda.FunctionProps) => AWS.S3.Bucket(props);`,
    ].join("\n");
    expect(await rewrite(code)).toBe(
      [
        `import { type Lambda as AWS$Lambda, S3 as AWS$S3 } from "@alchemy.run/aws";`,
        `export const fn = (props: AWS$Lambda.FunctionProps) => AWS$S3.Bucket(props);`,
      ].join("\n"),
    );
  });

  it("rewrites a member read both as a value and as a type as a value import", async () => {
    const code = [
      `import * as AWS from "@alchemy.run/aws";`,
      `export const region: AWS.Region = AWS.Region;`,
    ].join("\n");
    expect(await rewrite(code)).toBe(
      [
        `import { Region as AWS$Region } from "@alchemy.run/aws";`,
        `export const region: AWS$Region = AWS$Region;`,
      ].join("\n"),
    );
  });

  it("imports members read in interface heritage and implements clauses as type-only", async () => {
    const code = [
      `import * as Bundle from "alchemy/Bundle/Bundle";`,
      `export interface Options extends Bundle.BundleConfig {}`,
      `export class Plugin implements Bundle.Plugin {}`,
      `export const build = Bundle.build;`,
    ].join("\n");
    expect(await rewrite(code)).toBe(
      [
        `import { type BundleConfig as Bundle$BundleConfig, type Plugin as Bundle$Plugin, build as Bundle$build } from "alchemy/Bundle/Bundle";`,
        `export interface Options extends Bundle$BundleConfig {}`,
        `export class Plugin implements Bundle$Plugin {}`,
        `export const build = Bundle$build;`,
      ].join("\n"),
    );
  });

  it("imports members read in a type query as type-only", async () => {
    const code = [
      `import * as AWS from "@alchemy.run/aws";`,
      `export type Fn = typeof AWS.Lambda.Function;`,
    ].join("\n");
    expect(await rewrite(code)).toBe(
      [
        `import { type Lambda as AWS$Lambda } from "@alchemy.run/aws";`,
        `export type Fn = typeof AWS$Lambda.Function;`,
      ].join("\n"),
    );
  });

  it("picks an alias that doesn't collide with existing names", async () => {
    const code = [
      `import * as AWS from "@alchemy.run/aws";`,
      `const AWS$Lambda = 1;`,
      `export const f = [AWS.Lambda, AWS$Lambda];`,
    ].join("\n");
    expect(await rewrite(code)).toContain(
      `import { Lambda as AWS$Lambda$ } from "@alchemy.run/aws";`,
    );
  });

  it("leaves packages outside the list alone", async () => {
    const code = `import * as Effect from "effect/Effect";\nexport const x = Effect.void;\n`;
    expect(await rewrite(code)).toBeNull();
  });

  for (const [reason, use] of [
    ["the namespace is passed around", `export const all = AWS;`],
    ["the namespace is spread", `export const all = { ...AWS };`],
    ["a member is computed", `export const fn = AWS["Lambda"];`],
    ["a local binding shadows the name", `export const f = (AWS: any) => AWS.Lambda;`],
    ["the namespace is queried as a type", `export type All = typeof AWS;`],
    ["the namespace is re-exported", `export { AWS };`],
    ["a TypeScript import alias reads it", `import L = AWS.Lambda;`],
  ]) {
    it(`leaves the import alone when ${reason}`, async () => {
      const code = `import * as AWS from "@alchemy.run/aws";\nexport const ok = AWS.Lambda;\n${use}\n`;
      expect(await rewrite(code)).toBeNull();
    });
  }

  it("leaves the import alone when the namespace is used in JSX", async () => {
    const code = `import * as UI from "@alchemy.run/ui";\nexport const el = <UI.Button />;\n`;
    expect(await rewrite(code, "/proj/src/app.tsx")).toBeNull();
  });

  it("leaves type-only namespace imports alone", async () => {
    const code = `import type * as AWS from "@alchemy.run/aws";\nexport type P = AWS.Lambda.FunctionProps;\n`;
    expect(await rewrite(code)).toBeNull();
  });

  it("rewrites JavaScript files", async () => {
    const code = `import * as Alchemy from "alchemy";\nexport default Alchemy.Stack;\n`;
    expect(await rewrite(code, "/proj/node_modules/app/dist/index.js")).toBe(
      `import { Stack as Alchemy$Stack } from "alchemy";\nexport default Alchemy$Stack;\n`,
    );
  });
});
