import { OpenAiClient, OpenAiConfig } from "@effect/ai-openai"
import { HttpClient } from "effect/http"
import { describe, expect, it } from "tstyche"

describe("OpenAiWorkloadIdentity", () => {
  it("leaves the existing client transforms accepted", () => {
    expect(OpenAiClient.layer).type.toBeCallableWith({ transformClient: HttpClient.timeout("30 seconds") })
    expect(OpenAiClient.layer).type.toBeCallableWith({ transformClient: HttpClient.filterStatusOk })
    expect(OpenAiClient.layer).type.toBeCallableWith({ transformClient: (client: HttpClient.HttpClient) => client })
    expect(OpenAiConfig.withClientTransform).type.toBeCallableWith(HttpClient.timeout("30 seconds"))
    expect(OpenAiConfig.withClientTransform).type.toBeCallableWith(HttpClient.filterStatusOk)
    expect(OpenAiConfig.withClientTransform).type.toBeCallableWith((client: HttpClient.HttpClient) => client)
  })
})
