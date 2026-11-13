# SchemaBinary fixed-width integer benchmark

Run the benchmark from the repository root:

```sh
nix develop -c pnpm --dir packages/effect exec node benchmark/schema/SchemaBinaryIntegers.ts
```

It encodes and decodes one four-field packet struct with `Schema.Int`, `Schema.Number` and the fixed-width schemas, for small and full-range values, in default and fingerprint mode. Frame cases encode each packet as its own frame; array cases encode all packets as one row run. It reports the encoded sizes and packets per second over three rounds in alternating order.

`Schema.Int` keeps the schema pass around the binary layer, while `Schema.Number` and the fixed-width schemas skip it, so compare `number` with `fixed` to see the encoding alone.
