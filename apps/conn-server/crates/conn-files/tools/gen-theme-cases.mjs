// T3's environment theme rules, recorded for the Rust tests and the server:
// - src/themes/upstream.json: the guide `t3_theme_read` returns, the built-in theme ids and the
//   ids nobody may publish (packages/shared themeCss.ts and themePalettes.ts).
// - src/themes/cases.json: `EnvironmentThemeFile` decoded from JSON, its pretty encoding,
//   `environmentThemeFileHasColors`, and `themeCssLoadsRemoteFiles`, for chosen inputs.
//   node crates/conn-files/tools/gen-theme-cases.mjs [--check]
import * as fs from "node:fs";
import { importSource, packageImporter } from "../../../tools/monorepo.mjs";

const contracts = await importSource("packages/contracts/src/server.ts");
const css = await importSource("packages/shared/src/themeCss.ts");
const palettes = await importSource("packages/shared/src/themePalettes.ts");
const schemaJson = await importSource("packages/shared/src/schemaJson.ts");
const Schema = await packageImporter("apps/server")("effect/Schema");

const decode = Schema.decodeUnknownExit(Schema.fromJsonString(contracts.EnvironmentThemeFile));
const encode = Schema.encodeUnknownExit(schemaJson.fromJsonStringPretty(contracts.EnvironmentThemeFile));
const isId = Schema.is(contracts.EnvironmentThemeId);

