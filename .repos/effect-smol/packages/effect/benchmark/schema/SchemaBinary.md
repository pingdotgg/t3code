# SchemaBinary benchmark

Run from the repository root:

```sh
nix develop -c pnpm --dir packages/effect exec node benchmark/schema/SchemaBinary.ts
```

To repeat the raw msgpackr cases without its native string extractor:

```sh
nix develop -c env MSGPACKR_NATIVE_ACCELERATION_DISABLED=true pnpm --dir packages/effect exec node benchmark/schema/SchemaBinary.ts
```

These results are from one full run with fingerprint-mode row runs on Linux x86_64 (AMD EPYC 4344P) with Node 26.7.0. Codec and schema construction are excluded. One-shot tasks use 100 warmups and 1,000 measured samples; streaming tasks use 25 warmups and 250 measured samples. Throughput is machine-local and should only be compared within this run.

Both modes pack each field id with a wire kind, so varint numbers, decimals, and booleans skip the per-field length prefix and booleans ride in the tag itself. Short decimals such as `12.5` encode as a varint mantissa plus a scale instead of an eight-byte f64, and index-signature record pairs pack the value kind into the key-length varint. An array of structs is written as a row run: each distinct set of present fields declares its shape once, and later rows reference that shape and any string already written in the same slot. Fingerprint mode omits field identifiers entirely: single frames use positional layouts and its row shapes are presence masks instead of field id lists. JSON, Msgpack, and NDJSON use the same `Schema.toCodecJson` representation.

Protobuf uses `protobufjs` reflection types parsed once before timing. `Schema.Number` maps to proto3 `double`, records map to `map<string, double>`, and top-level arrays and records use wrapper messages. Tuple samples and nested arrays use messages because protobuf does not support either shape directly. The timed decode paths include `toObject` and the case adapters, so every format produces its final application value. Descriptor construction and Protobuf encode adapters are excluded.

Every format is timed through its public API, so the SchemaBinary and JSON / Msgpack numbers include the Schema pass that produces or validates the application value. Where the binary layer already validates a schema on its own, `toCodec` skips that pass in both directions rather than repeating the work: encoding runs the binary encoder directly, and decoding hands the value it just produced straight through. Any input the binary layer did not produce, `Schema.is` included, still runs the real check.

The raw serializer section deliberately relaxes that rule. It compares the public SchemaBinary codec with raw msgpackr and JSON calls that do not validate the application value. `Effect Msgpack schema` remains in those tables as the public-API comparison. The benchmark prints whether msgpackr's native string extractor is active.

A static `.proto` must pick one numeric type for `Schema.Number`, so integral values pay eight bytes where SchemaBinary picks a varint per value. Typing the known-integer fields as `uint32` would reduce the 200-row Protobuf payload from 24,480 to 20,600 bytes and the small record from 42 to 35, but would no longer cover the full `Schema.Number` domain. The reported sizes also reflect `protobufjs` 7.6.5 encoding default-valued scalars such as `verified: false`; an encoder that applies proto3 implicit presence would omit them.

The streaming setup compares the closest public decode paths. SchemaBinary reuses one synchronous parser for each feed shape. Protobuf calls `decodeDelimited` across the batch and materializes every message with `toObject` plus the case adapter. Msgpack synchronously calls `unpackMultiple` on the batch, then validates each value. NDJSON runs `Ndjson.decodeSchema` through Effect Stream and Channel for every operation, including UTF-8 decoding, line splitting, `JSON.parse`, schema validation, and runtime scheduling. A batch is one Channel run over 32 lines, or 200 lines for the per-frame case. Single and fragmented measurements each run a complete Channel for one line, so their scheduling cost is not amortized. This makes batch the closest throughput comparison while preserving the cost of each public API.

SchemaBinary and Protobuf use length-prefixed frames, NDJSON includes one newline byte per frame, and Msgpack concatenates self-delimiting values. Fragmented inputs split after the first byte. Stream compression is applied to the complete concatenated stream.

