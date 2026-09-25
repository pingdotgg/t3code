import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import { CurrentLogLevel } from "effect/References"
import * as Schema from "effect/Schema"
import type * as McpProtocol from "effect/unstable/ai/McpProtocol"
import * as McpSchema from "effect/unstable/ai/McpSchema"
import * as McpServer from "effect/unstable/ai/McpServer"
import * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"
import { makeServerLayer } from "../TestUtils/McpServerLayer.ts"

export interface Observations {
  readonly toolInvocations: number
  readonly promptInvocations: number
  readonly resourceTemplateInvocations: number
}

const TestTool = Tool.make("TestTool", {
  description: "A test tool",
  parameters: Schema.Struct({
    value: Schema.String
  }),
  success: Schema.String
})

const makeStructuredTool = (protocolVersion: string) =>
  Tool.make("StructuredTool", {
    parameters: Tool.EmptyParams,
    success: Schema.Struct({
      value: Schema.String
    })
  }).annotate(
    McpSchema.EnabledWhen,
    (client) => client.protocolVersion === protocolVersion
  )

const LogLevelTool = Tool.make("LogLevelTool", {
  parameters: Tool.EmptyParams,
  success: Schema.String,
  dependencies: [CurrentLogLevel]
})

const makeTestToolkitLayer = (observations: Ref.Ref<Observations>, protocolVersion: string) => {
  const TestToolkit = Toolkit.make(TestTool, makeStructuredTool(protocolVersion), LogLevelTool)
  return McpServer.toolkit(TestToolkit).pipe(
    Layer.provide(TestToolkit.toLayer({
      TestTool: ({ value }) =>
        Ref.update(observations, (current) => ({
          ...current,
          toolInvocations: current.toolInvocations + 1
        })).pipe(Effect.as(value)),
      StructuredTool: () => Effect.succeed({ value: "structured" }),
      LogLevelTool: () => CurrentLogLevel
    }))
  )
}

const makeContentToolsLayer = Layer.effectDiscard(
  Effect.gen(function*() {
    const server = yield* McpServer.McpServer
    const add = (
      name: string,
      result: McpSchema.CallToolResult
    ) =>
      server.addTool({
        tool: new McpSchema.Tool({
          name,
          inputSchema: { type: "object", properties: {} }
        }),
        annotations: Context.empty(),
        handle: () => Effect.succeed(result)
      })

    yield* add(
      "ImageTool",
      new McpSchema.CallToolResult({
        content: [{
          type: "image",
          data: new Uint8Array([1, 2, 3]),
          mimeType: "image/png"
        }]
      })
    )
    yield* add(
      "EmbeddedResourceTool",
      new McpSchema.CallToolResult({
        content: [{
          type: "resource",
          resource: {
            uri: "file:///embedded",
            mimeType: "text/plain",
            text: "embedded"
          }
        }]
      })
    )
    yield* add(
      "MultipleContentTool",
      new McpSchema.CallToolResult({
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" }
        ]
      })
    )
    yield* add(
      "ErrorTool",
      new McpSchema.CallToolResult({
        content: [{ type: "text", text: "expected failure" }],
        isError: true
      })
    )
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: "DefectTool",
        inputSchema: { type: "object", properties: {} }
      }),
      annotations: Context.empty(),
      handle: () => Effect.die("private defect details")
    })

    yield* add(
      "AudioTool",
      new McpSchema.CallToolResult({
        content: [{
          type: "audio",
          data: new Uint8Array([4, 5, 6]),
          mimeType: "audio/wav"
        }]
      })
    )
    yield* add(
      "ResourceLinkTool",
      new McpSchema.CallToolResult({
        content: [{
          type: "resource_link",
          uri: "file:///test",
          name: "TestResource",
          mimeType: "text/plain"
        }]
      })
    )
  })
)

const templatePath = McpSchema.param("path", Schema.String)
const TestResourceTemplate = McpServer.resource`file:///template/${templatePath}`({
  name: "TestResourceTemplate",
  description: "A test resource template",
  mimeType: "text/plain",
  completion: {
    path: (value) => Effect.succeed(value === "" ? ["beta", "alpha"] : ["alpha", "beta"])
  },
  content: (uri, path) => Effect.succeed(`${uri}:${path}`)
})

