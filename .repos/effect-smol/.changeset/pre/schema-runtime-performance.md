---
"effect": patch
---

Improve Schema parsing, schema construction and adapter runtime performance
while preserving current parsing behavior.

## Runtime performance

The `effect@beta`, Valibot and Zod timing cases from
[`open-circle/schema-benchmarks`](https://github.com/open-circle/schema-benchmarks)
were reproduced as a dedicated `runtimeperf` suite. The table includes every
case exposed by each upstream adapter; `—` means that the adapter does not
provide that benchmark.

Effect `main` (`45e781088`) and the branch based on `d775bf4b2` were compared
with five paired processes per case, 150 ms measurement time and 50 ms warmup.
The two initially inconclusive Effect cases were repeated with 15 paired
processes, 500 ms measurement time and 150 ms warmup. Valibot and Zod values
use five processes, 300 ms measurement time and 100 ms warmup. Environment:
Node `v24.12.0`, macOS arm64, Apple M3.

Zod parsing uses `safeParse` with `{ jitless: true }`; its Standard Schema and
codec cases use the corresponding native adapter APIs. All values are median
microseconds per operation (`µs/op`), lower is better. Cross-library values are
diagnostic because they are independent rather than paired measurements.

| Scenario                             | Effect `main` | Effect branch |    Valibot |      Zod 4 |   Delta | 95% CI             | Classification |
| ------------------------------------ | ------------: | ------------: | ---------: | ---------: | ------: | ------------------ | -------------- |
| Initialize schema                    |        137.28 |        118.23 |  **40.24** |     318.56 | -12.69% | -21.02% to -5.35%  | improvement    |
| Initialize schema and decoder        |        144.81 |    **130.50** |          — |          — | -10.88% | -14.22% to -3.29%  | improvement    |
| Validate valid product               |         8.478 |     **5.415** |       5.63 |          — | -35.18% | -41.65% to -32.83% | improvement    |
| Validate invalid product             |         1.516 |         1.348 | **0.2431** |          — | -11.59% | -13.81% to -6.31%  | improvement    |
| Parse valid product, all errors      |         8.360 |         5.366 |   **5.22** |       7.16 | -36.28% | -54.41% to -31.67% | improvement    |
| Parse invalid product, all errors    |        11.302 |     **9.100** |      15.70 |      41.58 | -19.42% | -21.32% to -13.12% | improvement    |
| Parse valid product, first error     |         8.201 |     **5.294** |       5.37 |          — | -35.44% | -37.75% to -34.59% | improvement    |
| Parse invalid product, first error   |         1.510 |         1.352 | **0.2572** |          — | -10.51% | -12.52% to -9.53%  | improvement    |
| Standard Schema valid, all errors    |         9.284 |         5.935 |       5.35 |   **3.83** | -35.96% | -53.29% to -33.49% | improvement    |
| Standard Schema invalid, all errors  |        16.718 |    **15.203** |      16.51 |      32.85 | -11.31% | -13.97% to -7.65%  | improvement    |
| Standard Schema valid, first error   |         8.889 |     **5.843** |          — |          — | -34.17% | -35.13% to -33.94% | improvement    |
| Standard Schema invalid, first error |         2.435 |     **2.244** |          — |          — |  -8.44% | -12.76% to -4.82%  | improvement    |
| Typed codec encode                   |        0.4692 |        0.3420 |          — | **0.0405** | -27.60% | -32.35% to -22.50% | improvement    |
| Typed codec decode                   |        0.5191 |        0.3762 |          — | **0.0463** | -27.19% | -34.75% to -22.71% | improvement    |
| Unknown codec encode                 |        0.4910 |    **0.3472** |          — |          — | -28.58% | -30.42% to -27.59% | improvement    |
| Unknown codec decode                 |        0.5061 |    **0.3637** |          — |          — | -29.26% | -29.82% to -21.70% | improvement    |

Overall Effect classification: 16 improvements and no regressions.