The `200-row array payload` case uses `Schema.Array(LargeRow)`, so one value is an array containing 200 rows. A one-shot operation encodes or decodes that entire array. Its streaming batch contains 32 frames with the same 200-row array, or 6,400 row occurrences in total. The `200 single-row frames` case uses `LargeRow` directly and sends the 200 distinct rows as 200 frames. Streaming throughput is decoded values per second: arrays per second for the first case and rows per second for the second. Multiply the array rate by 200 to compare decoded row throughput.

## Payload size

Cells contain raw / gzip -6 / zstd bytes.

| Case                   |       SchemaBinary |        Fingerprint |                JSON |             Msgpack |            Protobuf |
| ---------------------- | -----------------: | -----------------: | ------------------: | ------------------: | ------------------: |
| small record           |       47 / 70 / 56 |       30 / 50 / 39 |       89 / 100 / 92 |        69 / 88 / 78 |        42 / 51 / 44 |
| nested payload         |    280 / 298 / 290 |    200 / 210 / 209 |     453 / 303 / 309 |     385 / 304 / 299 |     241 / 220 / 214 |
| collections            |   1079 / 710 / 687 |   1065 / 692 / 669 |    1828 / 671 / 660 |    1462 / 788 / 805 |    2932 / 799 / 754 |
| index signatures / 128 |   1673 / 646 / 603 |   1680 / 652 / 612 |    2235 / 573 / 559 |    2203 / 676 / 629 |    2834 / 586 / 476 |
| index signatures / 512 | 7145 / 2278 / 2298 | 7152 / 2286 / 2310 |  9531 / 2266 / 2074 |  9287 / 2544 / 2304 | 11666 / 1978 / 1737 |
| 200-row array payload  | 7771 / 2441 / 2224 | 7741 / 2398 / 2182 | 57529 / 3230 / 3008 | 51283 / 3516 / 3320 | 24480 / 3111 / 2839 |

Streaming cells contain total raw / gzip -6 / zstd bytes for the complete stream.

| Case                   | Frames |         SchemaBinary |          Fingerprint |               Msgpack |              Protobuf |                 NDJSON |
| ---------------------- | -----: | -------------------: | -------------------: | --------------------: | --------------------: | ---------------------: |
| small record           |     32 |       1504 / 83 / 66 |        960 / 60 / 48 |       2240 / 111 / 87 |        1376 / 66 / 51 |        2880 / 123 / 98 |
| nested payload         |     32 |     8960 / 380 / 295 |     6400 / 256 / 209 |     10880 / 369 / 306 |      7776 / 271 / 220 |      14528 / 399 / 315 |
| collections            |     32 |    34528 / 968 / 729 |    34080 / 935 / 711 |    47424 / 1130 / 813 |    93888 / 2074 / 774 |     58528 / 1079 / 676 |
| index signatures / 128 |     32 |   53536 / 1007 / 615 |   53760 / 1017 / 624 |    71008 / 1252 / 649 |    90752 / 1503 / 492 |     71552 / 1073 / 540 |
| index signatures / 512 |     32 | 228640 / 4538 / 2320 | 228864 / 4557 / 2332 |  297696 / 5775 / 2037 |  373376 / 5956 / 1782 |   305024 / 5831 / 1829 |
| 200-row array payload  |     32 | 248672 / 4598 / 2261 | 247712 / 4547 / 2220 | 623488 / 12335 / 2736 | 783456 / 12374 / 2909 | 1840960 / 87481 / 3226 |
| 200 single-row frames  |    200 |  27040 / 3079 / 3173 |  21240 / 2876 / 2731 |   51520 / 2956 / 2888 |   24280 / 3104 / 2788 |    57528 / 3230 / 3019 |

## One-shot throughput

Average encode operations per second:

| Case                   |   Default | Fingerprint |    JSON | Msgpack |  Protobuf |
| ---------------------- | --------: | ----------: | ------: | ------: | --------: |
| small record           | 1,319,592 |   1,507,529 | 436,487 | 704,398 | 2,000,847 |
| nested payload         |   588,799 |     641,251 | 259,634 | 285,917 |   562,044 |
| collections            |   146,285 |     153,447 |  22,636 |  23,006 |    75,809 |
| index signatures / 128 |   138,629 |     139,601 |  36,497 |  35,532 |    63,231 |
| index signatures / 512 |    36,813 |      36,699 |   6,999 |   6,358 |    15,699 |
| 200-row array payload  |    19,622 |      19,671 |   7,182 |   4,192 |    12,040 |

