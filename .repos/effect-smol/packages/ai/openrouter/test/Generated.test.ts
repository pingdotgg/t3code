import { Generated } from "@effect/ai-openrouter"
import { describe, it } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { Schema } from "effect"

describe("Generated", () => {
  it("decodes nullable generation statistics", () => {
    const response: Generated.GetGeneration200 = {
      data: {
        id: "gen-test",
        upstream_id: null,
        total_cost: 0.003294,
        cache_discount: null,
        upstream_inference_cost: null,
        created_at: "2026-07-24T12:00:00Z",
        data_region: "global",
        model: "openrouter/auto",
        app_id: null,
        streamed: null,
        cancelled: null,
        provider_name: null,
        http_referer: null,
        latency: null,
        moderation_latency: null,
        generation_time: null,
        finish_reason: null,
        tokens_prompt: null,
        tokens_completion: null,
        native_tokens_prompt: null,
        native_tokens_completion: null,
        native_tokens_completion_images: null,
        native_tokens_reasoning: null,
        native_tokens_cached: null,
        num_fetches: null,
        num_media_prompt: null,
        num_input_audio_prompt: null,
        num_media_completion: null,
        num_search_results: null,
        origin: "https://openrouter.ai/",
        preset_id: null,
        usage: 0.003294,
        is_byok: false,
        native_finish_reason: null,
        external_user: null,
        api_type: null,
        request_id: null,
        response_cache_source_id: null,
        router: null,
        service_tier: null,
        session_id: null,
        provider_responses: null,
        user_agent: null,
        web_search_engine: null
      }
    }

    deepStrictEqual(Schema.decodeUnknownSync(Generated.GetGeneration200)(response), response)
  })

  it("preserves streamed usage cost fields", () => {
    const usage = {
      completion_tokens: 11,
      prompt_tokens: 7,
      total_tokens: 18,
      cost: 0.000365,
      is_byok: false,
      prompt_tokens_details: {
        cached_tokens: 0,
        cache_write_tokens: 0
      }
    }

    deepStrictEqual(Schema.decodeUnknownSync(Generated.ChatUsage)(usage), usage)
  })
})