const base = { name: "Night", appearance: "dark", canvas: "#101010", accent: "#ff8800" };
const file = (extra) => JSON.stringify({ ...base, ...extra });
const files = [
  file({}),
  file({ version: 1 }),
  file({ version: 2 }),
  file({ version: null }),
  file({ name: "  Padded  " }),
  file({ name: "   " }),
  file({ name: "x".repeat(48) }),
  file({ name: "x".repeat(49) }),
  file({ name: " ".repeat(3) + "x".repeat(48) + " " }),
  file({ name: " Nbsp﻿" }),
  file({ name: "😀".repeat(24) }),
  file({ name: "😀".repeat(25) }),
  file({ name: 5 }),
  file({ appearance: "system" }),
  file({ canvas: "#abc" }),
  file({ canvas: "#ABCDEF" }),
  file({ canvas: "#abcd" }),
  file({ canvas: "abc" }),
  file({ canvas: "#abc\n" }),
  file({ canvas: undefined, accent: undefined }),
  file({ canvas: undefined }),
  file({ canvas: undefined, accent: undefined, colors: {} }),
  file({ canvas: undefined, accent: undefined, colors: { canvas: "#000" } }),
  file({ colors: { canvas: "  red  " } }),
  file({ colors: { canvas: "   " } }),
  file({ colors: { canvas: "x".repeat(64) } }),
  file({ colors: { canvas: "x".repeat(65) } }),
  file({ colors: { "1bad": "#000" } }),
  file({ colors: { "bad-key": "#000" } }),
  file({ colors: { ["a".repeat(64)]: "#000" } }),
  file({ colors: { ["a".repeat(65)]: "#000" } }),
  file({ colors: { ok: 5 } }),
  file({ colors: [] }),
  file({ colors: { "1bad": 5, good: " #000 " } }),
  file({ variants: { light: null } }),
  `{"version":1.0,"name":"N","appearance":"dark","canvas":"#000","accent":"#111"}`,
  file({ variants: { light: { canvas: "#fff" } } }),
  file({ variants: { light: { canvas: " #fff " }, dark: {}, other: 1 } }),
  file({ variants: { light: { "-x": "#fff" } } }),
  file({ variants: null }),
  file({ css: "body { color: red; }" }),
  file({ css: "x".repeat(100_000) }),
  file({ css: "x".repeat(100_001) }),
  file({ css: "😀".repeat(50_000) }),
  file({ css: "😀".repeat(50_001) }),
  file({ css: "  " }),
  file({ extra: true, nested: { a: 1 } }),
  file({ css: "\u0000\u001f </script>" }),
  JSON.stringify({ colors: { canvas: "#000" }, css: "a{}", appearance: "light", name: "Order", version: 1 }),
  "﻿" + file({}),
  `{"name":"A","name":"B","appearance":"dark","canvas":"#000","accent":"#111"}`,
  "[]",
  "null",
  "",
  "   ",
  "{",
  `{"name":"N","appearance":"dark","canvas":"#000","accent":"#111","css":"\\ud800"}`,
];
const cases = [];
for (const raw of files) {
  const decoded = decode(raw);
  if (decoded._tag === "Failure") {
    cases.push({ kind: "file", raw, decoded: null });
    continue;
  }
  const encoded = encode(decoded.value);
  cases.push({
    kind: "file",
    raw,
    decoded: JSON.stringify(decoded.value),
    encoded: encoded._tag === "Success" ? encoded.value : null,
    hasColors: contracts.environmentThemeFileHasColors(decoded.value),
  });
}
for (const id of [
  "night", "a", "a-b-c", "-a", "a-", "A", "system", "light", "dark", "t3-code", "t3-chat", "grove",
  "a".repeat(48), "a".repeat(49), "9lives", "a_b", "a.b", "", "night\n", "t3-ember", "émile",
]) {
  cases.push({ kind: "id", id, valid: isId(id), unpublishable: palettes.UNPUBLISHABLE_THEME_IDS.has(id) });
}
for (const text of [
  "body { color: red }",
  "@import 'x.css';",
  "@IMPORT url(x)",
  "/* @import */ body{}",
  "/* unterminated @import",
  "a { background: url(data:image/png;base64,AA) }",
  "a { background: url( data:x) }",
  "a { background: url(\t\"data:x\") }",
  "a { background: url('#id') }",
  "a { background: url(#id) }",
  "a { background: url(https://x/y.png) }",
  "a { background: URL(https://x) }",
  "a { background: url('https://x') }",
  "a { background: url( 'https://x' ) }",
  "a { background: url(\"data:x\") url(https://y) }",
  "a { content: 'url(https://x)' }",
  "a { content: \"@import\" }",
  "a { content: 'unterminated url(https://x)\n' }",
  "a { background: image-set('a.png' 1x) }",
  "a { background: Image-Set(x) }",
  "a { mask: src(x) }",
  "a { mask: xsrc(x) }",
  "a { mask: _src(x) }",
  "a { mask: -src(x) }",
  "a { background: url(\"#a\" }",
  "a { background: url( data:x) }",
  "a { background: url(\"x\" data:) }",
  "a { background: url(x'y) }",
  "a { background: url('a' }",
  "a { b: \"x\\\"url(https://y)\" }",
  "a { background: url(\n'#x') }",
  "a { content: '/*' } @import x; /* */",
  "url(",
  "url(data:",
  "a{background:url( \"data:x\" )}",
  "a { b: u\\rl(x) }",
  "a { background: url('data:x' }",
  "a { background: url(\"\") }",
  "a { background: url() }",
  "a { background: url('DATA:x') }",
  "a { background: url(DaTa:x) }",
  "a { content: \"a\nurl(https://x)\" }",
  "a { content: 'a\fb' url(x) }",
  "@importx",
  "a { content: url('data:x') 'url(https://x)' }",
]) {
  cases.push({ kind: "css", css: text, loads: css.themeCssLoadsRemoteFiles(text) });
}

const upstream = {
  guide: css.THEME_GUIDE,
  builtIn: [...palettes.MOBILE_THEME_IDS],
  defaultId: palettes.MOBILE_DEFAULT_THEME_ID,
  unpublishable: [...palettes.UNPUBLISHABLE_THEME_IDS].sort(),
};
const outputs = [
  [new URL("../src/themes/cases.json", import.meta.url), `[\n${cases.map((c) => JSON.stringify(c)).join(",\n")}\n]\n`],
  [new URL("../src/themes/upstream.json", import.meta.url), `${JSON.stringify(upstream, null, 2)}\n`],
];
if (process.argv.includes("--check")) {
  for (const [path, text] of outputs) {
    if (fs.readFileSync(path, "utf8") !== text) {
      throw new Error(`${path.pathname} is stale; run gen-theme-cases.mjs and port the difference`);
    }
  }
  console.log(`theme characterizations: ${cases.length} T3 cases current`);
} else {
  fs.mkdirSync(new URL("../src/themes/", import.meta.url), { recursive: true });
  for (const [path, text] of outputs) fs.writeFileSync(path, text);
  console.log(`recorded ${cases.length} theme characterizations`);
}