Average decode operations per second:

| Case                   |   Default | Fingerprint |    JSON | Msgpack |  Protobuf |
| ---------------------- | --------: | ----------: | ------: | ------: | --------: |
| small record           | 1,560,001 |   1,613,600 | 398,999 | 733,207 | 2,281,446 |
| nested payload         |   586,239 |     689,588 | 216,563 | 270,625 |   560,920 |
| collections            |   113,511 |     116,816 |  21,138 |  22,045 |    77,912 |
| index signatures / 128 |    63,122 |      63,161 |  28,565 |  30,062 |    44,545 |
| index signatures / 512 |    16,412 |      16,338 |   5,432 |   4,593 |     6,029 |
| 200-row array payload  |    23,071 |      23,094 |   5,624 |   4,809 |    15,663 |

## Raw serializer adversarial cases

These cases show where SchemaBinary loses. The shallow record makes fixed per-call costs visible. The clinical fixture is msgpackr's [`tests/example4.json`](https://github.com/kriszyp/msgpackr/blob/e3c852df383059b9ea8a8d3e5517d6e5527bf756/tests/example4.json), the input used by its own general benchmark. It has many nested, heterogeneous object shapes, which suit msgpackr's dynamic record cache.

The clinical Schema is inferred once before timing. Objects at the same array path are merged, missing fields become optional, and mixed leaf types become unions. Schema inference and codec construction are excluded. The shared-structure Packr is primed once, matching msgpackr's steady-state benchmark setup.

Raw / gzip -6 / zstd bytes:

| Case                      |       SchemaBinary |        Fingerprint | Effect Msgpack schema |    msgpackr shared |     msgpackr plain |           JSON raw |
| ------------------------- | -----------------: | -----------------: | --------------------: | -----------------: | -----------------: | -----------------: |
| shallow record            |       47 / 70 / 56 |       30 / 50 / 39 |          69 / 88 / 78 |       24 / 42 / 33 |       69 / 88 / 78 |      89 / 100 / 92 |
| msgpackr clinical fixture | 4433 / 2282 / 2317 | 3513 / 1623 / 1672 |    6357 / 2364 / 2438 | 3821 / 1604 / 1681 | 6357 / 2364 / 2435 | 7569 / 2201 / 2288 |

Average operations per second with msgpackr native acceleration enabled:

| Case                      | Direction | SchemaBinary | Fingerprint | Effect Msgpack schema | msgpackr shared | msgpackr plain |  JSON raw |
| ------------------------- | --------- | -----------: | ----------: | --------------------: | --------------: | -------------: | --------: |
| shallow record            | encode    |    1,704,527 |   1,842,472 |               798,150 |       2,463,086 |      2,806,880 | 2,928,575 |
| shallow record            | decode    |    2,039,262 |   2,202,957 |               891,250 |       6,906,994 |      4,324,485 | 2,280,053 |
| msgpackr clinical fixture | encode    |       52,186 |      58,306 |                17,531 |          67,371 |         61,381 |   131,325 |
| msgpackr clinical fixture | decode    |       48,462 |      58,404 |                16,928 |         183,899 |         53,859 |    56,427 |

Clinical-fixture decode operations per second with native acceleration toggled:

| Format                | Enabled | Disabled |
| --------------------- | ------: | -------: |
| SchemaBinary          |  48,462 |   48,476 |
| Fingerprint           |  58,404 |   58,441 |
| Effect Msgpack schema |  16,928 |   15,124 |
| msgpackr shared       | 183,899 |  118,799 |
| msgpackr plain        |  53,859 |   40,537 |
| JSON raw              |  56,427 |   57,388 |

Shared-structure msgpackr still leads the clinical fixture: 1.29x on encode and 3.79x on decode against default SchemaBinary with native extraction enabled, and 2.45x on decode with it disabled. Fingerprint mode narrows that to 1.16x and 3.15x while staying 8% smaller than the shared-structure payload.

