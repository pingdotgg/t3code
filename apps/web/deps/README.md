The Words tarball comes from the [`fork/t3-words` branch](https://github.com/pingdotgg/pierre/tree/fork/t3-words) of our fork of [pierrecomputer/pierre](https://github.com/pierrecomputer/pierre). Its `t3-fork.json` records the source commit and the upstream base. The fork adds opt-in options, all off by default so default output stays byte-identical to upstream:

- `singleTilde: false`: only `~~` strikes.
- `windowsPaths`: backslashes in Windows drive paths stay.
- `codeMeta`: code fence info after the language becomes `data-meta`.
- `sourcePositions`: `data-sourcepos` byte ranges on list items, links, images, code blocks, math and directives.
- `directives`: the named remark-directive text and leaf directives.
- `escapeHtml`: raw HTML renders as escaped text.
- `leadingWhitespace`: spaces typed at the start of paragraph lines show, in `data-leading-whitespace` spans.
- `texDelimiters`: with `math`, `\(…\)` and `\[…\]` are math, as T3's llm-math reads them.

To replace it, commit the change on `fork/t3-words`, bump `packages/words/package.json` to the next `0.2.2-t3.N` and update `t3-fork.json`'s `source`, then run `moon run words:build` (or `node scripts/build.ts && tsdown`) and `npm pack` in `packages/words`. Name the archive with the first eight characters of the source commit, such as `pierre-words-0.2.2-t3.3-2cbd9ca0.tgz`, update the path in `apps/web/package.json`, and run `vp i`.

Change it through the fork, never with a pnpm patch: the next tarball would drop the patch without a trace.
