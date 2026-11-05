The V5 file includes the `I/W217:220` fix (columns I and W, rows 217–220).

Rejected: `A/B12:40`, `foo/TODO:12`, `bin/run:12`, `foo/TODO:12:3`, `foo\TODO:12`.

Retained: `packages/shared/src/markdownLinks.ts:12`, `docs/README:12`, `./bin/run:12`, `TODO:12`, `../bin/run:12`.

Plain: `W217:W220`, `E29:E31`, `foo/TODO`, `src/main.ts/`.

Authored: [I/W217:220](I/W217:220), [friendly label](foo/TODO:12), [`foo/TODO:12`](foo/TODO:12).

Collision: `foo/TODO:12` and [TODO](other/TODO:12).

Wrap near the right edge: `I/W217:220` and `foo/TODO:12`, then `docs/README:12`.

```text
I/W217:220 foo/TODO:12 bin/run:12
```

Absolute controls: `/tmp/proof.ts:12`, `C:\proof\main.ts:12`, `.\bin\run:12`.
