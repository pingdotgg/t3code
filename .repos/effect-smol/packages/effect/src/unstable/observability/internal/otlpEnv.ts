import * as Config from "../../../Config.ts"
import * as Schema from "../../../Schema.ts"
import * as SchemaGetter from "../../../SchemaGetter.ts"

export type Signal = "LOGS" | "METRICS" | "TRACES"

const ExporterList = Config.Array(Schema.String).pipe(
  Schema.decode({
    decode: SchemaGetter.transform((_) => _.map((_) => _.toLowerCase().trim()).filter((_) => _ !== "")),
    encode: SchemaGetter.passthrough()
  })
)

const HeadersRecord = Config.Record(Schema.String, Schema.String)

export const headers = (signal: Signal) =>
  Config.schema(HeadersRecord, `OTEL_EXPORTER_OTLP_${signal}_HEADERS`).pipe(
    Config.orElse(() => Config.schema(HeadersRecord, "OTEL_EXPORTER_OTLP_HEADERS")),
    Config.withDefault(undefined)
  )

export const endpoint = (signal: Signal) =>
  Config.url(`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`).pipe(
    Config.orElse(() =>
      Config.url("OTEL_EXPORTER_OTLP_ENDPOINT").pipe(
        Config.map((url) => {
          const slash = url.pathname.endsWith("/") ? "" : "/"
          url.pathname += `${slash}v1/${signal.toLowerCase()}`
          return url
        })
      )
    ),
    Config.withDefault(undefined)
  )

export const exporters = (signal: Signal) =>
  Config.schema(ExporterList, `OTEL_${signal}_EXPORTER`).pipe(
    Config.withDefault<ReadonlyArray<string>>([])
  )
