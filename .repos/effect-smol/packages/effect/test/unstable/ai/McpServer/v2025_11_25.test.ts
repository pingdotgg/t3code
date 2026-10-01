import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as McpProtocol from "effect/unstable/ai/McpProtocol"
import * as McpSchema from "effect/unstable/ai/McpSchema"
import * as BaseProtocolTest from "./McpConformance/BaseProtocolTest.ts"
import * as CompletionTest from "./McpConformance/CompletionTest.ts"
import * as ElicitationTest from "./McpConformance/ElicitationTest.ts"
import * as LifecycleTest from "./McpConformance/LifecycleTest.ts"
import * as LoggingTest from "./McpConformance/LoggingTest.ts"
import { layer as makeMcpConformanceLayer, McpConformance } from "./McpConformance/McpConformance.ts"
import * as PromptsTest from "./McpConformance/PromptsTest.ts"
import * as ResourcesTest from "./McpConformance/ResourcesTest.ts"
import * as SamplingTest from "./McpConformance/SamplingTest.ts"
import * as ToolsTest from "./McpConformance/ToolsTest.ts"
import * as TransportsTest from "./McpConformance/TransportsTest.ts"
import * as UtilitiesTest from "./McpConformance/UtilitiesTest.ts"

const protocol = McpProtocol.v2025_11_25
const testLayer = makeMcpConformanceLayer(protocol)

LifecycleTest.suite(protocol, testLayer)
BaseProtocolTest.suite(protocol, testLayer)
TransportsTest.suite(protocol, testLayer)
UtilitiesTest.suite(protocol, testLayer)
ToolsTest.suite(protocol, testLayer)
ResourcesTest.suite(protocol, testLayer)
PromptsTest.suite(protocol, testLayer)
CompletionTest.suite(protocol, testLayer)
LoggingTest.suite(protocol, testLayer)
SamplingTest.suite(protocol, testLayer)
ElicitationTest.suite(protocol, testLayer)

it.layer(testLayer)(`Mcp Conformance (${protocol.protocolVersion})`, (it) => {
  describe("Tools", () => {
    it.effect("does not expose experimental Tasks without an extension", () =>
      Effect.gen(function*() {
        const test = yield* McpConformance
        const initialized = yield* test.initialize({ server: "features" })
        yield* test.notifyInitialized(initialized)
        const before = (yield* test.observations).toolInvocations
        const response = yield* test.send(initialized, {
          jsonrpc: "2.0",
          id: 2,
          method: "tasks/get",
          params: { taskId: "task-1" }
        })
        const error = yield* test.decodeError(response)

        assert.strictEqual(error.error.code, McpSchema.METHOD_NOT_FOUND_ERROR_CODE)
        assert.strictEqual((yield* test.observations).toolInvocations, before)
      }))
  })
})
