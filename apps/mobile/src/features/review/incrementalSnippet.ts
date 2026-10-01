import type { HighlighterCore } from "@shikijs/core";

/** A code block owns this session. Only completed lines survive the next update. */
export function createIncrementalSnippet(
  highlighter: HighlighterCore,
  language: string,
  theme: string,
) {
  const options = { lang: language, theme };
  let cached:
    | {
        prefix: string;
        tokens: ReturnType<HighlighterCore["codeToTokensBase"]>;
        state: ReturnType<HighlighterCore["getLastGrammarState"]>;
      }
    | undefined;
  let revision = 0;

  function* tokenize(code: string) {
    const currentRevision = ++revision;
    const previous = cached && code.startsWith(cached.prefix) ? cached : undefined;
    const end = code.lastIndexOf("\n") + 1;
    let state = previous?.state;
    const tokens = [...(previous?.tokens ?? [])];
    const completed = code.slice(previous?.prefix.length ?? 0, end);
    if (completed) {
      const lines = completed.slice(0, -1).split("\n");
      for (let offset = 0; offset < lines.length; offset += 200) {
        const batch = highlighter.codeToTokensBase(lines.slice(offset, offset + 200).join("\n"), {
          ...options,
          ...(state ? { grammarState: state } : {}),
        });
        state = highlighter.getLastGrammarState(batch);
        tokens.push(...batch);
        if (offset + 200 < lines.length) yield;
      }
    }
    if (currentRevision === revision) {
      cached = state ? { prefix: code.slice(0, end), tokens, state } : undefined;
    }
    return [
      ...tokens,
      ...highlighter.codeToTokensBase(code.slice(end), {
        ...options,
        ...(state ? { grammarState: state } : {}),
      }),
    ];
  }
  const highlight = async (code: string) => {
    const work = tokenize(code);
    let next = work.next();
    while (!next.done) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      next = work.next();
    }
    return next.value;
  };
  // A small append can finish during render, avoiding a plain-text commit before
  // the asynchronous effect supplies colors. Cold/large changes stay asynchronous.
  highlight.read = (code: string) => {
    if (!cached || !code.startsWith(cached.prefix)) return undefined;
    const tail = code.slice(cached.prefix.length);
    if (tail.length > 2_000 || tail.split("\n").length > 200) return undefined;
    const next = tokenize(code).next();
    return next.done ? next.value : undefined;
  };
  return highlight;
}
