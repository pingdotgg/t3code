---
"effect": patch
---

Remove `actual` fields from every `SchemaIssue` variant, together with
`SchemaIssue.getActual`, `SchemaIssue.redact`, and `Schema.redact`. Built-in
formatters now use static messages that do not interpolate rejected input,
while paths, AST metadata, union successes, and user-provided messages and
annotations are preserved unchanged.

Runtime performance was measured across the 16 Effect fixtures in the
`schema-benchmarks` suite. These are the scenarios used for the cross-library
comparison with Valibot and Zod. The paired HEAD-versus-`main` run classified 3
fixtures as improvements, 0 as regressions, and 13 as inconclusive. Negative
changes are faster. Absolute library values are medians from the same
cross-library run; `—` means that the corresponding adapter does not expose
that scenario.

| Scenario                 | Effect (ns/op) | Valibot (ns/op) | Zod (ns/op) | HEAD vs main | Classification |
| ------------------------ | -------------: | --------------: | ----------: | -----------: | -------------- |
| `initialization-schema`  |      108191.30 |    **30549.81** |   212715.66 |       -0.92% | inconclusive   |
| `initialization-decoder` |  **109796.34** |               — |           — |       +1.98% | inconclusive   |
| `validation-valid`       |        5221.80 |     **5070.81** |           — |       +2.06% | inconclusive   |
| `validation-invalid`     |        1279.77 |      **234.92** |           — |       +0.59% | inconclusive   |
| `parsing-all-valid`      |    **5144.58** |         5192.19 |     7176.19 |       -3.79% | inconclusive   |
| `parsing-all-invalid`    |    **7594.49** |        15236.82 |    37780.35 |       -5.94% | improvement    |
| `parsing-first-valid`    |        5188.33 |     **5135.75** |           — |       -1.49% | inconclusive   |
| `parsing-first-invalid`  |        1330.82 |      **243.64** |           — |       +1.01% | inconclusive   |
| `standard-all-valid`     |        5722.01 |         5200.05 | **3801.26** |       -1.78% | inconclusive   |
| `standard-all-invalid`   |   **12024.65** |        15528.50 |    30982.17 |       -7.78% | improvement    |
| `standard-first-valid`   |    **5655.33** |               — |           — |       +3.84% | inconclusive   |
| `standard-first-invalid` |    **2001.69** |               — |           — |       -4.56% | inconclusive   |
| `codec-typed-encode`     |         342.59 |               — |   **39.29** |       -7.62% | inconclusive   |
| `codec-typed-decode`     |         418.78 |               — |   **50.14** |      -10.89% | improvement    |
| `codec-unknown-encode`   |     **328.38** |               — |           — |       -5.55% | inconclusive   |
| `codec-unknown-decode`   |     **347.35** |               — |           — |       -5.25% | inconclusive   |
