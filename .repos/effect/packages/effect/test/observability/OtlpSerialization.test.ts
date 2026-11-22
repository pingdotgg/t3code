import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Hex from "effect/encoding/Hex"
import { OtlpResource, OtlpSerialization } from "effect/observability"
import { Buffer } from "node:buffer"

describe("OtlpSerialization", () => {
  const boundaries = [
    {
      input: -1,
      decimal: "-1",
      varint: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]
    },
    {
      input: -(2 ** 63),
      decimal: "-9223372036854775808",
      varint: [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]
    },
    {
      input: 9_223_372_036_854_774_784,
      decimal: "9223372036854774784",
      varint: [0x80, 0xf8, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]
    },
    {
      input: -9_223_372_036_854_775_808n,
      decimal: "-9223372036854775808",
      varint: [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]
    },
    {
      input: 9_223_372_036_854_775_807n,
      decimal: "9223372036854775807",
      varint: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]
    }
  ]

  for (const format of ["json", "protobuf"] as const) {
    it.effect.each(boundaries)(
      `${format} preserves int64 boundary $decimal ($input)`,
      ({ input, decimal, varint }) =>
        Effect.gen(function*() {
          const serialization = yield* OtlpSerialization.OtlpSerialization
          const body = serialization.logs({
            resourceLogs: [{
              resource: {
                attributes: [{ key: "v", value: OtlpResource.unknownToAttributeValue(input) }],
                droppedAttributesCount: 0
              },
              scopeLogs: []
            }]
          })
          assert.strictEqual(body._tag, "Uint8Array")
          if (body._tag !== "Uint8Array") return
          if (format === "json") {
            const json = new TextDecoder().decode(body.body)
            const intValue = json.match(/"intValue":\s*(?:"(-?\d+)"|(-?\d+))(?=\s*[,}])/)
            assert.strictEqual(intValue?.[1] ?? intValue?.[2], decimal)
          } else {
            assert.deepStrictEqual(Array.from(body.body), [
              0x0a,
              varint.length + 10,
              0x0a,
              varint.length + 8,
              0x0a,
              varint.length + 6,
              0x0a,
              0x01,
              0x76,
              0x12,
              varint.length + 1,
              0x18,
              ...varint
            ])
          }
        }).pipe(Effect.provide(format === "json" ? OtlpSerialization.layerJson : OtlpSerialization.layerProtobuf))
    )
  }

  it.effect("layerProtobuf omits absent metric start timestamps", () =>
    Effect.gen(function*() {
      const serialization = yield* OtlpSerialization.OtlpSerialization
      const point = { attributes: [], timeUnixNano: "2" }
      const body = serialization.metrics({
        resourceMetrics: [{
          resource: { attributes: [], droppedAttributesCount: 0 },
          scopeMetrics: [{
            scope: { name: "s" },
            metrics: [
              { name: "g", gauge: { dataPoints: [{ ...point, asInt: 1 }] } },
              {
                name: "h",
                histogram: {
                  dataPoints: [{ ...point, count: 1, bucketCounts: [1], explicitBounds: [] }],
                  aggregationTemporality: 2
                }
              },
              { name: "s", summary: { dataPoints: [{ ...point, count: 1, sum: 1, quantileValues: [] }] } }
            ]
          }]
        }]
      })
      assert.strictEqual(body._tag, "Uint8Array")
      const time = [0x19, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00] // time_unix_nano: 2
      const one = [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
      assert.deepStrictEqual(
        Array.from(body._tag === "Uint8Array" ? body.body : []),
        [
          [0x0a, 0x6e], // resource_metrics
          [0x0a, 0x00], // resource
          [0x12, 0x6a], // scope_metrics
          [0x0a, 0x03, 0x0a, 0x01, 0x73], // scope { name: "s" }
          [0x12, 0x19, 0x0a, 0x01, 0x67], // metrics { name: "g" }
          [0x2a, 0x14, 0x0a, 0x12], // gauge.data_points
          [...time, 0x31, ...one], // as_int: 1
          [0x12, 0x24, 0x0a, 0x01, 0x68], // metrics { name: "h" }
          [0x4a, 0x1f, 0x0a, 0x1b], // histogram.data_points
          [...time, 0x21, ...one, 0x31, ...one], // count: 1, bucket_counts: [1]
          [0x10, 0x02], // aggregation_temporality: 2
          [0x12, 0x22, 0x0a, 0x01, 0x73], // metrics { name: "s" }
          [0x5a, 0x1d, 0x0a, 0x1b], // summary.data_points
          [...time, 0x21, ...one, 0x29, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f] // count: 1, sum: 1.0
        ].flat()
      )
    }).pipe(Effect.provide(OtlpSerialization.layerProtobuf)))

  it.effect("layerProtobuf encodes Summary metrics", () =>
    Effect.gen(function*() {
      const serialization = yield* OtlpSerialization.OtlpSerialization
      const body = serialization.metrics({
        resourceMetrics: [{
          resource: { attributes: [], droppedAttributesCount: 0 },
          scopeMetrics: [{
            scope: { name: "s" },
            metrics: [{
              name: "s",
              summary: {
                dataPoints: [{
                  attributes: [],
                  startTimeUnixNano: "1",
                  timeUnixNano: "2",
                  count: 3,
                  sum: 6,
                  quantileValues: [{ quantile: 0.5, value: 2 }]
                }]
              }
            }]
          }]
        }]
      })
      assert.strictEqual(body._tag, "Uint8Array")
      assert.deepStrictEqual(
        Array.from(body._tag === "Uint8Array" ? body.body : []),
        [
          [0x0a, 0x4a], // resource_metrics
          [0x0a, 0x00], // resource
          [0x12, 0x46], // scope_metrics
          [0x0a, 0x03, 0x0a, 0x01, 0x73], // scope { name: "s" }
          [0x12, 0x3f], // metrics
          [0x0a, 0x01, 0x73], // name: "s"
          [0x5a, 0x3a], // summary (field 11)
          [0x0a, 0x38], // data_points
          [0x11, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // start_time_unix_nano: 1
          [0x19, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // time_unix_nano: 2
          [0x21, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // count: 3
          [0x29, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x18, 0x40], // sum: 6.0
          [0x32, 0x12], // quantile_values
          [0x09, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xe0, 0x3f], // quantile: 0.5
          [0x11, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40] // value: 2.0
        ].flat()
      )
    }).pipe(Effect.provide(OtlpSerialization.layerProtobuf)))

  it.effect("layerProtobuf encodes every span and log record field", () =>
    Effect.gen(function*() {
      const serialization = yield* OtlpSerialization.OtlpSerialization
      const traceId = "0102030405060708090a0b0c0d0e0f10"
      const spanId = "1112131415161718"
      const resource = { attributes: [], droppedAttributesCount: 0 }
      const scope = { name: "s" }
      const traces = serialization.traces({
        resourceSpans: [{
          resource,
          scopeSpans: [{
            scope,
            spans: [{
              traceId,
              spanId,
              parentSpanId: "2122232425262728",
              name: "op",
              kind: 2,
              startTimeUnixNano: "1",
              endTimeUnixNano: "2",
              attributes: [{ key: "a", value: { boolValue: true } }],
              droppedAttributesCount: 1,
              events: [{
                timeUnixNano: "3",
                name: "e",
                attributes: [{ key: "b", value: { doubleValue: 0.5 } }],
                droppedAttributesCount: 2
              }],
              droppedEventsCount: 3,
              links: [{
                traceId: "3132333435363738393a3b3c3d3e3f40",
                spanId: "4142434445464748",
                attributes: [{ key: "c", value: { arrayValue: { values: [{ stringValue: "s" }] } } }],
                droppedAttributesCount: 4
              }],
              droppedLinksCount: 5,
              status: { code: 2, message: "bad" }
            }]
          }]
        }]
      })
      const logs = serialization.logs({
        resourceLogs: [{
          resource,
          scopeLogs: [{
            scope,
            logRecords: [{
              timeUnixNano: "6",
              observedTimeUnixNano: "7",
              severityNumber: 9,
              severityText: "INFO",
              body: { kvlistValue: { values: [{ key: "d", value: { bytesValue: Uint8Array.of(1, 2) } }] } },
              attributes: [{ key: "e", value: { intValue: 5 } }],
              droppedAttributesCount: 6,
              flags: 1,
              traceId,
              spanId
            }]
          }]
        }]
      })
      const hex = (body: typeof traces) => body._tag === "Uint8Array" ? Hex.encode(body.body) : body._tag
      assert.strictEqual(
        hex(traces),
        [
          "0ab101", // resource_spans
          "0a00", // resource
          "12ac01", // scope_spans
          "0a030a0173", // scope { name: "s" }
          "12a401", // spans
          "0a100102030405060708090a0b0c0d0e0f10", // trace_id
          "12081112131415161718", // span_id
          "22082122232425262728", // parent_span_id
          "2a026f70", // name: "op"
          "3002", // kind: 2
          "390100000000000000", // start_time_unix_nano: 1
          "410200000000000000", // end_time_unix_nano: 2
          "4a070a016112021001", // attributes { a: true }
          "5001", // dropped_attributes_count: 1
          "5a1e", // events
          "090300000000000000", // time_unix_nano: 3
          "120165", // name: "e"
          "1a0e0a0162120921000000000000e03f", // attributes { b: 0.5 }
          "2002", // dropped_attributes_count: 2
          "6003", // dropped_events_count: 3
          "6a2c", // links
          "0a103132333435363738393a3b3c3d3e3f40", // trace_id
          "12084142434445464748", // span_id
          "220c0a016312072a050a030a0173", // attributes { c: ["s"] }
          "2804", // dropped_attributes_count: 4
          "7005", // dropped_links_count: 5
          "7a071203626164", // status { message: "bad"
          "1802" //   code: 2 }
        ].join("")
      )
      assert.strictEqual(
        hex(logs),
        [
          "0a60", // resource_logs
          "0a00", // resource
          "125c", // scope_logs
          "0a030a0173", // scope { name: "s" }
          "1255", // log_records
          "090600000000000000", // time_unix_nano: 6
          "1009", // severity_number: 9
          "1a04494e464f", // severity_text: "INFO"
          "2a0d320b0a090a016412043a020102", // body { d: bytes [1, 2] }
          "32070a016512021805", // attributes { e: 5 }
          "3806", // dropped_attributes_count: 6
          "4501000000", // flags: 1
          "4a100102030405060708090a0b0c0d0e0f10", // trace_id
          "52081112131415161718", // span_id
          "590700000000000000" // observed_time_unix_nano: 7
        ].join("")
      )
    }).pipe(Effect.provide(OtlpSerialization.layerProtobuf)))

  it.effect("layerProtobuf encodes log record ids given as bytes like their hex strings", () =>
    Effect.gen(function*() {
      const serialization = yield* OtlpSerialization.OtlpSerialization
      const encode = (traceId: string | Uint8Array, spanId: string | Uint8Array) => {
        const body = serialization.logs({
          resourceLogs: [{
            resource: { attributes: [], droppedAttributesCount: 0 },
            scopeLogs: [{
              scope: { name: "s" },
              logRecords: [{
                timeUnixNano: "1",
                observedTimeUnixNano: "2",
                attributes: [],
                droppedAttributesCount: 0,
                traceId,
                spanId
              }]
            }]
          }]
        })
        return body._tag === "Uint8Array" ? Hex.encode(body.body) : body._tag
      }
      assert.strictEqual(
        encode(
          Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16),
          Uint8Array.of(17, 18, 19, 20, 21, 22, 23, 24)
        ),
        encode("0102030405060708090a0b0c0d0e0f10", "1112131415161718")
      )
    }).pipe(Effect.provide(OtlpSerialization.layerProtobuf)))

  it.effect("layerJson preserves JSON values and writes non-finite doubles as strings for every signal", () =>
    Effect.gen(function*() {
      const serialization = yield* OtlpSerialization.OtlpSerialization
      const resource = {
        attributes: [{
          key: "values",
          value: {
            arrayValue: {
              values: [NaN, Infinity, -Infinity, 1.5, 0, null].map((doubleValue) => ({ doubleValue }))
            }
          }
        }, { key: "text", value: { stringValue: "null" } }],
        droppedAttributesCount: 0
      }
      for (
        const [key, body] of [
          ["resourceMetrics", serialization.metrics({ resourceMetrics: [{ resource, scopeMetrics: [] }] })],
          ["resourceSpans", serialization.traces({ resourceSpans: [{ resource, scopeSpans: [] }] })],
          ["resourceLogs", serialization.logs({ resourceLogs: [{ resource, scopeLogs: [] }] })]
        ] as const
      ) {
        assert.strictEqual(body._tag, "Uint8Array")
        if (body._tag !== "Uint8Array") throw new Error("Expected a byte body")
        assert.strictEqual(body.contentType, "application/json")
        const data = JSON.parse(new TextDecoder().decode(body.body))
        assert.deepStrictEqual(data[key][0].resource.attributes, [{
          key: "values",
          value: {
            arrayValue: {
              values: ["NaN", "Infinity", "-Infinity", 1.5, 0, null].map((doubleValue) => ({ doubleValue }))
            }
          }
        }, { key: "text", value: { stringValue: "null" } }])
      }
    }).pipe(Effect.provide(OtlpSerialization.layerJson)))

  it.effect("layerJson writes bytes as base64", () =>
    Effect.gen(function*() {
      const serialization = yield* OtlpSerialization.OtlpSerialization
      const body = serialization.traces({
        resourceSpans: [{
          resource: {
            attributes: [
              { key: "slice", value: { bytesValue: Uint8Array.of(9, 0, 255, 1).subarray(1) } },
              { key: "buffer", value: { bytesValue: Buffer.from([0, 255, 1]) } }
            ],
            droppedAttributesCount: 0
          },
          scopeSpans: []
        }]
      })
      if (body._tag !== "Uint8Array") throw new Error("Expected a byte body")
      assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(body.body)).resourceSpans[0].resource.attributes, [
        { key: "slice", value: { bytesValue: "AP8B" } },
        { key: "buffer", value: { bytesValue: "AP8B" } }
      ])
    }).pipe(Effect.provide(OtlpSerialization.layerJson)))
})
