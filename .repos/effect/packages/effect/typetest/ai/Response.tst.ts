import { Context, hole, Schema } from "effect"
import { Response, Tool, Toolkit } from "effect/ai"
import { describe, expect, it } from "tstyche"

const BooleanTool = Tool.make("BooleanTool", {
  parameters: Schema.Boolean,
  success: Schema.String,
  failure: Schema.Boolean
})

const TransformTool = Tool.make("TransformTool", {
  parameters: Schema.FiniteFromString,
  success: Schema.Number,
  failure: Schema.Struct({ message: Schema.String })
})

class ParamsDecoder extends Context.Service<ParamsDecoder, {}>()("test/ResponseParamsDecoder") {}
class ParamsEncoder extends Context.Service<ParamsEncoder, {}>()("test/ResponseParamsEncoder") {}
class ResultDecoder extends Context.Service<ResultDecoder, {}>()("test/ResponseResultDecoder") {}
class ResultEncoder extends Context.Service<ResultEncoder, {}>()("test/ResponseResultEncoder") {}

const ServiceToolkit = Toolkit.make(
  Tool.make("ServiceTool", {
    parameters: hole<Schema.Codec<string, string, ParamsDecoder, ParamsEncoder>>(),
    success: hole<Schema.Codec<string, string, ResultDecoder, ResultEncoder>>()
  })
)

type Tools = {
  readonly BooleanTool: typeof BooleanTool
  readonly TransformTool: typeof TransformTool
}

describe("Response", () => {
  it("preserves generic intersected tool records after narrowing", () => {
    const narrow = <
      StaticTools extends Record<string, Tool.Any>,
      DynamicTools extends Record<string, Tool.Any>,
      ParametersMode extends Response.ToolParametersMode
    >(part: Response.StreamPart<StaticTools & DynamicTools, ParametersMode>) => {
      if (part.type === "error") return

      const narrowed: Response.StreamPart<StaticTools & DynamicTools, ParametersMode> = part
      return narrowed
    }

    void narrow
  })

  it("preserves tool names with decoded and encoded parameters", () => {
    const decoded = null as unknown as Response.ToolCallParts<Tools, "decoded">
    if (decoded.name === "BooleanTool") {
      expect(decoded.params).type.toBe<boolean>()
    } else {
      expect(decoded.params).type.toBe<number>()
    }

    const encoded = null as unknown as Response.ToolCallParts<Tools, "encoded">
    if (encoded.name === "BooleanTool") {
      expect(encoded.params).type.toBe<Schema.Json>()
    } else {
      expect(encoded.params).type.toBe<Schema.Json>()
    }

    const opaque = null as unknown as Response.ToolCallParts<Tools, "opaque">
    expect(opaque.params).type.toBe<unknown>()
  })

  it("keeps raw encoded parameters possible for provider-defined tools with a non-literal handler flag", () => {
    const ScheduleTool = Tool.providerDefined({
      id: "test.schedule",
      customName: "ScheduleTool",
      providerName: "schedule",
      requiresHandler: hole<boolean>(),
      parameters: Schema.Struct({ at: Schema.Date })
    })()

    const encoded = null as unknown as Response.ToolCallParts<{ readonly ScheduleTool: typeof ScheduleTool }, "encoded">
    expect(encoded.params).type.toBe<{ readonly at: Date } | Schema.Json>()
  })

  it("keeps raw encoded parameters for annotated provider-defined tools", () => {
    const ScheduleTool = Tool.providerDefined({
      id: "test.schedule",
      customName: "ScheduleTool",
      providerName: "schedule",
      parameters: Schema.Struct({ at: Schema.Date })
    })().annotate(Tool.Title, "Schedule")

    const encoded = null as unknown as Response.ToolCallParts<{ readonly ScheduleTool: typeof ScheduleTool }, "encoded">
    expect(encoded.params).type.toBe<{ readonly at: Date }>()
  })

  it("keeps raw encoded parameters for provider-defined tools with a replaced success schema", () => {
    const ScheduleTool = Tool.providerDefined({
      id: "test.schedule",
      customName: "ScheduleTool",
      providerName: "schedule",
      parameters: Schema.Struct({ at: Schema.Date })
    })().setSuccess(Schema.String)

    const encoded = null as unknown as Response.ToolCallParts<{ readonly ScheduleTool: typeof ScheduleTool }, "encoded">
    expect(encoded.params).type.toBe<{ readonly at: Date }>()
  })

  it("preserves tool names with success and failure results", () => {
    const result = null as unknown as Response.ToolResultParts<Tools>
    if (result.name === "BooleanTool") {
      if (result.isFailure) {
        expect(result.result).type.toBe<typeof BooleanTool.failureSchema.Type | typeof Tool.ExecutionFailure.Type>()
      } else {
        expect(result.result).type.toBe<string>()
      }
    } else if (result.isFailure) {
      expect(result.result).type.toBe<typeof TransformTool.failureSchema.Type | typeof Tool.ExecutionFailure.Type>()
    } else {
      expect(result.result).type.toBe<number>()
    }
  })

  it("requires tool parameter and result services in toolkit schemas", () => {
    const allParts = Response.AllParts(ServiceToolkit)
    const part = Response.Part(ServiceToolkit)
    const streamPart = Response.StreamPart(ServiceToolkit)

    expect<typeof allParts["DecodingServices"]>().type.toBe<ParamsDecoder | ResultDecoder>()
    expect<typeof allParts["EncodingServices"]>().type.toBe<ParamsEncoder | ResultEncoder>()
    expect<typeof part["DecodingServices"]>().type.toBe<ParamsDecoder | ResultDecoder>()
    expect<typeof part["EncodingServices"]>().type.toBe<ParamsEncoder | ResultEncoder>()
    expect<typeof streamPart["DecodingServices"]>().type.toBe<ParamsDecoder | ResultDecoder>()
    expect<typeof streamPart["EncodingServices"]>().type.toBe<ParamsEncoder | ResultEncoder>()
  })

  it("requires tool parameter and result services in handled toolkit schemas", () => {
    const toolkit = hole<Toolkit.WithHandler<typeof ServiceToolkit.tools>>()
    const allParts = Response.AllParts(toolkit)
    const part = Response.Part(toolkit)
    const streamPart = Response.StreamPart(toolkit)

    expect<typeof allParts["DecodingServices"]>().type.toBe<ParamsDecoder | ResultDecoder>()
    expect<typeof allParts["EncodingServices"]>().type.toBe<ParamsEncoder | ResultEncoder>()
    expect<typeof part["DecodingServices"]>().type.toBe<ParamsDecoder | ResultDecoder>()
    expect<typeof part["EncodingServices"]>().type.toBe<ParamsEncoder | ResultEncoder>()
    expect<typeof streamPart["DecodingServices"]>().type.toBe<ParamsDecoder | ResultDecoder>()
    expect<typeof streamPart["EncodingServices"]>().type.toBe<ParamsEncoder | ResultEncoder>()
  })
})
