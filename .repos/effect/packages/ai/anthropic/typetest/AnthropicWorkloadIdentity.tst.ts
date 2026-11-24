import { AnthropicClient, AnthropicConfig } from "@effect/ai-anthropic"
import { HttpClient } from "effect/http"
import { describe, expect, it } from "tstyche"

describe("AnthropicWorkloadIdentity", () => {
  it("leaves the existing client transforms accepted", () => {
    expect(AnthropicClient.layer).type.toBeCallableWith({ transformClient: HttpClient.timeout("30 seconds") })
    expect(AnthropicClient.layer).type.toBeCallableWith({ transformClient: HttpClient.filterStatusOk })
    expect(AnthropicClient.layer).type.toBeCallableWith({ transformClient: (client: HttpClient.HttpClient) => client })
    expect(AnthropicConfig.withClientTransform).type.toBeCallableWith(HttpClient.timeout("30 seconds"))
    expect(AnthropicConfig.withClientTransform).type.toBeCallableWith(HttpClient.filterStatusOk)
    expect(AnthropicConfig.withClientTransform).type.toBeCallableWith((client: HttpClient.HttpClient) => client)
  })
})