const numericId = McpSchema.param("id", Schema.FiniteFromString)
const makeNumericResourceTemplate = (observations: Ref.Ref<Observations>) =>
  McpServer.resource`file:///numeric/${numericId}`({
    name: "NumericResourceTemplate",
    content: (uri) =>
      Ref.update(observations, (current) => ({
        ...current,
        resourceTemplateInvocations: current.resourceTemplateInvocations + 1
      })).pipe(Effect.as(uri))
  })

const ImagePrompt = McpServer.prompt({
  name: "ImagePrompt",
  content: () =>
    Effect.succeed([{
      role: "user",
      content: McpSchema.ImageContent.make({
        data: new Uint8Array([1, 2, 3]),
        mimeType: "image/png"
      })
    }])
})

const AudioPrompt = McpServer.prompt({
  name: "AudioPrompt",
  content: () =>
    Effect.succeed([{
      role: "user",
      content: McpSchema.AudioContent.make({
        data: new Uint8Array([4, 5, 6]),
        mimeType: "audio/wav"
      })
    }])
})

const EmbeddedResourcePrompt = McpServer.prompt({
  name: "EmbeddedResourcePrompt",
  content: () =>
    Effect.succeed([{
      role: "user",
      content: McpSchema.EmbeddedResource.make({
        resource: {
          uri: "file:///embedded",
          mimeType: "text/plain",
          text: "embedded"
        }
      })
    }])
})

const ContextCompletionPrompt = McpServer.prompt({
  name: "ContextCompletionPrompt",
  parameters: {
    value: Schema.String
  },
  completion: {
    value: (_input, context) =>
      Effect.succeed(context?.arguments?.locale === "en" ? ["context received"] : ["context missing"])
  },
  content: ({ value }) => Effect.succeed(value)
})

export const makeFeaturesServerLayer = (
  protocol: McpProtocol.ProtocolAdapter,
  observations: Ref.Ref<Observations>
) =>
  Layer.mergeAll(
    makeTestToolkitLayer(observations, protocol.protocolVersion),
    makeContentToolsLayer,
    McpServer.resource({
      uri: "file:///test",
      name: "TestResource",
      description: "A test resource",
      mimeType: "text/plain",
      content: Effect.succeed(McpSchema.ReadResourceResult.make({
        contents: [{
          uri: "file:///test",
          mimeType: "text/plain",
          text: "test"
        }]
      }))
    }),
    McpServer.resource({
      uri: "file:///binary",
      name: "BinaryResource",
      mimeType: "application/octet-stream",
      content: Effect.succeed(McpSchema.ReadResourceResult.make({
        contents: [{
          uri: "file:///binary",
          mimeType: "application/octet-stream",
          blob: new Uint8Array([1, 2, 3])
        }]
      }))
    }),
    McpServer.resource({
      uri: "file:///multiple",
      name: "MultipleResource",
      content: Effect.succeed(McpSchema.ReadResourceResult.make({
        contents: [
          {
            uri: "file:///multiple#first",
            mimeType: "text/plain",
            text: "first"
          },
          {
            uri: "file:///multiple#second",
            mimeType: "text/plain",
            text: "second"
          }
        ]
      }))
    }),
    TestResourceTemplate,
    makeNumericResourceTemplate(observations),
    McpServer.prompt({
      name: "TestPrompt",
      description: "A test prompt",
      parameters: {
        required: Schema.String,
        optional: Schema.optional(Schema.String)
      },
      completion: {
        required: (value) =>
          Effect.succeed(
            value === "limit"
              ? Array.from({ length: 101 }, (_, index) => `value-${index}`)
              : ["first", "second"]
          )
      },
      content: ({ optional, required }) =>
        Ref.update(observations, (current) => ({
          ...current,
          promptInvocations: current.promptInvocations + 1
        })).pipe(Effect.as(`${required}:${optional ?? "omitted"}`))
    }),
    McpServer.prompt({
      name: "NoArgumentPrompt",
      content: () => Effect.succeed("no arguments")
    }),
    ImagePrompt,
    EmbeddedResourcePrompt,
    AudioPrompt,
    ContextCompletionPrompt
  ).pipe(
    Layer.provide(makeServerLayer({
      name: "McpConformance",
      protocols: [protocol],
      extensions: { "example/lifecycle": { enabled: true } }
    }))
  )