Against everything that does not generate code, SchemaBinary is at or ahead of the field on the clinical fixture. Fingerprint decode beats plain msgpackr by 1.08x with native extraction enabled and 1.44x with it disabled, and beats raw `JSON.parse` by 1.03x. Fingerprint encode is within 5% of plain msgpackr, though `JSON.stringify` is 2.3x ahead of both. Against the schema-validating Effect Msgpack API, default SchemaBinary is 3.0x faster to encode and 2.9x faster to decode.

The shallow record is where the remaining fixed cost shows. Both directions carry the parse pipeline around the codec, roughly a fifth of a shallow decode, which msgpackr does not pay because `unpack` is one function call.

The rest of the shared-structure gap is code generation. msgpackr builds one reader per record structure with `new Function`, so a decoded object is an object literal: about 1 ns per property against 8 to 9 ns for the keyed store this codec has to use. That is worth roughly 2.3 us of the clinical fixture's 20 us decode. Removing the layout dispatch on top of it would leave around 13 us, still short of the 5.4 us shared-structure msgpackr reaches with its native string extractor. Closing that gap is a `new Function` decision, not a tuning one.

## Streaming decode throughput

Average decoded values per second for batched input:

| Case                   |   Default | Fingerprint | Msgpack |  Protobuf |  NDJSON |
| ---------------------- | --------: | ----------: | ------: | --------: | ------: |
| small record           | 5,116,343 |   5,956,797 | 967,638 | 4,170,440 | 831,994 |
| nested payload         |   821,034 |   1,042,459 | 284,246 |   586,806 | 312,906 |
| collections            |   121,413 |     123,472 |  21,071 |    77,768 |  20,555 |
| index signatures / 128 |    65,080 |      65,325 |  28,163 |    38,953 |  28,743 |
| index signatures / 512 |    15,774 |      16,146 |   4,117 |     5,135 |   5,071 |
| 200-row array payload  |    23,238 |      23,247 |   6,573 |     7,455 |   4,988 |
| 200 single-row frames  | 2,257,102 |   2,682,446 | 849,319 | 1,692,708 | 950,570 |

Average decoded values per second for single and first-byte-fragmented input:

| Case                   | Default single | Default fragmented | Fingerprint single | Fingerprint fragmented | NDJSON single | NDJSON fragmented |
| ---------------------- | -------------: | -----------------: | -----------------: | ---------------------: | ------------: | ----------------: |
| small record           |      3,020,534 |          2,168,195 |          3,695,255 |              2,720,058 |       131,636 |           133,208 |
| nested payload         |        721,200 |            677,292 |            890,654 |                833,766 |       104,947 |           103,084 |
| collections            |        119,996 |            118,256 |            121,800 |                119,050 |        18,668 |            18,652 |
| index signatures / 128 |         64,295 |             64,417 |             64,764 |                 64,364 |        24,908 |            24,547 |
| index signatures / 512 |         16,424 |             16,396 |             16,581 |                 16,488 |         5,195 |             5,098 |
| 200-row array payload  |         23,468 |             23,205 |             23,418 |                 23,052 |         5,251 |             5,218 |
| 200 single-row frames  |      1,505,519 |          1,473,846 |          1,915,049 |              1,644,030 |       131,373 |           126,835 |

## Analysis

- Fingerprint mode is now the smallest SchemaBinary format for every case except the two index-signature maps, where the two modes are within 7 bytes: row runs apply in both modes, and fingerprint shapes are presence masks with no id list, so the `200-row array payload` dropped from 19,454 to 7,741 bytes. Its decode rate rose from 14,905 to 23,321 ops/s, matching the default mode.
- The default mode has the smallest raw payload of any non-fingerprint format in every case except the small record, where only Protobuf's one-byte field numbers beat its hashed five-byte field tags (42 vs 47 bytes). Fingerprint mode wins there too (30 bytes).
- Compression still changes the map ranking: Protobuf has the smallest zstd output for both index-signature cases, and JSON wins gzip at 128 keys.
- Protobuf keeps the small record in both directions, by about 1.5x. SchemaBinary leads the other five one-shot cases in both directions, from 1.05x on the nested payload up to 2.7x on index-signature decode, while returning schema-validated application values. Against Msgpack through the same public API it leads every case, by 1.9x to 6.4x.
- Single-frame and fragmented streaming rates for the `200 single-row frames` case carry 20% or worse RME at 250 samples, so only their batch column is worth comparing across runs.
