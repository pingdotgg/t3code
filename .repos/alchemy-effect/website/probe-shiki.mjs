import { createHighlighter } from "shiki/index.mjs";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
const hl = await createHighlighter({
  themes: ["github-dark"],
  langs: ["typescript"],
  engine: await createOnigurumaEngine(import("shiki/wasm")),
});
const code = `import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
export default Alchemy.Stack(
  "MyApp",
  {},
  Effect.gen(function* () {
    yield* Photos;
  }),
);`;
const tokens = hl.codeToTokensBase(code, {
  lang: "typescript",
  theme: "github-dark",
  includeExplanation: "scopeName",
});
for (const line of tokens) {
  for (const t of line) {
    if (!t.content.trim()) continue;
    const scopes = (t.explanation?.[0]?.scopes ?? [])
      .map((s) => s.scopeName)
      .join(" → ");
    console.log(JSON.stringify(t.content).padEnd(14), scopes);
  }
  console.log("---");
}
