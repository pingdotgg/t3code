/**
 * @since 4.0.0
 */

import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import type { SchemaError } from "effect/Schema"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Sse from "effect/unstable/encoding/Sse"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
// non-recursive definitions
export type OpenAIResponsesResponseStatus =
  | "completed"
  | "incomplete"
  | "in_progress"
  | "failed"
  | "cancelled"
  | "queued"
export const OpenAIResponsesResponseStatus = Schema.Literals([
  "completed",
  "incomplete",
  "in_progress",
  "failed",
  "cancelled",
  "queued"
])
export type FileCitation = {
  readonly "type": "file_citation"
  readonly "file_id": string
  readonly "filename": string
  readonly "index": number
}
export const FileCitation = Schema.Struct({
  "type": Schema.Literal("file_citation"),
  "file_id": Schema.String,
  "filename": Schema.String,
  "index": Schema.Number.check(Schema.isFinite())
})
export type URLCitation = {
  readonly "type": "url_citation"
  readonly "url": string
  readonly "title": string
  readonly "start_index": number
  readonly "end_index": number
}
export const URLCitation = Schema.Struct({
  "type": Schema.Literal("url_citation"),
  "url": Schema.String,
  "title": Schema.String,
  "start_index": Schema.Number.check(Schema.isFinite()),
  "end_index": Schema.Number.check(Schema.isFinite())
})
export type FilePath = { readonly "type": "file_path"; readonly "file_id": string; readonly "index": number }
export const FilePath = Schema.Struct({
  "type": Schema.Literal("file_path"),
  "file_id": Schema.String,
  "index": Schema.Number.check(Schema.isFinite())
})
export type OpenAIResponsesRefusalContent = { readonly "type": "refusal"; readonly "refusal": string }
export const OpenAIResponsesRefusalContent = Schema.Struct({
  "type": Schema.Literal("refusal"),
  "refusal": Schema.String
})
export type ReasoningTextContent = { readonly "type": "reasoning_text"; readonly "text": string }
export const ReasoningTextContent = Schema.Struct({ "type": Schema.Literal("reasoning_text"), "text": Schema.String })
export type ReasoningSummaryText = { readonly "type": "summary_text"; readonly "text": string }
export const ReasoningSummaryText = Schema.Struct({ "type": Schema.Literal("summary_text"), "text": Schema.String })
export type OutputItemFunctionCall = {
  readonly "type": "function_call"
  readonly "id"?: string
  readonly "name": string
  readonly "arguments": string
  readonly "call_id": string
  readonly "status"?: "completed" | "incomplete" | "in_progress"
}
export const OutputItemFunctionCall = Schema.Struct({
  "type": Schema.Literal("function_call"),
  "id": Schema.optionalKey(Schema.String),
  "name": Schema.String,
  "arguments": Schema.String,
  "call_id": Schema.String,
  "status": Schema.optionalKey(Schema.Literals(["completed", "incomplete", "in_progress"]))
})
export type ResponsesOutputItemFunctionCall = {
  readonly "type": "function_call"
  readonly "id"?: string
  readonly "name": string
  readonly "arguments": string
  readonly "call_id": string
  readonly "status"?: "completed" | "incomplete" | "in_progress"
}
export const ResponsesOutputItemFunctionCall = Schema.Struct({
  "type": Schema.Literal("function_call"),
  "id": Schema.optionalKey(Schema.String),
  "name": Schema.String,
  "arguments": Schema.String,
  "call_id": Schema.String,
  "status": Schema.optionalKey(Schema.Literals(["completed", "incomplete", "in_progress"]))
})
export type WebSearchStatus = "completed" | "searching" | "in_progress" | "failed"
export const WebSearchStatus = Schema.Literals(["completed", "searching", "in_progress", "failed"])
export type ImageGenerationStatus = "in_progress" | "completed" | "generating" | "failed"
export const ImageGenerationStatus = Schema.Literals(["in_progress", "completed", "generating", "failed"])
export type ResponsesErrorField = {
  readonly "code":
    | "server_error"
    | "rate_limit_exceeded"
    | "invalid_prompt"
    | "vector_store_timeout"
    | "invalid_image"
    | "invalid_image_format"
    | "invalid_base64_image"
    | "invalid_image_url"
    | "image_too_large"
    | "image_too_small"
    | "image_parse_error"
    | "image_content_policy_violation"
    | "invalid_image_mode"
    | "image_file_too_large"
    | "unsupported_image_media_type"
    | "empty_image_file"
    | "failed_to_download_image"
    | "image_file_not_found"
  readonly "message": string
}
export const ResponsesErrorField = Schema.Struct({
  "code": Schema.Literals([
    "server_error",
    "rate_limit_exceeded",
    "invalid_prompt",
    "vector_store_timeout",
    "invalid_image",
    "invalid_image_format",
    "invalid_base64_image",
    "invalid_image_url",
    "image_too_large",
    "image_too_small",
    "image_parse_error",
    "image_content_policy_violation",
    "invalid_image_mode",
    "image_file_too_large",
    "unsupported_image_media_type",
    "empty_image_file",
    "failed_to_download_image",
    "image_file_not_found"
  ]),
  "message": Schema.String
}).annotate({ "description": "Error information returned from the API" })
export type OpenAIResponsesIncompleteDetails = { readonly "reason"?: "max_output_tokens" | "content_filter" }
export const OpenAIResponsesIncompleteDetails = Schema.Struct({
  "reason": Schema.optionalKey(Schema.Literals(["max_output_tokens", "content_filter"]))
})
export type OpenAIResponsesUsage = {
  readonly "input_tokens": number
  readonly "input_tokens_details": { readonly "cached_tokens": number }
  readonly "output_tokens": number
  readonly "output_tokens_details": { readonly "reasoning_tokens": number }
  readonly "total_tokens": number
}
export const OpenAIResponsesUsage = Schema.Struct({
  "input_tokens": Schema.Number.check(Schema.isFinite()),
  "input_tokens_details": Schema.Struct({ "cached_tokens": Schema.Number.check(Schema.isFinite()) }),
  "output_tokens": Schema.Number.check(Schema.isFinite()),
  "output_tokens_details": Schema.Struct({ "reasoning_tokens": Schema.Number.check(Schema.isFinite()) }),
  "total_tokens": Schema.Number.check(Schema.isFinite())
})
export type ResponseInputText = { readonly "type": "input_text"; readonly "text": string }
export const ResponseInputText = Schema.Struct({ "type": Schema.Literal("input_text"), "text": Schema.String })
  .annotate({ "description": "Text input content item" })
export type ResponseInputImage = {
  readonly "type": "input_image"
  readonly "detail": "auto" | "high" | "low"
  readonly "image_url"?: string
}
export const ResponseInputImage = Schema.Struct({
  "type": Schema.Literal("input_image"),
  "detail": Schema.Literals(["auto", "high", "low"]),
  "image_url": Schema.optionalKey(Schema.String)
}).annotate({ "description": "Image input content item" })
export type ResponseInputFile = {
  readonly "type": "input_file"
  readonly "file_id"?: string
  readonly "file_data"?: string
  readonly "filename"?: string
  readonly "file_url"?: string
}
export const ResponseInputFile = Schema.Struct({
  "type": Schema.Literal("input_file"),
  "file_id": Schema.optionalKey(Schema.String),
  "file_data": Schema.optionalKey(Schema.String),
  "filename": Schema.optionalKey(Schema.String),
  "file_url": Schema.optionalKey(Schema.String)
}).annotate({ "description": "File input content item" })
export type ResponseInputAudio = {
  readonly "type": "input_audio"
  readonly "input_audio": { readonly "data": string; readonly "format": "mp3" | "wav" }
}
export const ResponseInputAudio = Schema.Struct({
  "type": Schema.Literal("input_audio"),
  "input_audio": Schema.Struct({ "data": Schema.String, "format": Schema.Literals(["mp3", "wav"]) })
}).annotate({ "description": "Audio input content item" })
export type ToolCallStatus = "in_progress" | "completed" | "incomplete"
export const ToolCallStatus = Schema.Literals(["in_progress", "completed", "incomplete"])
export type OpenResponsesRequestMetadata = {}
export const OpenResponsesRequestMetadata = Schema.Struct({}).annotate({
  "description":
    "Metadata key-value pairs for the request. Keys must be ≤64 characters and cannot contain brackets. Values must be ≤512 characters. Maximum 16 pairs allowed."
})
export type ResponsesSearchContextSize = "low" | "medium" | "high"
export const ResponsesSearchContextSize = Schema.Literals(["low", "medium", "high"]).annotate({
  "description": "Size of the search context for web search tools"
})
export type WebSearchPreviewToolUserLocation = {
  readonly "type": "approximate"
  readonly "city"?: string
  readonly "country"?: string
  readonly "region"?: string
  readonly "timezone"?: string
}
export const WebSearchPreviewToolUserLocation = Schema.Struct({
  "type": Schema.Literal("approximate"),
  "city": Schema.optionalKey(Schema.String),
  "country": Schema.optionalKey(Schema.String),
  "region": Schema.optionalKey(Schema.String),
  "timezone": Schema.optionalKey(Schema.String)
})
export type ResponsesWebSearchUserLocation = {
  readonly "type"?: "approximate"
  readonly "city"?: string
  readonly "country"?: string
  readonly "region"?: string
  readonly "timezone"?: string
}
export const ResponsesWebSearchUserLocation = Schema.Struct({
  "type": Schema.optionalKey(Schema.Literal("approximate")),
  "city": Schema.optionalKey(Schema.String),
  "country": Schema.optionalKey(Schema.String),
  "region": Schema.optionalKey(Schema.String),
  "timezone": Schema.optionalKey(Schema.String)
}).annotate({ "description": "User location information for web search" })
export type OpenAIResponsesToolChoice = "auto" | "none" | "required" | {
  readonly "type": "function"
  readonly "name": string
} | { readonly "type": "web_search_preview_2025_03_11" | "web_search_preview" }
export const OpenAIResponsesToolChoice = Schema.Union([
  Schema.Literal("auto"),
  Schema.Literal("none"),
  Schema.Literal("required"),
  Schema.Struct({ "type": Schema.Literal("function"), "name": Schema.String }),
  Schema.Struct({ "type": Schema.Literals(["web_search_preview_2025_03_11", "web_search_preview"]) })
])
export type OpenAIResponsesPrompt = { readonly "id": string; readonly "variables"?: {} }
export const OpenAIResponsesPrompt = Schema.Struct({
  "id": Schema.String,
  "variables": Schema.optionalKey(Schema.Struct({}))
})
export type OpenAIResponsesReasoningEffort = "xhigh" | "high" | "medium" | "low" | "minimal" | "none"
export const OpenAIResponsesReasoningEffort = Schema.Literals(["xhigh", "high", "medium", "low", "minimal", "none"])
export type ReasoningSummaryVerbosity = "auto" | "concise" | "detailed"
export const ReasoningSummaryVerbosity = Schema.Literals(["auto", "concise", "detailed"])
export type OpenAIResponsesServiceTier = "auto" | "default" | "flex" | "priority" | "scale"
export const OpenAIResponsesServiceTier = Schema.Literals(["auto", "default", "flex", "priority", "scale"])
export type OpenAIResponsesTruncation = "auto" | "disabled"
export const OpenAIResponsesTruncation = Schema.Literals(["auto", "disabled"])
export type ResponsesFormatText = { readonly "type": "text" }
export const ResponsesFormatText = Schema.Struct({ "type": Schema.Literal("text") }).annotate({
  "description": "Plain text response format"
})
export type ResponsesFormatJSONObject = { readonly "type": "json_object" }
export const ResponsesFormatJSONObject = Schema.Struct({ "type": Schema.Literal("json_object") }).annotate({
  "description": "JSON object response format"
})
export type ResponsesFormatTextJSONSchemaConfig = {
  readonly "type": "json_schema"
  readonly "name": string
  readonly "description"?: string
  readonly "strict"?: boolean
  readonly "schema": {}
}
export const ResponsesFormatTextJSONSchemaConfig = Schema.Struct({
  "type": Schema.Literal("json_schema"),
  "name": Schema.String,
  "description": Schema.optionalKey(Schema.String),
  "strict": Schema.optionalKey(Schema.Boolean),
  "schema": Schema.Struct({})
}).annotate({ "description": "JSON schema constrained response format" })
export type OpenResponsesErrorEvent = {
  readonly "type": "error"
  readonly "code": string
  readonly "message": string
  readonly "param": string
  readonly "sequence_number": number
}
export const OpenResponsesErrorEvent = Schema.Struct({
  "type": Schema.Literal("error"),
  "code": Schema.String,
  "message": Schema.String,
  "param": Schema.String,
  "sequence_number": Schema.Number.check(Schema.isFinite())
}).annotate({ "description": "Event emitted when an error occurs during streaming" })
export type OpenResponsesTopLogprobs = { readonly "token"?: string; readonly "logprob"?: number }
export const OpenResponsesTopLogprobs = Schema.Struct({
  "token": Schema.optionalKey(Schema.String),
  "logprob": Schema.optionalKey(Schema.Number.check(Schema.isFinite()))
}).annotate({ "description": "Alternative token with its log probability" })
export type OpenResponsesRefusalDeltaEvent = {
  readonly "type": "response.refusal.delta"
  readonly "output_index": number
  readonly "item_id": string
  readonly "content_index": number
  readonly "delta": string
  readonly "sequence_number": number
}
export const OpenResponsesRefusalDeltaEvent = Schema.Struct({
  "type": Schema.Literal("response.refusal.delta"),
  "output_index": Schema.Number.check(Schema.isFinite()),
  "item_id": Schema.String,
  "content_index": Schema.Number.check(Schema.isFinite()),
  "delta": Schema.String,
  "sequence_number": Schema.Number.check(Schema.isFinite())
}).annotate({ "description": "Event emitted when a refusal delta is streamed" })
export type OpenResponsesRefusalDoneEvent = {
  readonly "type": "response.refusal.done"
  readonly "output_index": number
  readonly "item_id": string
  readonly "content_index": number
  readonly "refusal": string
  readonly "sequence_number": number
}
export const OpenResponsesRefusalDoneEvent = Schema.Struct({
  "type": Schema.Literal("response.refusal.done"),
  "output_index": Schema.Number.check(Schema.isFinite()),
  "item_id": Schema.String,
  "content_index": Schema.Number.check(Schema.isFinite()),
  "refusal": Schema.String,
  "sequence_number": Schema.Number.check(Schema.isFinite())
}).annotate({ "description": "Event emitted when refusal streaming is complete" })
export type OpenResponsesFunctionCallArgumentsDeltaEvent = {
  readonly "type": "response.function_call_arguments.delta"
  readonly "item_id": string
  readonly "output_index": number
  readonly "delta": string
  readonly "sequence_number": number
}
export const OpenResponsesFunctionCallArgumentsDeltaEvent = Schema.Struct({
  "type": Schema.Literal("response.function_call_arguments.delta"),
  "item_id": Schema.String,
  "output_index": Schema.Number.check(Schema.isFinite()),
  "delta": Schema.String,
  "sequence_number": Schema.Number.check(Schema.isFinite())
}).annotate({ "description": "Event emitted when function call arguments are being streamed" })
export type OpenResponsesFunctionCallArgumentsDoneEvent = {
  readonly "type": "response.function_call_arguments.done"
  readonly "item_id": string
  readonly "output_index": number
  readonly "name": string
  readonly "arguments": string
  readonly "sequence_number": number
}
export const OpenResponsesFunctionCallArgumentsDoneEvent = Schema.Struct({
  "type": Schema.Literal("response.function_call_arguments.done"),
  "item_id": Schema.String,
  "output_index": Schema.Number.check(Schema.isFinite()),
  "name": Schema.String,
  "arguments": Schema.String,
  "sequence_number": Schema.Number.check(Schema.isFinite())
}).annotate({ "description": "Event emitted when function call arguments streaming is complete" })
export type OpenResponsesReasoningDeltaEvent = {
  readonly "type": "response.reasoning_text.delta"
  readonly "output_index": number
  readonly "item_id": string
  readonly "content_index": number
  readonly "delta": string
  readonly "sequence_number": number
}
export const OpenResponsesReasoningDeltaEvent = Schema.Struct({
  "type": Schema.Literal("response.reasoning_text.delta"),
  "output_index": Schema.Number.check(Schema.isFinite()),
  "item_id": Schema.String,
  "content_index": Schema.Number.check(Schema.isFinite()),
  "delta": Schema.String,
  "sequence_number": Schema.Number.check(Schema.isFinite())
}).annotate({ "description": "Event emitted when reasoning text delta is streamed" })
export type OpenResponsesReasoningDoneEvent = {
  readonly "type": "response.reasoning_text.done"
  readonly "output_index": number
  readonly "item_id": string
  readonly "content_index": number
  readonly "text": string
  readonly "sequence_number": number
}
export const OpenResponsesReasoningDoneEvent = Schema.Struct({
  "type": Schema.Literal("response.reasoning_text.done"),
  "output_index": Schema.Number.check(Schema.isFinite()),
  "item_id": Schema.String,
  "content_index": Schema.Number.check(Schema.isFinite()),
  "text": Schema.String,
  "sequence_number": Schema.Number.check(Schema.isFinite())
}).annotate({ "description": "Event emitted when reasoning text streaming is complete" })
export type OpenResponsesReasoningSummaryTextDeltaEvent = {
  readonly "type": "response.reasoning_summary_text.delta"
  readonly "item_id": string
  readonly "output_index": number
  readonly "summary_index": number
  readonly "delta": string
  readonly "sequence_number": number
}
export const OpenResponsesReasoningSummaryTextDeltaEvent = Schema.Struct({
  "type": Schema.Literal("response.reasoning_summary_text.delta"),
  "item_id": Schema.String,
  "output_index": Schema.Number.check(Schema.isFinite()),
  "summary_index": Schema.Number.check(Schema.isFinite()),
  "delta": Schema.String,
  "sequence_number": Schema.Number.check(Schema.isFinite())
}).annotate({ "description": "Event emitted when reasoning summary text delta is streamed" })
export type OpenResponsesReasoningSummaryTextDoneEvent = {
  readonly "type": "response.reasoning_summary_text.done"
  readonly "item_id": string
  readonly "output_index": number
  readonly "summary_index": number
  readonly "text": string
  readonly "sequence_number": number
}
export const OpenResponsesReasoningSummaryTextDoneEvent = Schema.Struct({
  "type": Schema.Literal("response.reasoning_summary_text.done"),
  "item_id": Schema.String,
  "output_index": Schema.Number.check(Schema.isFinite()),
  "summary_index": Schema.Number.check(Schema.isFinite()),
  "text": Schema.String,
  "sequence_number": Schema.Number.check(Schema.isFinite())
}).annotate({ "description": "Event emitted when reasoning summary text streaming is complete" })
export type OpenResponsesImageGenCallInProgress = {
  readonly "type": "response.image_generation_call.in_progress"
  readonly "item_id": string
  readonly "output_index": number
  readonly "sequence_number": number
}
export const OpenResponsesImageGenCallInProgress = Schema.Struct({
  "type": Schema.Literal("response.image_generation_call.in_progress"),
  "item_id": Schema.String,
  "output_index": Schema.Number.check(Schema.isFinite()),
  "sequence_number": Schema.Number.check(Schema.isFinite())
}).annotate({ "description": "Image generation call in progress" })
export type OpenResponsesImageGenCallGenerating = {
  readonly "type": "response.image_generation_call.generating"
  readonly "item_id": string
  readonly "output_index": number
  readonly "sequence_number": number
}
export const OpenResponsesImageGenCallGenerating = Schema.Struct({
  "type": Schema.Literal("response.image_generation_call.generating"),
  "item_id": Schema.String,
  "output_index": Schema.Number.check(Schema.isFinite()),
  "sequence_number": Schema.Number.check(Schema.isFinite())
}).annotate({ "description": "Image generation call is generating" })
export type OpenResponsesImageGenCallPartialImage = {
  readonly "type": "response.image_generation_call.partial_image"
  readonly "item_id": string
  readonly "output_index": number
  readonly "sequence_number": number
  readonly "partial_image_b64": string
  readonly "partial_image_index": number
}
export const OpenResponsesImageGenCallPartialImage = Schema.Struct({
  "type": Schema.Literal("response.image_generation_call.partial_image"),
  "item_id": Schema.String,
  "output_index": Schema.Number.check(Schema.isFinite()),
  "sequence_number": Schema.Number.check(Schema.isFinite()),
  "partial_image_b64": Schema.String,
  "partial_image_index": Schema.Number.check(Schema.isFinite())
}).annotate({ "description": "Image generation call with partial image" })
export type OpenResponsesImageGenCallCompleted = {
  readonly "type": "response.image_generation_call.completed"
  readonly "item_id": string
  readonly "output_index": number
  readonly "sequence_number": number
}
export const OpenResponsesImageGenCallCompleted = Schema.Struct({
  "type": Schema.Literal("response.image_generation_call.completed"),
  "item_id": Schema.String,
  "output_index": Schema.Number.check(Schema.isFinite()),
  "sequence_number": Schema.Number.check(Schema.isFinite())
}).annotate({ "description": "Image generation call completed" })
export type BadRequestResponseErrorData = {
  readonly "code": number
  readonly "message": string
  readonly "metadata"?: {}
}
export const BadRequestResponseErrorData = Schema.Struct({
  "code": Schema.Number.check(Schema.isInt()),
  "message": Schema.String,
  "metadata": Schema.optionalKey(Schema.Struct({}))
}).annotate({ "description": "Error data for BadRequestResponse" })
export type UnauthorizedResponseErrorData = {
  readonly "code": number
  readonly "message": string
  readonly "metadata"?: {}
}
export const UnauthorizedResponseErrorData = Schema.Struct({
  "code": Schema.Number.check(Schema.isInt()),
  "message": Schema.String,
  "metadata": Schema.optionalKey(Schema.Struct({}))
}).annotate({ "description": "Error data for UnauthorizedResponse" })
export type PaymentRequiredResponseErrorData = {
  readonly "code": number
  readonly "message": string
  readonly "metadata"?: {}
}
export const PaymentRequiredResponseErrorData = Schema.Struct({
  "code": Schema.Number.check(Schema.isInt()),
  "message": Schema.String,
  "metadata": Schema.optionalKey(Schema.Struct({}))
}).annotate({ "description": "Error data for PaymentRequiredResponse" })
export type NotFoundResponseErrorData = {
  readonly "code": number
  readonly "message": string
  readonly "metadata"?: {}
}
export const NotFoundResponseErrorData = Schema.Struct({
  "code": Schema.Number.check(Schema.isInt()),
  "message": Schema.String,
  "metadata": Schema.optionalKey(Schema.Struct({}))
}).annotate({ "description": "Error data for NotFoundResponse" })
export type RequestTimeoutResponseErrorData = {
  readonly "code": number
  readonly "message": string
  readonly "metadata"?: {}
}
export const RequestTimeoutResponseErrorData = Schema.Struct({
  "code": Schema.Number.check(Schema.isInt()),
  "message": Schema.String,
  "metadata": Schema.optionalKey(Schema.Struct({}))
}).annotate({ "description": "Error data for RequestTimeoutResponse" })
export type PayloadTooLargeResponseErrorData = {
  readonly "code": number
  readonly "message": string
  readonly "metadata"?: {}
}
export const PayloadTooLargeResponseErrorData = Schema.Struct({
  "code": Schema.Number.check(Schema.isInt()),
  "message": Schema.String,
  "metadata": Schema.optionalKey(Schema.Struct({}))
}).annotate({ "description": "Error data for PayloadTooLargeResponse" })
export type UnprocessableEntityResponseErrorData = {
  readonly "code": number
  readonly "message": string
  readonly "metadata"?: {}
}
export const UnprocessableEntityResponseErrorData = Schema.Struct({
  "code": Schema.Number.check(Schema.isInt()),
  "message": Schema.String,
  "metadata": Schema.optionalKey(Schema.Struct({}))
}).annotate({ "description": "Error data for UnprocessableEntityResponse" })
export type TooManyRequestsResponseErrorData = {
  readonly "code": number
  readonly "message": string
  readonly "metadata"?: {}
}
export const TooManyRequestsResponseErrorData = Schema.Struct({
  "code": Schema.Number.check(Schema.isInt()),
  "message": Schema.String,
  "metadata": Schema.optionalKey(Schema.Struct({}))
}).annotate({ "description": "Error data for TooManyRequestsResponse" })
export type InternalServerResponseErrorData = {
  readonly "code": number
  readonly "message": string
  readonly "metadata"?: {}
}
export const InternalServerResponseErrorData = Schema.Struct({
  "code": Schema.Number.check(Schema.isInt()),
  "message": Schema.String,
  "metadata": Schema.optionalKey(Schema.Struct({}))
}).annotate({ "description": "Error data for InternalServerResponse" })
export type BadGatewayResponseErrorData = {
  readonly "code": number
  readonly "message": string
  readonly "metadata"?: {}
}
export const BadGatewayResponseErrorData = Schema.Struct({
  "code": Schema.Number.check(Schema.isInt()),
  "message": Schema.String,
  "metadata": Schema.optionalKey(Schema.Struct({}))
}).annotate({ "description": "Error data for BadGatewayResponse" })
export type ServiceUnavailableResponseErrorData = {
  readonly "code": number
  readonly "message": string
  readonly "metadata"?: {}
}
export const ServiceUnavailableResponseErrorData = Schema.Struct({
  "code": Schema.Number.check(Schema.isInt()),
  "message": Schema.String,
  "metadata": Schema.optionalKey(Schema.Struct({}))
}).annotate({ "description": "Error data for ServiceUnavailableResponse" })
export type EdgeNetworkTimeoutResponseErrorData = {
  readonly "code": number
  readonly "message": string
  readonly "metadata"?: {}
}
export const EdgeNetworkTimeoutResponseErrorData = Schema.Struct({
  "code": Schema.Number.check(Schema.isInt()),
  "message": Schema.String,
  "metadata": Schema.optionalKey(Schema.Struct({}))
}).annotate({ "description": "Error data for EdgeNetworkTimeoutResponse" })
export type ProviderOverloadedResponseErrorData = {
  readonly "code": number
  readonly "message": string
  readonly "metadata"?: {}
}
export const ProviderOverloadedResponseErrorData = Schema.Struct({
  "code": Schema.Number.check(Schema.isInt()),
  "message": Schema.String,
  "metadata": Schema.optionalKey(Schema.Struct({}))
}).annotate({ "description": "Error data for ProviderOverloadedResponse" })
export type ResponseInputVideo = { readonly "type": "input_video"; readonly "video_url": string }
export const ResponseInputVideo = Schema.Struct({
  "type": Schema.Literal("input_video"),
  "video_url": Schema.String.annotate({
    "description": "A base64 data URL or remote URL that resolves to a video file"
  })
}).annotate({ "description": "Video input content item" })
export type ResponsesOutputModality = "text" | "image"
export const ResponsesOutputModality = Schema.Literals(["text", "image"])
export type OpenAIResponsesIncludable =
  | "file_search_call.results"
  | "message.input_image.image_url"
  | "computer_call_output.output.image_url"
  | "reasoning.encrypted_content"
  | "code_interpreter_call.outputs"
export const OpenAIResponsesIncludable = Schema.Literals([
  "file_search_call.results",
  "message.input_image.image_url",
  "computer_call_output.output.image_url",
  "reasoning.encrypted_content",
  "code_interpreter_call.outputs"
])
export type DataCollection = "deny" | "allow"
export const DataCollection = Schema.Literals(["deny", "allow"]).annotate({
  "description":
    "Data collection setting. If no available model provider meets the requirement, your request will return an error.\n- allow: (default) allow providers which store user data non-transiently and may train on it\n\n- deny: use only providers which do not collect user data."
})
export type ProviderName =
  | "AI21"
  | "AionLabs"
  | "Alibaba"
  | "Ambient"
  | "Amazon Bedrock"
  | "Amazon Nova"
  | "Anthropic"
  | "Arcee AI"
  | "AtlasCloud"
  | "Avian"
  | "Azure"
  | "BaseTen"
  | "BytePlus"
  | "Black Forest Labs"
  | "Cerebras"
  | "Chutes"
  | "Cirrascale"
  | "Clarifai"
  | "Cloudflare"
  | "Cohere"
  | "Crusoe"
  | "DeepInfra"
  | "DeepSeek"
  | "Featherless"
  | "Fireworks"
  | "Friendli"
  | "GMICloud"
  | "Google"
  | "Google AI Studio"
  | "Groq"
  | "Hyperbolic"
  | "Inception"
  | "Inceptron"
  | "InferenceNet"
  | "Infermatic"
  | "Io Net"
  | "Inflection"
  | "Liquid"
  | "Mara"
  | "Mancer 2"
  | "Minimax"
  | "ModelRun"
  | "Mistral"
  | "Modular"
  | "Moonshot AI"
  | "Morph"
  | "NCompass"
  | "Nebius"
  | "NextBit"
  | "Novita"
  | "Nvidia"
  | "OpenAI"
  | "OpenInference"
  | "Parasail"
  | "Perplexity"
  | "Phala"
  | "Relace"
  | "SambaNova"
  | "Seed"
  | "SiliconFlow"
  | "Sourceful"
  | "StepFun"
  | "Stealth"
  | "StreamLake"
  | "Switchpoint"
  | "Together"
  | "Upstage"
  | "Venice"
  | "WandB"
  | "Xiaomi"
  | "xAI"
  | "Z.AI"
  | "FakeProvider"
export const ProviderName = Schema.Literals([
  "AI21",
  "AionLabs",
  "Alibaba",
  "Ambient",
  "Amazon Bedrock",
  "Amazon Nova",
  "Anthropic",
  "Arcee AI",
  "AtlasCloud",
  "Avian",
  "Azure",
  "BaseTen",
  "BytePlus",
  "Black Forest Labs",
  "Cerebras",
  "Chutes",
  "Cirrascale",
  "Clarifai",
  "Cloudflare",
  "Cohere",
  "Crusoe",
  "DeepInfra",
  "DeepSeek",
  "Featherless",
  "Fireworks",
  "Friendli",
  "GMICloud",
  "Google",
  "Google AI Studio",
  "Groq",
  "Hyperbolic",
  "Inception",
  "Inceptron",
  "InferenceNet",
  "Infermatic",
  "Io Net",
  "Inflection",
  "Liquid",
  "Mara",
  "Mancer 2",
  "Minimax",
  "ModelRun",
  "Mistral",
  "Modular",
  "Moonshot AI",
  "Morph",
  "NCompass",
  "Nebius",
  "NextBit",
  "Novita",
  "Nvidia",
  "OpenAI",
  "OpenInference",
  "Parasail",
  "Perplexity",
  "Phala",
  "Relace",
  "SambaNova",
  "Seed",
  "SiliconFlow",
  "Sourceful",
  "StepFun",
  "Stealth",
  "StreamLake",
  "Switchpoint",
  "Together",
  "Upstage",
  "Venice",
  "WandB",
  "Xiaomi",
  "xAI",
  "Z.AI",
  "FakeProvider"
])
export type Quantization = "int4" | "int8" | "fp4" | "fp6" | "fp8" | "fp16" | "bf16" | "fp32" | "unknown"
export const Quantization = Schema.Literals(["int4", "int8", "fp4", "fp6", "fp8", "fp16", "bf16", "fp32", "unknown"])
export type ProviderSort = "price" | "throughput" | "latency"
export const ProviderSort = Schema.Literals(["price", "throughput", "latency"])
export type BigNumberUnion = string
export const BigNumberUnion = Schema.String.annotate({ "description": "Price per million prompt tokens" })
export type PercentileThroughputCutoffs = {
  readonly "p50"?: number
  readonly "p75"?: number
  readonly "p90"?: number
  readonly "p99"?: number
}
export const PercentileThroughputCutoffs = Schema.Struct({
  "p50": Schema.optionalKey(
    Schema.Number.annotate({ "description": "Minimum p50 throughput (tokens/sec)" }).check(Schema.isFinite())
  ),
  "p75": Schema.optionalKey(
    Schema.Number.annotate({ "description": "Minimum p75 throughput (tokens/sec)" }).check(Schema.isFinite())
  ),
  "p90": Schema.optionalKey(
    Schema.Number.annotate({ "description": "Minimum p90 throughput (tokens/sec)" }).check(Schema.isFinite())
  ),
  "p99": Schema.optionalKey(
    Schema.Number.annotate({ "description": "Minimum p99 throughput (tokens/sec)" }).check(Schema.isFinite())
  )
}).annotate({
  "description":
    "Percentile-based throughput cutoffs. All specified cutoffs must be met for an endpoint to be preferred."
})
export type PercentileLatencyCutoffs = {
  readonly "p50"?: number
  readonly "p75"?: number
  readonly "p90"?: number
  readonly "p99"?: number
}
export const PercentileLatencyCutoffs = Schema.Struct({
  "p50": Schema.optionalKey(
    Schema.Number.annotate({ "description": "Maximum p50 latency (seconds)" }).check(Schema.isFinite())
  ),
  "p75": Schema.optionalKey(
    Schema.Number.annotate({ "description": "Maximum p75 latency (seconds)" }).check(Schema.isFinite())
  ),
  "p90": Schema.optionalKey(
    Schema.Number.annotate({ "description": "Maximum p90 latency (seconds)" }).check(Schema.isFinite())
  ),
  "p99": Schema.optionalKey(
    Schema.Number.annotate({ "description": "Maximum p99 latency (seconds)" }).check(Schema.isFinite())
  )
}).annotate({
  "description": "Percentile-based latency cutoffs. All specified cutoffs must be met for an endpoint to be preferred."
})
export type WebSearchEngine = "native" | "exa"
export const WebSearchEngine = Schema.Literals(["native", "exa"]).annotate({
  "description": "The search engine to use for web search."
})
export type PDFParserEngine = "mistral-ocr" | "pdf-text" | "native"
export const PDFParserEngine = Schema.Literals(["mistral-ocr", "pdf-text", "native"]).annotate({
  "description": "The engine to use for parsing PDF files."
})
export type AnthropicMessagesResponse = {
  readonly "id": string
  readonly "type": "message"
  readonly "role": "assistant"
  readonly "content": ReadonlyArray<
    | {
      readonly "type": "text"
      readonly "text": string
      readonly "citations": ReadonlyArray<
        {
          readonly "type": "char_location"
          readonly "cited_text": string
          readonly "document_index": number
          readonly "document_title": string
          readonly "start_char_index": number
          readonly "end_char_index": number
          readonly "file_id": string
        } | {
          readonly "type": "page_location"
          readonly "cited_text": string
          readonly "document_index": number
          readonly "document_title": string
          readonly "start_page_number": number
          readonly "end_page_number": number
          readonly "file_id": string
        } | {
          readonly "type": "content_block_location"
          readonly "cited_text": string
          readonly "document_index": number
          readonly "document_title": string
          readonly "start_block_index": number
          readonly "end_block_index": number
          readonly "file_id": string
        } | {
          readonly "type": "web_search_result_location"
          readonly "cited_text": string
          readonly "encrypted_index": string
          readonly "title": string
          readonly "url": string
        } | {
          readonly "type": "search_result_location"
          readonly "cited_text": string
          readonly "search_result_index": number
          readonly "source": string
          readonly "title": string
          readonly "start_block_index": number
          readonly "end_block_index": number
        }
      >
    }
    | { readonly "type": "tool_use"; readonly "id": string; readonly "name": string; readonly "input"?: unknown }
    | { readonly "type": "thinking"; readonly "thinking": string; readonly "signature": string }
    | { readonly "type": "redacted_thinking"; readonly "data": string }
    | {
      readonly "type": "server_tool_use"
      readonly "id": string
      readonly "name": "web_search"
      readonly "input"?: unknown
    }
    | {
      readonly "type": "web_search_tool_result"
      readonly "tool_use_id": string
      readonly "content":
        | ReadonlyArray<
          {
            readonly "type": "web_search_result"
            readonly "encrypted_content": string
            readonly "page_age": string
            readonly "title": string
            readonly "url": string
          }
        >
        | {
          readonly "type": "web_search_tool_result_error"
          readonly "error_code":
            | "invalid_tool_input"
            | "unavailable"
            | "max_uses_exceeded"
            | "too_many_requests"
            | "query_too_long"
        }
    }
  >
  readonly "model": string
  readonly "stop_reason": "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "pause_turn" | "refusal"
  readonly "stop_sequence": string
  readonly "usage": {
    readonly "input_tokens": number
    readonly "output_tokens": number
    readonly "cache_creation_input_tokens": number
    readonly "cache_read_input_tokens": number
    readonly "cache_creation": {
      readonly "ephemeral_5m_input_tokens": number
      readonly "ephemeral_1h_input_tokens": number
    }
    readonly "inference_geo": string
    readonly "server_tool_use": { readonly "web_search_requests": number }
    readonly "service_tier": "standard" | "priority" | "batch"
  }
}
export const AnthropicMessagesResponse = Schema.Struct({
  "id": Schema.String,
  "type": Schema.Literal("message"),
  "role": Schema.Literal("assistant"),
  "content": Schema.Array(Schema.Union([
    Schema.Struct({
      "type": Schema.Literal("text"),
      "text": Schema.String,
      "citations": Schema.Array(Schema.Union([
        Schema.Struct({
          "type": Schema.Literal("char_location"),
          "cited_text": Schema.String,
          "document_index": Schema.Number.check(Schema.isFinite()),
          "document_title": Schema.String,
          "start_char_index": Schema.Number.check(Schema.isFinite()),
          "end_char_index": Schema.Number.check(Schema.isFinite()),
          "file_id": Schema.String
        }),
        Schema.Struct({
          "type": Schema.Literal("page_location"),
          "cited_text": Schema.String,
          "document_index": Schema.Number.check(Schema.isFinite()),
          "document_title": Schema.String,
          "start_page_number": Schema.Number.check(Schema.isFinite()),
          "end_page_number": Schema.Number.check(Schema.isFinite()),
          "file_id": Schema.String
        }),
        Schema.Struct({
          "type": Schema.Literal("content_block_location"),
          "cited_text": Schema.String,
          "document_index": Schema.Number.check(Schema.isFinite()),
          "document_title": Schema.String,
          "start_block_index": Schema.Number.check(Schema.isFinite()),
          "end_block_index": Schema.Number.check(Schema.isFinite()),
          "file_id": Schema.String
        }),
        Schema.Struct({
          "type": Schema.Literal("web_search_result_location"),
          "cited_text": Schema.String,
          "encrypted_index": Schema.String,
          "title": Schema.String,
          "url": Schema.String
        }),
        Schema.Struct({
          "type": Schema.Literal("search_result_location"),
          "cited_text": Schema.String,
          "search_result_index": Schema.Number.check(Schema.isFinite()),
          "source": Schema.String,
          "title": Schema.String,
          "start_block_index": Schema.Number.check(Schema.isFinite()),
          "end_block_index": Schema.Number.check(Schema.isFinite())
        })
      ], { mode: "oneOf" }))
    }),
    Schema.Struct({
      "type": Schema.Literal("tool_use"),
      "id": Schema.String,
      "name": Schema.String,
      "input": Schema.optionalKey(Schema.Unknown)
    }),
    Schema.Struct({ "type": Schema.Literal("thinking"), "thinking": Schema.String, "signature": Schema.String }),
    Schema.Struct({ "type": Schema.Literal("redacted_thinking"), "data": Schema.String }),
    Schema.Struct({
      "type": Schema.Literal("server_tool_use"),
      "id": Schema.String,
      "name": Schema.Literal("web_search"),
      "input": Schema.optionalKey(Schema.Unknown)
    }),
    Schema.Struct({
      "type": Schema.Literal("web_search_tool_result"),
      "tool_use_id": Schema.String,
      "content": Schema.Union([
        Schema.Array(
          Schema.Struct({
            "type": Schema.Literal("web_search_result"),
            "encrypted_content": Schema.String,
            "page_age": Schema.String,
            "title": Schema.String,
            "url": Schema.String
          })
        ),
        Schema.Struct({
          "type": Schema.Literal("web_search_tool_result_error"),
          "error_code": Schema.Literals([
            "invalid_tool_input",
            "unavailable",
            "max_uses_exceeded",
            "too_many_requests",
            "query_too_long"
          ])
        })
      ])
    })
  ], { mode: "oneOf" })),
  "model": Schema.String,
  "stop_reason": Schema.Literals(["end_turn", "max_tokens", "stop_sequence", "tool_use", "pause_turn", "refusal"]),
  "stop_sequence": Schema.String,
  "usage": Schema.Struct({
    "input_tokens": Schema.Number.check(Schema.isFinite()),
    "output_tokens": Schema.Number.check(Schema.isFinite()),
    "cache_creation_input_tokens": Schema.Number.check(Schema.isFinite()),
    "cache_read_input_tokens": Schema.Number.check(Schema.isFinite()),
    "cache_creation": Schema.Struct({
      "ephemeral_5m_input_tokens": Schema.Number.check(Schema.isFinite()),
      "ephemeral_1h_input_tokens": Schema.Number.check(Schema.isFinite())
    }),
    "inference_geo": Schema.String,
    "server_tool_use": Schema.Struct({ "web_search_requests": Schema.Number.check(Schema.isFinite()) }),
    "service_tier": Schema.Literals(["standard", "priority", "batch"])
  })
}).annotate({ "description": "Non-streaming response from the Anthropic Messages API with OpenRouter extensions" })
export type AnthropicMessagesStreamEvent =
  | {
    readonly "type": "message_start"
    readonly "message": {
      readonly "id": string
      readonly "type": "message"
      readonly "role": "assistant"
      readonly "content": ReadonlyArray<
        | {
          readonly "type": "text"
          readonly "text": string
          readonly "citations": ReadonlyArray<
            {
              readonly "type": "char_location"
              readonly "cited_text": string
              readonly "document_index": number
              readonly "document_title": string
              readonly "start_char_index": number
              readonly "end_char_index": number
              readonly "file_id": string
            } | {
              readonly "type": "page_location"
              readonly "cited_text": string
              readonly "document_index": number
              readonly "document_title": string
              readonly "start_page_number": number
              readonly "end_page_number": number
              readonly "file_id": string
            } | {
              readonly "type": "content_block_location"
              readonly "cited_text": string
              readonly "document_index": number
              readonly "document_title": string
              readonly "start_block_index": number
              readonly "end_block_index": number
              readonly "file_id": string
            } | {
              readonly "type": "web_search_result_location"
              readonly "cited_text": string
              readonly "encrypted_index": string
              readonly "title": string
              readonly "url": string
            } | {
              readonly "type": "search_result_location"
              readonly "cited_text": string
              readonly "search_result_index": number
              readonly "source": string
              readonly "title": string
              readonly "start_block_index": number
              readonly "end_block_index": number
            }
          >
        }
        | { readonly "type": "tool_use"; readonly "id": string; readonly "name": string; readonly "input"?: unknown }
        | { readonly "type": "thinking"; readonly "thinking": string; readonly "signature": string }
        | { readonly "type": "redacted_thinking"; readonly "data": string }
        | {
          readonly "type": "server_tool_use"
          readonly "id": string
          readonly "name": "web_search"
          readonly "input"?: unknown
        }
        | {
          readonly "type": "web_search_tool_result"
          readonly "tool_use_id": string
          readonly "content":
            | ReadonlyArray<
              {
                readonly "type": "web_search_result"
                readonly "encrypted_content": string
                readonly "page_age": string
                readonly "title": string
                readonly "url": string
              }
            >
            | {
              readonly "type": "web_search_tool_result_error"
              readonly "error_code":
                | "invalid_tool_input"
                | "unavailable"
                | "max_uses_exceeded"
                | "too_many_requests"
                | "query_too_long"
            }
        }
      >
      readonly "model": string
      readonly "stop_reason": unknown
      readonly "stop_sequence": unknown
      readonly "usage": {
        readonly "input_tokens": number
        readonly "output_tokens": number
        readonly "cache_creation_input_tokens": number
        readonly "cache_read_input_tokens": number
        readonly "cache_creation": {
          readonly "ephemeral_5m_input_tokens": number
          readonly "ephemeral_1h_input_tokens": number
        }
        readonly "inference_geo": string
        readonly "server_tool_use": { readonly "web_search_requests": number }
        readonly "service_tier": "standard" | "priority" | "batch"
      }
    }
  }
  | {
    readonly "type": "message_delta"
    readonly "delta": {
      readonly "stop_reason": "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "pause_turn" | "refusal"
      readonly "stop_sequence": string
    }
    readonly "usage": {
      readonly "input_tokens": number
      readonly "output_tokens": number
      readonly "cache_creation_input_tokens": number
      readonly "cache_read_input_tokens": number
      readonly "server_tool_use": { readonly "web_search_requests": number }
    }
  }
  | { readonly "type": "message_stop" }
  | {
    readonly "type": "content_block_start"
    readonly "index": number
    readonly "content_block":
      | {
        readonly "type": "text"
        readonly "text": string
        readonly "citations": ReadonlyArray<
          {
            readonly "type": "char_location"
            readonly "cited_text": string
            readonly "document_index": number
            readonly "document_title": string
            readonly "start_char_index": number
            readonly "end_char_index": number
            readonly "file_id": string
          } | {
            readonly "type": "page_location"
            readonly "cited_text": string
            readonly "document_index": number
            readonly "document_title": string
            readonly "start_page_number": number
            readonly "end_page_number": number
            readonly "file_id": string
          } | {
            readonly "type": "content_block_location"
            readonly "cited_text": string
            readonly "document_index": number
            readonly "document_title": string
            readonly "start_block_index": number
            readonly "end_block_index": number
            readonly "file_id": string
          } | {
            readonly "type": "web_search_result_location"
            readonly "cited_text": string
            readonly "encrypted_index": string
            readonly "title": string
            readonly "url": string
          } | {
            readonly "type": "search_result_location"
            readonly "cited_text": string
            readonly "search_result_index": number
            readonly "source": string
            readonly "title": string
            readonly "start_block_index": number
            readonly "end_block_index": number
          }
        >
      }
      | { readonly "type": "tool_use"; readonly "id": string; readonly "name": string; readonly "input"?: unknown }
      | { readonly "type": "thinking"; readonly "thinking": string; readonly "signature": string }
      | { readonly "type": "redacted_thinking"; readonly "data": string }
      | {
        readonly "type": "server_tool_use"
        readonly "id": string
        readonly "name": "web_search"
        readonly "input"?: unknown
      }
      | {
        readonly "type": "web_search_tool_result"
        readonly "tool_use_id": string
        readonly "content":
          | ReadonlyArray<
            {
              readonly "type": "web_search_result"
              readonly "encrypted_content": string
              readonly "page_age": string
              readonly "title": string
              readonly "url": string
            }
          >
          | {
            readonly "type": "web_search_tool_result_error"
            readonly "error_code":
              | "invalid_tool_input"
              | "unavailable"
              | "max_uses_exceeded"
              | "too_many_requests"
              | "query_too_long"
          }
      }
  }
  | {
    readonly "type": "content_block_delta"
    readonly "index": number
    readonly "delta":
      | { readonly "type": "text_delta"; readonly "text": string }
      | { readonly "type": "input_json_delta"; readonly "partial_json": string }
      | { readonly "type": "thinking_delta"; readonly "thinking": string }
      | { readonly "type": "signature_delta"; readonly "signature": string }
      | {
        readonly "type": "citations_delta"
        readonly "citation": {
          readonly "type": "char_location"
          readonly "cited_text": string
          readonly "document_index": number
          readonly "document_title": string
          readonly "start_char_index": number
          readonly "end_char_index": number
          readonly "file_id": string
        } | {
          readonly "type": "page_location"
          readonly "cited_text": string
          readonly "document_index": number
          readonly "document_title": string
          readonly "start_page_number": number
          readonly "end_page_number": number
          readonly "file_id": string
        } | {
          readonly "type": "content_block_location"
          readonly "cited_text": string
          readonly "document_index": number
          readonly "document_title": string
          readonly "start_block_index": number
          readonly "end_block_index": number
          readonly "file_id": string
        } | {
          readonly "type": "web_search_result_location"
          readonly "cited_text": string
          readonly "encrypted_index": string
          readonly "title": string
          readonly "url": string
        } | {
          readonly "type": "search_result_location"
          readonly "cited_text": string
          readonly "search_result_index": number
          readonly "source": string
          readonly "title": string
          readonly "start_block_index": number
          readonly "end_block_index": number
        }
      }
  }
  | { readonly "type": "content_block_stop"; readonly "index": number }
  | { readonly "type": "ping" }
  | { readonly "type": "error"; readonly "error": { readonly "type": string; readonly "message": string } }
export const AnthropicMessagesStreamEvent = Schema.Union([
  Schema.Struct({
    "type": Schema.Literal("message_start"),
    "message": Schema.Struct({
      "id": Schema.String,
      "type": Schema.Literal("message"),
      "role": Schema.Literal("assistant"),
      "content": Schema.Array(Schema.Union([
        Schema.Struct({
          "type": Schema.Literal("text"),
          "text": Schema.String,
          "citations": Schema.Array(Schema.Union([
            Schema.Struct({
              "type": Schema.Literal("char_location"),
              "cited_text": Schema.String,
              "document_index": Schema.Number.check(Schema.isFinite()),
              "document_title": Schema.String,
              "start_char_index": Schema.Number.check(Schema.isFinite()),
              "end_char_index": Schema.Number.check(Schema.isFinite()),
              "file_id": Schema.String
            }),
            Schema.Struct({
              "type": Schema.Literal("page_location"),
              "cited_text": Schema.String,
              "document_index": Schema.Number.check(Schema.isFinite()),
              "document_title": Schema.String,
              "start_page_number": Schema.Number.check(Schema.isFinite()),
              "end_page_number": Schema.Number.check(Schema.isFinite()),
              "file_id": Schema.String
            }),
            Schema.Struct({
              "type": Schema.Literal("content_block_location"),
              "cited_text": Schema.String,
              "document_index": Schema.Number.check(Schema.isFinite()),
              "document_title": Schema.String,
              "start_block_index": Schema.Number.check(Schema.isFinite()),
              "end_block_index": Schema.Number.check(Schema.isFinite()),
              "file_id": Schema.String
            }),
            Schema.Struct({
              "type": Schema.Literal("web_search_result_location"),
              "cited_text": Schema.String,
              "encrypted_index": Schema.String,
              "title": Schema.String,
              "url": Schema.String
            }),
            Schema.Struct({
              "type": Schema.Literal("search_result_location"),
              "cited_text": Schema.String,
              "search_result_index": Schema.Number.check(Schema.isFinite()),
              "source": Schema.String,
              "title": Schema.String,
              "start_block_index": Schema.Number.check(Schema.isFinite()),
              "end_block_index": Schema.Number.check(Schema.isFinite())
            })
          ], { mode: "oneOf" }))
        }),
        Schema.Struct({
          "type": Schema.Literal("tool_use"),
          "id": Schema.String,
          "name": Schema.String,
          "input": Schema.optionalKey(Schema.Unknown)
        }),
        Schema.Struct({ "type": Schema.Literal("thinking"), "thinking": Schema.String, "signature": Schema.String }),
        Schema.Struct({ "type": Schema.Literal("redacted_thinking"), "data": Schema.String }),
        Schema.Struct({
          "type": Schema.Literal("server_tool_use"),
          "id": Schema.String,
          "name": Schema.Literal("web_search"),
          "input": Schema.optionalKey(Schema.Unknown)
        }),
        Schema.Struct({
          "type": Schema.Literal("web_search_tool_result"),
          "tool_use_id": Schema.String,
          "content": Schema.Union([
            Schema.Array(
              Schema.Struct({
                "type": Schema.Literal("web_search_result"),
                "encrypted_content": Schema.String,
                "page_age": Schema.String,
                "title": Schema.String,
                "url": Schema.String
              })
            ),
            Schema.Struct({
              "type": Schema.Literal("web_search_tool_result_error"),
              "error_code": Schema.Literals([
                "invalid_tool_input",
                "unavailable",
                "max_uses_exceeded",
                "too_many_requests",
                "query_too_long"
              ])
            })
          ])
        })
      ], { mode: "oneOf" })),
      "model": Schema.String,
      "stop_reason": Schema.Unknown,
      "stop_sequence": Schema.Unknown,
      "usage": Schema.Struct({
        "input_tokens": Schema.Number.check(Schema.isFinite()),
        "output_tokens": Schema.Number.check(Schema.isFinite()),
        "cache_creation_input_tokens": Schema.Number.check(Schema.isFinite()),
        "cache_read_input_tokens": Schema.Number.check(Schema.isFinite()),
        "cache_creation": Schema.Struct({
          "ephemeral_5m_input_tokens": Schema.Number.check(Schema.isFinite()),
          "ephemeral_1h_input_tokens": Schema.Number.check(Schema.isFinite())
        }),
        "inference_geo": Schema.String,
        "server_tool_use": Schema.Struct({ "web_search_requests": Schema.Number.check(Schema.isFinite()) }),
        "service_tier": Schema.Literals(["standard", "priority", "batch"])
      })
    })
  }),
  Schema.Struct({
    "type": Schema.Literal("message_delta"),
    "delta": Schema.Struct({
      "stop_reason": Schema.Literals(["end_turn", "max_tokens", "stop_sequence", "tool_use", "pause_turn", "refusal"]),
      "stop_sequence": Schema.String
    }),
    "usage": Schema.Struct({
      "input_tokens": Schema.Number.check(Schema.isFinite()),
      "output_tokens": Schema.Number.check(Schema.isFinite()),
      "cache_creation_input_tokens": Schema.Number.check(Schema.isFinite()),
      "cache_read_input_tokens": Schema.Number.check(Schema.isFinite()),
      "server_tool_use": Schema.Struct({ "web_search_requests": Schema.Number.check(Schema.isFinite()) })
    })
  }),
  Schema.Struct({ "type": Schema.Literal("message_stop") }),
  Schema.Struct({
    "type": Schema.Literal("content_block_start"),
    "index": Schema.Number.check(Schema.isFinite()),
    "content_block": Schema.Union([
      Schema.Struct({
        "type": Schema.Literal("text"),
        "text": Schema.String,
        "citations": Schema.Array(Schema.Union([
          Schema.Struct({
            "type": Schema.Literal("char_location"),
            "cited_text": Schema.String,
            "document_index": Schema.Number.check(Schema.isFinite()),
            "document_title": Schema.String,
            "start_char_index": Schema.Number.check(Schema.isFinite()),
            "end_char_index": Schema.Number.check(Schema.isFinite()),
            "file_id": Schema.String
          }),
          Schema.Struct({
            "type": Schema.Literal("page_location"),
            "cited_text": Schema.String,
            "document_index": Schema.Number.check(Schema.isFinite()),
            "document_title": Schema.String,
            "start_page_number": Schema.Number.check(Schema.isFinite()),
            "end_page_number": Schema.Number.check(Schema.isFinite()),
            "file_id": Schema.String
          }),
          Schema.Struct({
            "type": Schema.Literal("content_block_location"),
            "cited_text": Schema.String,
            "document_index": Schema.Number.check(Schema.isFinite()),
            "document_title": Schema.String,
            "start_block_index": Schema.Number.check(Schema.isFinite()),
            "end_block_index": Schema.Number.check(Schema.isFinite()),
            "file_id": Schema.String
          }),
          Schema.Struct({
            "type": Schema.Literal("web_search_result_location"),
            "cited_text": Schema.String,
            "encrypted_index": Schema.String,
            "title": Schema.String,
            "url": Schema.String
          }),
          Schema.Struct({
            "type": Schema.Literal("search_result_location"),
            "cited_text": Schema.String,
            "search_result_index": Schema.Number.check(Schema.isFinite()),
            "source": Schema.String,
            "title": Schema.String,
            "start_block_index": Schema.Number.check(Schema.isFinite()),
            "end_block_index": Schema.Number.check(Schema.isFinite())
          })
        ], { mode: "oneOf" }))
      }),
      Schema.Struct({
        "type": Schema.Literal("tool_use"),
        "id": Schema.String,
        "name": Schema.String,
        "input": Schema.optionalKey(Schema.Unknown)
      }),
      Schema.Struct({ "type": Schema.Literal("thinking"), "thinking": Schema.String, "signature": Schema.String }),
      Schema.Struct({ "type": Schema.Literal("redacted_thinking"), "data": Schema.String }),
      Schema.Struct({
        "type": Schema.Literal("server_tool_use"),
        "id": Schema.String,
        "name": Schema.Literal("web_search"),
        "input": Schema.optionalKey(Schema.Unknown)
      }),
      Schema.Struct({
        "type": Schema.Literal("web_search_tool_result"),
        "tool_use_id": Schema.String,
        "content": Schema.Union([
          Schema.Array(
            Schema.Struct({
              "type": Schema.Literal("web_search_result"),
              "encrypted_content": Schema.String,
              "page_age": Schema.String,
              "title": Schema.String,
              "url": Schema.String
            })
          ),
          Schema.Struct({
            "type": Schema.Literal("web_search_tool_result_error"),
            "error_code": Schema.Literals([
              "invalid_tool_input",
              "unavailable",
              "max_uses_exceeded",
              "too_many_requests",
              "query_too_long"
            ])
          })
        ])
      })
    ], { mode: "oneOf" })
  }),
  Schema.Struct({
    "type": Schema.Literal("content_block_delta"),
    "index": Schema.Number.check(Schema.isFinite()),
    "delta": Schema.Union([
      Schema.Struct({ "type": Schema.Literal("text_delta"), "text": Schema.String }),
      Schema.Struct({ "type": Schema.Literal("input_json_delta"), "partial_json": Schema.String }),
      Schema.Struct({ "type": Schema.Literal("thinking_delta"), "thinking": Schema.String }),
      Schema.Struct({ "type": Schema.Literal("signature_delta"), "signature": Schema.String }),
      Schema.Struct({
        "type": Schema.Literal("citations_delta"),
        "citation": Schema.Union([
          Schema.Struct({
            "type": Schema.Literal("char_location"),
            "cited_text": Schema.String,
            "document_index": Schema.Number.check(Schema.isFinite()),
            "document_title": Schema.String,
            "start_char_index": Schema.Number.check(Schema.isFinite()),
            "end_char_index": Schema.Number.check(Schema.isFinite()),
            "file_id": Schema.String
          }),
          Schema.Struct({
            "type": Schema.Literal("page_location"),
            "cited_text": Schema.String,
            "document_index": Schema.Number.check(Schema.isFinite()),
            "document_title": Schema.String,
            "start_page_number": Schema.Number.check(Schema.isFinite()),
            "end_page_number": Schema.Number.check(Schema.isFinite()),
            "file_id": Schema.String
          }),
          Schema.Struct({
            "type": Schema.Literal("content_block_location"),
            "cited_text": Schema.String,
            "document_index": Schema.Number.check(Schema.isFinite()),
            "document_title": Schema.String,
            "start_block_index": Schema.Number.check(Schema.isFinite()),
            "end_block_index": Schema.Number.check(Schema.isFinite()),
            "file_id": Schema.String
          }),
          Schema.Struct({
            "type": Schema.Literal("web_search_result_location"),
            "cited_text": Schema.String,
            "encrypted_index": Schema.String,
            "title": Schema.String,
            "url": Schema.String
          }),
          Schema.Struct({
            "type": Schema.Literal("search_result_location"),
            "cited_text": Schema.String,
            "search_result_index": Schema.Number.check(Schema.isFinite()),
            "source": Schema.String,
            "title": Schema.String,
            "start_block_index": Schema.Number.check(Schema.isFinite()),
            "end_block_index": Schema.Number.check(Schema.isFinite())
          })
        ], { mode: "oneOf" })
      })
    ], { mode: "oneOf" })
  }),
  Schema.Struct({ "type": Schema.Literal("content_block_stop"), "index": Schema.Number.check(Schema.isFinite()) }),
  Schema.Struct({ "type": Schema.Literal("ping") }),
  Schema.Struct({
    "type": Schema.Literal("error"),
    "error": Schema.Struct({ "type": Schema.String, "message": Schema.String })
  })
], { mode: "oneOf" }).annotate({ "description": "Union of all possible streaming events" })
export type OpenRouterAnthropicMessageParam = {
  readonly "role": "user" | "assistant"
  readonly "content":
    | string
    | ReadonlyArray<
      | {
        readonly "type": "text"
        readonly "text": string
        readonly "citations"?: ReadonlyArray<
          {
            readonly "type": "char_location"
            readonly "cited_text": string
            readonly "document_index": number
            readonly "document_title": string
            readonly "start_char_index": number
            readonly "end_char_index": number
          } | {
            readonly "type": "page_location"
            readonly "cited_text": string
            readonly "document_index": number
            readonly "document_title": string
            readonly "start_page_number": number
            readonly "end_page_number": number
          } | {
            readonly "type": "content_block_location"
            readonly "cited_text": string
            readonly "document_index": number
            readonly "document_title": string
            readonly "start_block_index": number
            readonly "end_block_index": number
          } | {
            readonly "type": "web_search_result_location"
            readonly "cited_text": string
            readonly "encrypted_index": string
            readonly "title": string
            readonly "url": string
          } | {
            readonly "type": "search_result_location"
            readonly "cited_text": string
            readonly "search_result_index": number
            readonly "source": string
            readonly "title": string
            readonly "start_block_index": number
            readonly "end_block_index": number
          }
        >
        readonly "cache_control"?: { readonly "type": "ephemeral"; readonly "ttl"?: "5m" | "1h" }
      }
      | {
        readonly "type": "image"
        readonly "source": {
          readonly "type": "base64"
          readonly "media_type": "image/jpeg" | "image/png" | "image/gif" | "image/webp"
          readonly "data": string
        } | { readonly "type": "url"; readonly "url": string }
        readonly "cache_control"?: { readonly "type": "ephemeral"; readonly "ttl"?: "5m" | "1h" }
      }
      | {
        readonly "type": "document"
        readonly "source":
          | { readonly "type": "base64"; readonly "media_type": "application/pdf"; readonly "data": string }
          | { readonly "type": "text"; readonly "media_type": "text/plain"; readonly "data": string }
          | {
            readonly "type": "content"
            readonly "content":
              | string
              | ReadonlyArray<
                {
                  readonly "type": "text"
                  readonly "text": string
                  readonly "citations"?: ReadonlyArray<
                    {
                      readonly "type": "char_location"
                      readonly "cited_text": string
                      readonly "document_index": number
                      readonly "document_title": string
                      readonly "start_char_index": number
                      readonly "end_char_index": number
                    } | {
                      readonly "type": "page_location"
                      readonly "cited_text": string
                      readonly "document_index": number
                      readonly "document_title": string
                      readonly "start_page_number": number
                      readonly "end_page_number": number
                    } | {
                      readonly "type": "content_block_location"
                      readonly "cited_text": string
                      readonly "document_index": number
                      readonly "document_title": string
                      readonly "start_block_index": number
                      readonly "end_block_index": number
                    } | {
                      readonly "type": "web_search_result_location"
                      readonly "cited_text": string
                      readonly "encrypted_index": string
                      readonly "title": string
                      readonly "url": string
                    } | {
                      readonly "type": "search_result_location"
                      readonly "cited_text": string
                      readonly "search_result_index": number
                      readonly "source": string
                      readonly "title": string
                      readonly "start_block_index": number
                      readonly "end_block_index": number
                    }
                  >
                  readonly "cache_control"?: { readonly "type": "ephemeral"; readonly "ttl"?: "5m" | "1h" }
                } | {
                  readonly "type": "image"
                  readonly "source": {
                    readonly "type": "base64"
                    readonly "media_type": "image/jpeg" | "image/png" | "image/gif" | "image/webp"
                    readonly "data": string
                  } | { readonly "type": "url"; readonly "url": string }
                  readonly "cache_control"?: { readonly "type": "ephemeral"; readonly "ttl"?: "5m" | "1h" }
                }
              >
          }
          | { readonly "type": "url"; readonly "url": string }
        readonly "citations"?: { readonly "enabled"?: boolean }
        readonly "context"?: string
        readonly "title"?: string
        readonly "cache_control"?: { readonly "type": "ephemeral"; readonly "ttl"?: "5m" | "1h" }
      }
      | {
        readonly "type": "tool_use"
        readonly "id": string
        readonly "name": string
        readonly "input"?: unknown
        readonly "cache_control"?: { readonly "type": "ephemeral"; readonly "ttl"?: "5m" | "1h" }
      }
      | {
        readonly "type": "tool_result"
        readonly "tool_use_id": string
        readonly "content"?:
          | string
          | ReadonlyArray<
            {
              readonly "type": "text"
              readonly "text": string
              readonly "citations"?: ReadonlyArray<
                {
                  readonly "type": "char_location"
                  readonly "cited_text": string
                  readonly "document_index": number
                  readonly "document_title": string
                  readonly "start_char_index": number
                  readonly "end_char_index": number
                } | {
                  readonly "type": "page_location"
                  readonly "cited_text": string
                  readonly "document_index": number
                  readonly "document_title": string
                  readonly "start_page_number": number
                  readonly "end_page_number": number
                } | {
                  readonly "type": "content_block_location"
                  readonly "cited_text": string
                  readonly "document_index": number
                  readonly "document_title": string
                  readonly "start_block_index": number
                  readonly "end_block_index": number
                } | {
                  readonly "type": "web_search_result_location"
                  readonly "cited_text": string
                  readonly "encrypted_index": string
                  readonly "title": string
                  readonly "url": string
                } | {
                  readonly "type": "search_result_location"
                  readonly "cited_text": string
                  readonly "search_result_index": number
                  readonly "source": string
                  readonly "title": string
                  readonly "start_block_index": number
                  readonly "end_block_index": number
                }
              >
              readonly "cache_control"?: { readonly "type": "ephemeral"; readonly "ttl"?: "5m" | "1h" }
            } | {
              readonly "type": "image"
              readonly "source": {
                readonly "type": "base64"
                readonly "media_type": "image/jpeg" | "image/png" | "image/gif" | "image/webp"
                readonly "data": string
              } | { readonly "type": "url"; readonly "url": string }
              readonly "cache_control"?: { readonly "type": "ephemeral"; readonly "ttl"?: "5m" | "1h" }
            }
          >
        readonly "is_error"?: boolean
        readonly "cache_control"?: { readonly "type": "ephemeral"; readonly "ttl"?: "5m" | "1h" }
      }
      | { readonly "type": "thinking"; readonly "thinking": string; readonly "signature": string }
      | { readonly "type": "redacted_thinking"; readonly "data": string }
      | {
        readonly "type": "server_tool_use"
        readonly "id": string
        readonly "name": "web_search"
        readonly "input"?: unknown
        readonly "cache_control"?: { readonly "type": "ephemeral"; readonly "ttl"?: "5m" | "1h" }
      }
      | {
        readonly "type": "web_search_tool_result"
        readonly "tool_use_id": string
        readonly "content":
          | ReadonlyArray<
            {
              readonly "type": "web_search_result"
              readonly "encrypted_content": string
              readonly "title": string
              readonly "url": string
              readonly "page_age"?: string
            }
          >
          | {
            readonly "type": "web_search_tool_result_error"
            readonly "error_code":
              | "invalid_tool_input"
              | "unavailable"
              | "max_uses_exceeded"
              | "too_many_requests"
              | "query_too_long"
          }
        readonly "cache_control"?: { readonly "type": "ephemeral"; readonly "ttl"?: "5m" | "1h" }
      }
      | {
        readonly "type": "search_result"
        readonly "source": string
        readonly "title": string
        readonly "content": ReadonlyArray<
          {
            readonly "type": "text"
            readonly "text": string
            readonly "citations"?: ReadonlyArray<
              {
                readonly "type": "char_location"
                readonly "cited_text": string
                readonly "document_index": number
                readonly "document_title": string
                readonly "start_char_index": number
                readonly "end_char_index": number
              } | {
                readonly "type": "page_location"
                readonly "cited_text": string
                readonly "document_index": number
                readonly "document_title": string
                readonly "start_page_number": number
                readonly "end_page_number": number
              } | {
                readonly "type": "content_block_location"
                readonly "cited_text": string
                readonly "document_index": number
                readonly "document_title": string
                readonly "start_block_index": number
                readonly "end_block_index": number
              } | {
                readonly "type": "web_search_result_location"
                readonly "cited_text": string
                readonly "encrypted_index": string
                readonly "title": string
                readonly "url": string
              } | {
                readonly "type": "search_result_location"
                readonly "cited_text": string
                readonly "search_result_index": number
                readonly "source": string
                readonly "title": string
                readonly "start_block_index": number
                readonly "end_block_index": number
              }
            >
            readonly "cache_control"?: { readonly "type": "ephemeral"; readonly "ttl"?: "5m" | "1h" }
          }
        >
        readonly "citations"?: { readonly "enabled"?: boolean }
        readonly "cache_control"?: { readonly "type": "ephemeral"; readonly "ttl"?: "5m" | "1h" }
      }
    >
}
export const OpenRouterAnthropicMessageParam = Schema.Struct({
  "role": Schema.Literals(["user", "assistant"]),
  "content": Schema.Union([
    Schema.String,
    Schema.Array(Schema.Union([
      Schema.Struct({
        "type": Schema.Literal("text"),
        "text": Schema.String,
        "citations": Schema.optionalKey(Schema.Array(Schema.Union([
          Schema.Struct({
            "type": Schema.Literal("char_location"),
            "cited_text": Schema.String,
            "document_index": Schema.Number.check(Schema.isFinite()),
            "document_title": Schema.String,
            "start_char_index": Schema.Number.check(Schema.isFinite()),
            "end_char_index": Schema.Number.check(Schema.isFinite())
          }),
          Schema.Struct({
            "type": Schema.Literal("page_location"),
            "cited_text": Schema.String,
            "document_index": Schema.Number.check(Schema.isFinite()),
            "document_title": Schema.String,
            "start_page_number": Schema.Number.check(Schema.isFinite()),
            "end_page_number": Schema.Number.check(Schema.isFinite())
          }),
          Schema.Struct({
            "type": Schema.Literal("content_block_location"),
            "cited_text": Schema.String,
            "document_index": Schema.Number.check(Schema.isFinite()),
            "document_title": Schema.String,
            "start_block_index": Schema.Number.check(Schema.isFinite()),
            "end_block_index": Schema.Number.check(Schema.isFinite())
          }),
          Schema.Struct({
            "type": Schema.Literal("web_search_result_location"),
            "cited_text": Schema.String,
            "encrypted_index": Schema.String,
            "title": Schema.String,
            "url": Schema.String
          }),
          Schema.Struct({
            "type": Schema.Literal("search_result_location"),
            "cited_text": Schema.String,
            "search_result_index": Schema.Number.check(Schema.isFinite()),
            "source": Schema.String,
            "title": Schema.String,
            "start_block_index": Schema.Number.check(Schema.isFinite()),
            "end_block_index": Schema.Number.check(Schema.isFinite())
          })
        ], { mode: "oneOf" }))),
        "cache_control": Schema.optionalKey(
          Schema.Struct({
            "type": Schema.Literal("ephemeral"),
            "ttl": Schema.optionalKey(Schema.Literals(["5m", "1h"]))
          })
        )
      }),
      Schema.Struct({
        "type": Schema.Literal("image"),
        "source": Schema.Union([
          Schema.Struct({
            "type": Schema.Literal("base64"),
            "media_type": Schema.Literals(["image/jpeg", "image/png", "image/gif", "image/webp"]),
            "data": Schema.String
          }),
          Schema.Struct({ "type": Schema.Literal("url"), "url": Schema.String })
        ], { mode: "oneOf" }),
        "cache_control": Schema.optionalKey(
          Schema.Struct({
            "type": Schema.Literal("ephemeral"),
            "ttl": Schema.optionalKey(Schema.Literals(["5m", "1h"]))
          })
        )
      }),
      Schema.Struct({
        "type": Schema.Literal("document"),
        "source": Schema.Union([
          Schema.Struct({
            "type": Schema.Literal("base64"),
            "media_type": Schema.Literal("application/pdf"),
            "data": Schema.String
          }),
          Schema.Struct({
            "type": Schema.Literal("text"),
            "media_type": Schema.Literal("text/plain"),
            "data": Schema.String
          }),
          Schema.Struct({
            "type": Schema.Literal("content"),
            "content": Schema.Union([
              Schema.String,
              Schema.Array(Schema.Union([
                Schema.Struct({
                  "type": Schema.Literal("text"),
                  "text": Schema.String,
                  "citations": Schema.optionalKey(Schema.Array(Schema.Union([
                    Schema.Struct({
                      "type": Schema.Literal("char_location"),
                      "cited_text": Schema.String,
                      "document_index": Schema.Number.check(Schema.isFinite()),
                      "document_title": Schema.String,
                      "start_char_index": Schema.Number.check(Schema.isFinite()),
                      "end_char_index": Schema.Number.check(Schema.isFinite())
                    }),
                    Schema.Struct({
                      "type": Schema.Literal("page_location"),
                      "cited_text": Schema.String,
                      "document_index": Schema.Number.check(Schema.isFinite()),
                      "document_title": Schema.String,
                      "start_page_number": Schema.Number.check(Schema.isFinite()),
                      "end_page_number": Schema.Number.check(Schema.isFinite())
                    }),
                    Schema.Struct({
                      "type": Schema.Literal("content_block_location"),
                      "cited_text": Schema.String,
                      "document_index": Schema.Number.check(Schema.isFinite()),
                      "document_title": Schema.String,
                      "start_block_index": Schema.Number.check(Schema.isFinite()),
                      "end_block_index": Schema.Number.check(Schema.isFinite())
                    }),
                    Schema.Struct({
                      "type": Schema.Literal("web_search_result_location"),
                      "cited_text": Schema.String,
                      "encrypted_index": Schema.String,
                      "title": Schema.String,
                      "url": Schema.String
                    }),
                    Schema.Struct({
                      "type": Schema.Literal("search_result_location"),
                      "cited_text": Schema.String,
                      "search_result_index": Schema.Number.check(Schema.isFinite()),
                      "source": Schema.String,
                      "title": Schema.String,
                      "start_block_index": Schema.Number.check(Schema.isFinite()),
                      "end_block_index": Schema.Number.check(Schema.isFinite())
                    })
                  ], { mode: "oneOf" }))),
                  "cache_control": Schema.optionalKey(
                    Schema.Struct({
                      "type": Schema.Literal("ephemeral"),
                      "ttl": Schema.optionalKey(Schema.Literals(["5m", "1h"]))
                    })
                  )
                }),
                Schema.Struct({
                  "type": Schema.Literal("image"),
                  "source": Schema.Union([
                    Schema.Struct({
                      "type": Schema.Literal("base64"),
                      "media_type": Schema.Literals(["image/jpeg", "image/png", "image/gif", "image/webp"]),
                      "data": Schema.String
                    }),
                    Schema.Struct({ "type": Schema.Literal("url"), "url": Schema.String })
                  ], { mode: "oneOf" }),
                  "cache_control": Schema.optionalKey(
                    Schema.Struct({
                      "type": Schema.Literal("ephemeral"),
                      "ttl": Schema.optionalKey(Schema.Literals(["5m", "1h"]))
                    })
                  )
                })
              ], { mode: "oneOf" }))
            ])
          }),
          Schema.Struct({ "type": Schema.Literal("url"), "url": Schema.String })
        ], { mode: "oneOf" }),
        "citations": Schema.optionalKey(Schema.Struct({ "enabled": Schema.optionalKey(Schema.Boolean) })),
        "context": Schema.optionalKey(Schema.String),
        "title": Schema.optionalKey(Schema.String),
        "cache_control": Schema.optionalKey(
          Schema.Struct({
            "type": Schema.Literal("ephemeral"),
            "ttl": Schema.optionalKey(Schema.Literals(["5m", "1h"]))
          })
        )
      }),
      Schema.Struct({
        "type": Schema.Literal("tool_use"),
        "id": Schema.String,
        "name": Schema.String,
        "input": Schema.optionalKey(Schema.Unknown),
        "cache_control": Schema.optionalKey(
          Schema.Struct({
            "type": Schema.Literal("ephemeral"),
            "ttl": Schema.optionalKey(Schema.Literals(["5m", "1h"]))
          })
        )
      }),
      Schema.Struct({
        "type": Schema.Literal("tool_result"),
        "tool_use_id": Schema.String,
        "content": Schema.optionalKey(Schema.Union([
          Schema.String,
          Schema.Array(Schema.Union([
            Schema.Struct({
              "type": Schema.Literal("text"),
              "text": Schema.String,
              "citations": Schema.optionalKey(Schema.Array(Schema.Union([
                Schema.Struct({
                  "type": Schema.Literal("char_location"),
                  "cited_text": Schema.String,
                  "document_index": Schema.Number.check(Schema.isFinite()),
                  "document_title": Schema.String,
                  "start_char_index": Schema.Number.check(Schema.isFinite()),
                  "end_char_index": Schema.Number.check(Schema.isFinite())
                }),
                Schema.Struct({
                  "type": Schema.Literal("page_location"),
                  "cited_text": Schema.String,
                  "document_index": Schema.Number.check(Schema.isFinite()),
                  "document_title": Schema.String,
                  "start_page_number": Schema.Number.check(Schema.isFinite()),
                  "end_page_number": Schema.Number.check(Schema.isFinite())
                }),
                Schema.Struct({
                  "type": Schema.Literal("content_block_location"),
                  "cited_text": Schema.String,
                  "document_index": Schema.Number.check(Schema.isFinite()),
                  "document_title": Schema.String,
                  "start_block_index": Schema.Number.check(Schema.isFinite()),
                  "end_block_index": Schema.Number.check(Schema.isFinite())
                }),
                Schema.Struct({
                  "type": Schema.Literal("web_search_result_location"),
                  "cited_text": Schema.String,
                  "encrypted_index": Schema.String,
                  "title": Schema.String,
                  "url": Schema.String
                }),
                Schema.Struct({
                  "type": Schema.Literal("search_result_location"),
                  "cited_text": Schema.String,
                  "search_result_index": Schema.Number.check(Schema.isFinite()),
                  "source": Schema.String,
                  "title": Schema.String,
                  "start_block_index": Schema.Number.check(Schema.isFinite()),
                  "end_block_index": Schema.Number.check(Schema.isFinite())
                })
              ], { mode: "oneOf" }))),
              "cache_control": Schema.optionalKey(
                Schema.Struct({
                  "type": Schema.Literal("ephemeral"),
                  "ttl": Schema.optionalKey(Schema.Literals(["5m", "1h"]))
                })
              )
            }),
            Schema.Struct({
              "type": Schema.Literal("image"),
              "source": Schema.Union([
                Schema.Struct({
                  "type": Schema.Literal("base64"),
                  "media_type": Schema.Literals(["image/jpeg", "image/png", "image/gif", "image/webp"]),
                  "data": Schema.String
                }),
                Schema.Struct({ "type": Schema.Literal("url"), "url": Schema.String })
              ], { mode: "oneOf" }),
              "cache_control": Schema.optionalKey(
                Schema.Struct({
                  "type": Schema.Literal("ephemeral"),
                  "ttl": Schema.optionalKey(Schema.Literals(["5m", "1h"]))
                })
              )
            })
          ]))
        ])),
        "is_error": Schema.optionalKey(Schema.Boolean),
        "cache_control": Schema.optionalKey(
          Schema.Struct({
            "type": Schema.Literal("ephemeral"),
            "ttl": Schema.optionalKey(Schema.Literals(["5m", "1h"]))
          })
        )
      }),
      Schema.Struct({ "type": Schema.Literal("thinking"), "thinking": Schema.String, "signature": Schema.String }),
      Schema.Struct({ "type": Schema.Literal("redacted_thinking"), "data": Schema.String }),
      Schema.Struct({
        "type": Schema.Literal("server_tool_use"),
        "id": Schema.String,
        "name": Schema.Literal("web_search"),
        "input": Schema.optionalKey(Schema.Unknown),
        "cache_control": Schema.optionalKey(
          Schema.Struct({
            "type": Schema.Literal("ephemeral"),
            "ttl": Schema.optionalKey(Schema.Literals(["5m", "1h"]))
          })
        )
      }),
      Schema.Struct({
        "type": Schema.Literal("web_search_tool_result"),
        "tool_use_id": Schema.String,
        "content": Schema.Union([
          Schema.Array(
            Schema.Struct({
              "type": Schema.Literal("web_search_result"),
              "encrypted_content": Schema.String,
              "title": Schema.String,
              "url": Schema.String,
              "page_age": Schema.optionalKey(Schema.String)
            })
          ),
          Schema.Struct({
            "type": Schema.Literal("web_search_tool_result_error"),
            "error_code": Schema.Literals([
              "invalid_tool_input",
              "unavailable",
              "max_uses_exceeded",
              "too_many_requests",
              "query_too_long"
            ])
          })
        ]),
        "cache_control": Schema.optionalKey(
          Schema.Struct({
            "type": Schema.Literal("ephemeral"),
            "ttl": Schema.optionalKey(Schema.Literals(["5m", "1h"]))
          })
        )
      }),
      Schema.Struct({
        "type": Schema.Literal("search_result"),
        "source": Schema.String,
        "title": Schema.String,
        "content": Schema.Array(Schema.Struct({
          "type": Schema.Literal("text"),
          "text": Schema.String,
          "citations": Schema.optionalKey(Schema.Array(Schema.Union([
            Schema.Struct({
              "type": Schema.Literal("char_location"),
              "cited_text": Schema.String,
              "document_index": Schema.Number.check(Schema.isFinite()),
              "document_title": Schema.String,
              "start_char_index": Schema.Number.check(Schema.isFinite()),
              "end_char_index": Schema.Number.check(Schema.isFinite())
            }),
            Schema.Struct({
              "type": Schema.Literal("page_location"),
              "cited_text": Schema.String,
              "document_index": Schema.Number.check(Schema.isFinite()),
              "document_title": Schema.String,
              "start_page_number": Schema.Number.check(Schema.isFinite()),
              "end_page_number": Schema.Number.check(Schema.isFinite())
            }),
            Schema.Struct({
              "type": Schema.Literal("content_block_location"),
              "cited_text": Schema.String,
              "document_index": Schema.Number.check(Schema.isFinite()),
              "document_title": Schema.String,
              "start_block_index": Schema.Number.check(Schema.isFinite()),
              "end_block_index": Schema.Number.check(Schema.isFinite())
            }),
            Schema.Struct({
              "type": Schema.Literal("web_search_result_location"),
              "cited_text": Schema.String,
              "encrypted_index": Schema.String,
              "title": Schema.String,
              "url": Schema.String
            }),
            Schema.Struct({
              "type": Schema.Literal("search_result_location"),
              "cited_text": Schema.String,
              "search_result_index": Schema.Number.check(Schema.isFinite()),
              "source": Schema.String,
              "title": Schema.String,
              "start_block_index": Schema.Number.check(Schema.isFinite()),
              "end_block_index": Schema.Number.check(Schema.isFinite())
            })
          ], { mode: "oneOf" }))),
          "cache_control": Schema.optionalKey(
            Schema.Struct({
              "type": Schema.Literal("ephemeral"),
              "ttl": Schema.optionalKey(Schema.Literals(["5m", "1h"]))
            })
          )
        })),
        "citations": Schema.optionalKey(Schema.Struct({ "enabled": Schema.optionalKey(Schema.Boolean) })),
        "cache_control": Schema.optionalKey(
          Schema.Struct({
            "type": Schema.Literal("ephemeral"),
            "ttl": Schema.optionalKey(Schema.Literals(["5m", "1h"]))
          })
        )
      })
    ], { mode: "oneOf" }))
  ])
}).annotate({ "description": "Anthropic message with OpenRouter extensions" })
export type AnthropicOutputConfig = { readonly "effort"?: "low" | "medium" | "high" | "max" }
export const AnthropicOutputConfig = Schema.Struct({
  "effort": Schema.optionalKey(
    Schema.Literals(["low", "medium", "high", "max"]).annotate({
      "description":
        "How much effort the model should put into its response. Higher effort levels may result in more thorough analysis but take longer. Valid values are `low`, `medium`, `high`, or `max`."
    })
  )
}).annotate({
  "description":
    "Configuration for controlling output behavior. Currently supports the effort parameter for Claude Opus 4.5."
})
export type ActivityItem = {
  readonly "date": string
  readonly "model": string
  readonly "model_permaslug": string
  readonly "endpoint_id": string
  readonly "provider_name": string
  readonly "usage": number
  readonly "byok_usage_inference": number
  readonly "requests": number
  readonly "prompt_tokens": number
  readonly "completion_tokens": number
  readonly "reasoning_tokens": number
}
export const ActivityItem = Schema.Struct({
  "date": Schema.String.annotate({ "description": "Date of the activity (YYYY-MM-DD format)" }),
  "model": Schema.String.annotate({ "description": "Model slug (e.g., \"openai/gpt-4.1\")" }),
  "model_permaslug": Schema.String.annotate({ "description": "Model permaslug (e.g., \"openai/gpt-4.1-2025-04-14\")" }),
  "endpoint_id": Schema.String.annotate({ "description": "Unique identifier for the endpoint" }),
  "provider_name": Schema.String.annotate({ "description": "Name of the provider serving this endpoint" }),
  "usage": Schema.Number.annotate({ "description": "Total cost in USD (OpenRouter credits spent)" }).check(
    Schema.isFinite()
  ),
  "byok_usage_inference": Schema.Number.annotate({
    "description": "BYOK inference cost in USD (external credits spent)"
  }).check(Schema.isFinite()),
  "requests": Schema.Number.annotate({ "description": "Number of requests made" }).check(Schema.isFinite()),
  "prompt_tokens": Schema.Number.annotate({ "description": "Total prompt tokens used" }).check(Schema.isFinite()),
  "completion_tokens": Schema.Number.annotate({ "description": "Total completion tokens generated" }).check(
    Schema.isFinite()
  ),
  "reasoning_tokens": Schema.Number.annotate({ "description": "Total reasoning tokens used" }).check(Schema.isFinite())
})
export type ForbiddenResponseErrorData = {
  readonly "code": number
  readonly "message": string
  readonly "metadata"?: {}
}
export const ForbiddenResponseErrorData = Schema.Struct({
  "code": Schema.Number.check(Schema.isInt()),
  "message": Schema.String,
  "metadata": Schema.optionalKey(Schema.Struct({}))
}).annotate({ "description": "Error data for ForbiddenResponse" })
export type CreateChargeRequest = {
  readonly "amount": number
  readonly "sender": string
  readonly "chain_id": 1 | 137 | 8453
}
export const CreateChargeRequest = Schema.Struct({
  "amount": Schema.Number.check(Schema.isFinite()),
  "sender": Schema.String,
  "chain_id": Schema.Literals([1, 137, 8453])
}).annotate({ "description": "Create a Coinbase charge for crypto payment" })
export type PublicPricing = {
  readonly "prompt": string
  readonly "completion": string
  readonly "request"?: string
  readonly "image"?: string
  readonly "image_token"?: string
  readonly "image_output"?: string
  readonly "audio"?: string
  readonly "audio_output"?: string
  readonly "input_audio_cache"?: string
  readonly "web_search"?: string
  readonly "internal_reasoning"?: string
  readonly "input_cache_read"?: string
  readonly "input_cache_write"?: string
  readonly "discount"?: number
}
export const PublicPricing = Schema.Struct({
  "prompt": Schema.String.annotate({ "description": "A number or string value representing a large number" }),
  "completion": Schema.String.annotate({ "description": "A number or string value representing a large number" }),
  "request": Schema.optionalKey(
    Schema.String.annotate({ "description": "A number or string value representing a large number" })
  ),
  "image": Schema.optionalKey(
    Schema.String.annotate({ "description": "A number or string value representing a large number" })
  ),
  "image_token": Schema.optionalKey(
    Schema.String.annotate({ "description": "A number or string value representing a large number" })
  ),
  "image_output": Schema.optionalKey(
    Schema.String.annotate({ "description": "A number or string value representing a large number" })
  ),
  "audio": Schema.optionalKey(
    Schema.String.annotate({ "description": "A number or string value representing a large number" })
  ),
  "audio_output": Schema.optionalKey(
    Schema.String.annotate({ "description": "A number or string value representing a large number" })
  ),
  "input_audio_cache": Schema.optionalKey(
    Schema.String.annotate({ "description": "A number or string value representing a large number" })
  ),
  "web_search": Schema.optionalKey(
    Schema.String.annotate({ "description": "A number or string value representing a large number" })
  ),
  "internal_reasoning": Schema.optionalKey(
    Schema.String.annotate({ "description": "A number or string value representing a large number" })
  ),
  "input_cache_read": Schema.optionalKey(
    Schema.String.annotate({ "description": "A number or string value representing a large number" })
  ),
  "input_cache_write": Schema.optionalKey(
    Schema.String.annotate({ "description": "A number or string value representing a large number" })
  ),
  "discount": Schema.optionalKey(Schema.Number.check(Schema.isFinite()))
}).annotate({ "description": "Pricing information for the model" })
export type ModelGroup =
  | "Router"
  | "Media"
  | "Other"
  | "GPT"
  | "Claude"
  | "Gemini"
  | "Grok"
  | "Cohere"
  | "Nova"
  | "Qwen"
  | "Yi"
  | "DeepSeek"
  | "Mistral"
  | "Llama2"
  | "Llama3"
  | "Llama4"
  | "PaLM"
  | "RWKV"
  | "Qwen3"
export const ModelGroup = Schema.Literals([
  "Router",
  "Media",
  "Other",
  "GPT",
  "Claude",
  "Gemini",
  "Grok",
  "Cohere",
  "Nova",
  "Qwen",
  "Yi",
  "DeepSeek",
  "Mistral",
  "Llama2",
  "Llama3",
  "Llama4",
  "PaLM",
  "RWKV",
  "Qwen3"
]).annotate({ "description": "Tokenizer type used by the model" })
export type InputModality = "text" | "image" | "file" | "audio" | "video"
export const InputModality = Schema.Literals(["text", "image", "file", "audio", "video"])
export type OutputModality = "text" | "image" | "embeddings" | "audio"
export const OutputModality = Schema.Literals(["text", "image", "embeddings", "audio"])
export type TopProviderInfo = {
  readonly "context_length"?: number
  readonly "max_completion_tokens"?: number
  readonly "is_moderated": boolean
}
export const TopProviderInfo = Schema.Struct({
  "context_length": Schema.optionalKey(
    Schema.Number.annotate({ "description": "Context length from the top provider" }).check(Schema.isFinite())
  ),
  "max_completion_tokens": Schema.optionalKey(
    Schema.Number.annotate({ "description": "Maximum completion tokens from the top provider" }).check(
      Schema.isFinite()
    )
  ),
  "is_moderated": Schema.Boolean.annotate({ "description": "Whether the top provider moderates content" })
}).annotate({ "description": "Information about the top provider for this model" })
export type PerRequestLimits = { readonly "prompt_tokens": number; readonly "completion_tokens": number }
export const PerRequestLimits = Schema.Struct({
  "prompt_tokens": Schema.Number.annotate({ "description": "Maximum prompt tokens per request" }).check(
    Schema.isFinite()
  ),
  "completion_tokens": Schema.Number.annotate({ "description": "Maximum completion tokens per request" }).check(
    Schema.isFinite()
  )
}).annotate({ "description": "Per-request token limits" })
export type Parameter =
  | "temperature"
  | "top_p"
  | "top_k"
  | "min_p"
  | "top_a"
  | "frequency_penalty"
  | "presence_penalty"
  | "repetition_penalty"
  | "max_tokens"
  | "logit_bias"
  | "logprobs"
  | "top_logprobs"
  | "seed"
  | "response_format"
  | "structured_outputs"
  | "stop"
  | "tools"
  | "tool_choice"
  | "parallel_tool_calls"
  | "include_reasoning"
  | "reasoning"
  | "reasoning_effort"
  | "web_search_options"
  | "verbosity"
export const Parameter = Schema.Literals([
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "top_a",
  "frequency_penalty",
  "presence_penalty",
  "repetition_penalty",
  "max_tokens",
  "logit_bias",
  "logprobs",
  "top_logprobs",
  "seed",
  "response_format",
  "structured_outputs",
  "stop",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "include_reasoning",
  "reasoning",
  "reasoning_effort",
  "web_search_options",
  "verbosity"
])
export type DefaultParameters = {
  readonly "temperature"?: number
  readonly "top_p"?: number
  readonly "frequency_penalty"?: number
}
export const DefaultParameters = Schema.Struct({
  "temperature": Schema.optionalKey(
    Schema.Number.check(Schema.isFinite()).check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(2))
  ),
  "top_p": Schema.optionalKey(
    Schema.Number.check(Schema.isFinite()).check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(1))
  ),
  "frequency_penalty": Schema.optionalKey(
    Schema.Number.check(Schema.isFinite()).check(Schema.isGreaterThanOrEqualTo(-2)).check(Schema.isLessThanOrEqualTo(2))
  )
}).annotate({ "description": "Default parameters for this model" })
export type ModelsCountResponse = { readonly "data": { readonly "count": number } }
export const ModelsCountResponse = Schema.Struct({
  "data": Schema.Struct({
    "count": Schema.Number.annotate({ "description": "Total number of available models" }).check(Schema.isFinite())
  }).annotate({ "description": "Model count data" })
}).annotate({ "description": "Model count data" })
export type EndpointStatus = 0 | -1 | -2 | -3 | -5 | -10
export const EndpointStatus = Schema.Literals([0, -1, -2, -3, -5, -10])
export type PercentileStats = {
  readonly "p50": number
  readonly "p75": number
  readonly "p90": number
  readonly "p99": number
}
export const PercentileStats = Schema.Struct({
  "p50": Schema.Number.annotate({ "description": "Median (50th percentile)" }).check(Schema.isFinite()),
  "p75": Schema.Number.annotate({ "description": "75th percentile" }).check(Schema.isFinite()),
  "p90": Schema.Number.annotate({ "description": "90th percentile" }).check(Schema.isFinite()),
  "p99": Schema.Number.annotate({ "description": "99th percentile" }).check(Schema.isFinite())
}).annotate({
  "description":
    "Latency percentiles in milliseconds over the last 30 minutes. Latency measures time to first token. Only visible when authenticated with an API key or cookie; returns null for unauthenticated requests."
})
export type __schema5 = ReadonlyArray<
  | "AI21"
  | "AionLabs"
  | "Alibaba"
  | "Ambient"
  | "Amazon Bedrock"
  | "Amazon Nova"
  | "Anthropic"
  | "Arcee AI"
  | "AtlasCloud"
  | "Avian"
  | "Azure"
  | "BaseTen"
  | "BytePlus"
  | "Black Forest Labs"
  | "Cerebras"
  | "Chutes"
  | "Cirrascale"
  | "Clarifai"
  | "Cloudflare"
  | "Cohere"
  | "Crusoe"
  | "DeepInfra"
  | "DeepSeek"
  | "Featherless"
  | "Fireworks"
  | "Friendli"
  | "GMICloud"
  | "Google"
  | "Google AI Studio"
  | "Groq"
  | "Hyperbolic"
  | "Inception"
  | "Inceptron"
  | "InferenceNet"
  | "Infermatic"
  | "Io Net"
  | "Inflection"
  | "Liquid"
  | "Mara"
  | "Mancer 2"
  | "Minimax"
  | "ModelRun"
  | "Mistral"
  | "Modular"
  | "Moonshot AI"
  | "Morph"
  | "NCompass"
  | "Nebius"
  | "NextBit"
  | "Novita"
  | "Nvidia"
  | "OpenAI"
  | "OpenInference"
  | "Parasail"
  | "Perplexity"
  | "Phala"
  | "Relace"
  | "SambaNova"
  | "Seed"
  | "SiliconFlow"
  | "Sourceful"
  | "StepFun"
  | "Stealth"
  | "StreamLake"
  | "Switchpoint"
  | "Together"
  | "Upstage"
  | "Venice"
  | "WandB"
  | "Xiaomi"
  | "xAI"
  | "Z.AI"
  | "FakeProvider"
  | string
>
export const __schema5 = Schema.Array(
  Schema.Union([
    Schema.Literals([
      "AI21",
      "AionLabs",
      "Alibaba",
      "Ambient",
      "Amazon Bedrock",
      "Amazon Nova",
      "Anthropic",
      "Arcee AI",
      "AtlasCloud",
      "Avian",
      "Azure",
      "BaseTen",
      "BytePlus",
      "Black Forest Labs",
      "Cerebras",
      "Chutes",
      "Cirrascale",
      "Clarifai",
      "Cloudflare",
      "Cohere",
      "Crusoe",
      "DeepInfra",
      "DeepSeek",
      "Featherless",
      "Fireworks",
      "Friendli",
      "GMICloud",
      "Google",
      "Google AI Studio",
      "Groq",
      "Hyperbolic",
      "Inception",
      "Inceptron",
      "InferenceNet",
      "Infermatic",
      "Io Net",
      "Inflection",
      "Liquid",
      "Mara",
      "Mancer 2",
      "Minimax",
      "ModelRun",
      "Mistral",
      "Modular",
      "Moonshot AI",
      "Morph",
      "NCompass",
      "Nebius",
      "NextBit",
      "Novita",
      "Nvidia",
      "OpenAI",
      "OpenInference",
      "Parasail",
      "Perplexity",
      "Phala",
      "Relace",
      "SambaNova",
      "Seed",
      "SiliconFlow",
      "Sourceful",
      "StepFun",
      "Stealth",
      "StreamLake",
      "Switchpoint",
      "Together",
      "Upstage",
      "Venice",
      "WandB",
      "Xiaomi",
      "xAI",
      "Z.AI",
      "FakeProvider"
    ]),
    Schema.String
  ])
)
export type __schema11 = number
export const __schema11 = Schema.Number.check(Schema.isFinite())
export type __schema13 = unknown
export const __schema13 = Schema.Unknown
export type __schema21 = string | null
export const __schema21 = Schema.Union([Schema.String, Schema.Null])
export type __schema22 =
  | "unknown"
  | "openai-responses-v1"
  | "azure-openai-responses-v1"
  | "xai-responses-v1"
  | "anthropic-claude-v1"
  | "google-gemini-v1"
  | null
export const __schema22 = Schema.Union([
  Schema.Literals([
    "unknown",
    "openai-responses-v1",
    "azure-openai-responses-v1",
    "xai-responses-v1",
    "anthropic-claude-v1",
    "google-gemini-v1"
  ]),
  Schema.Null
])
export type ModelName = string
export const ModelName = Schema.String
export type ChatMessageContentItemImage = {
  readonly "type": "image_url"
  readonly "image_url": { readonly "url": string; readonly "detail"?: "auto" | "low" | "high" }
}
export const ChatMessageContentItemImage = Schema.Struct({
  "type": Schema.Literal("image_url"),
  "image_url": Schema.Struct({
    "url": Schema.String,
    "detail": Schema.optionalKey(Schema.Literals(["auto", "low", "high"]))
  })
})
export type ChatMessageContentItemAudio = {
  readonly "type": "input_audio"
  readonly "input_audio": { readonly "data": string; readonly "format": string }
}
export const ChatMessageContentItemAudio = Schema.Struct({
  "type": Schema.Literal("input_audio"),
  "input_audio": Schema.Struct({ "data": Schema.String, "format": Schema.String })
})
export type ChatMessageContentItemVideo = {
  readonly "type": "input_video"
  readonly "video_url": { readonly "url": string }
} | { readonly "type": "video_url"; readonly "video_url": { readonly "url": string } }
export const ChatMessageContentItemVideo = Schema.Union([
  Schema.Struct({ "type": Schema.Literal("input_video"), "video_url": Schema.Struct({ "url": Schema.String }) }),
  Schema.Struct({ "type": Schema.Literal("video_url"), "video_url": Schema.Struct({ "url": Schema.String }) })
], { mode: "oneOf" })
export type ChatMessageToolCall = {
  readonly "id": string
  readonly "type": "function"
  readonly "function": { readonly "name": string; readonly "arguments": string }
}
export const ChatMessageToolCall = Schema.Struct({
  "id": Schema.String,
  "type": Schema.Literal("function"),
  "function": Schema.Struct({ "name": Schema.String, "arguments": Schema.String })
})
export type ChatMessageTokenLogprob = {
  readonly "token": string
  readonly "logprob": number
  readonly "bytes": ReadonlyArray<number> | null
  readonly "top_logprobs": ReadonlyArray<
    { readonly "token": string; readonly "logprob": number; readonly "bytes": ReadonlyArray<number> | null }
  >
}
export const ChatMessageTokenLogprob = Schema.Struct({
  "token": Schema.String,
  "logprob": Schema.Number.check(Schema.isFinite()),
  "bytes": Schema.Union([Schema.Array(Schema.Number.check(Schema.isFinite())), Schema.Null]),
  "top_logprobs": Schema.Array(
    Schema.Struct({
      "token": Schema.String,
      "logprob": Schema.Number.check(Schema.isFinite()),
      "bytes": Schema.Union([Schema.Array(Schema.Number.check(Schema.isFinite())), Schema.Null])
    })
  )
})
export type ChatGenerationTokenUsage = {
  readonly "completion_tokens": number
  readonly "prompt_tokens": number
  readonly "total_tokens": number
  readonly "completion_tokens_details"?: {
    readonly "reasoning_tokens"?: number | null
    readonly "audio_tokens"?: number | null
    readonly "accepted_prediction_tokens"?: number | null
    readonly "rejected_prediction_tokens"?: number | null
  } | null
  readonly "prompt_tokens_details"?: {
    readonly "cached_tokens"?: number
    readonly "cache_write_tokens"?: number
    readonly "audio_tokens"?: number
    readonly "video_tokens"?: number
  } | null
}
export const ChatGenerationTokenUsage = Schema.Struct({
  "completion_tokens": Schema.Number.check(Schema.isFinite()),
  "prompt_tokens": Schema.Number.check(Schema.isFinite()),
  "total_tokens": Schema.Number.check(Schema.isFinite()),
  "completion_tokens_details": Schema.optionalKey(Schema.Union([
    Schema.Struct({
      "reasoning_tokens": Schema.optionalKey(Schema.Union([Schema.Number.check(Schema.isFinite()), Schema.Null])),
      "audio_tokens": Schema.optionalKey(Schema.Union([Schema.Number.check(Schema.isFinite()), Schema.Null])),
      "accepted_prediction_tokens": Schema.optionalKey(
        Schema.Union([Schema.Number.check(Schema.isFinite()), Schema.Null])
      ),
      "rejected_prediction_tokens": Schema.optionalKey(
        Schema.Union([Schema.Number.check(Schema.isFinite()), Schema.Null])
      )
    }),
    Schema.Null
  ])),
  "prompt_tokens_details": Schema.optionalKey(Schema.Union([
    Schema.Struct({
      "cached_tokens": Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
      "cache_write_tokens": Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
      "audio_tokens": Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
      "video_tokens": Schema.optionalKey(Schema.Number.check(Schema.isFinite()))
    }),
    Schema.Null
  ]))
})
export type ChatCompletionFinishReason = "tool_calls" | "stop" | "length" | "content_filter" | "error"
export const ChatCompletionFinishReason = Schema.Literals(["tool_calls", "stop", "length", "content_filter", "error"])
export type JSONSchemaConfig = {
  readonly "name": string
  readonly "description"?: string
  readonly "schema"?: {}
  readonly "strict"?: boolean | null
}
export const JSONSchemaConfig = Schema.Struct({
  "name": Schema.String.check(Schema.isMaxLength(64)),
  "description": Schema.optionalKey(Schema.String),
  "schema": Schema.optionalKey(Schema.Struct({}).check(Schema.isPropertyNames(Schema.String))),
  "strict": Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null]))
})
export type ResponseFormatTextGrammar = { readonly "type": "grammar"; readonly "grammar": string }
export const ResponseFormatTextGrammar = Schema.Struct({ "type": Schema.Literal("grammar"), "grammar": Schema.String })
export type ChatMessageContentItemCacheControl = { readonly "type": "ephemeral"; readonly "ttl"?: "5m" | "1h" }
export const ChatMessageContentItemCacheControl = Schema.Struct({
  "type": Schema.Literal("ephemeral"),
  "ttl": Schema.optionalKey(Schema.Literals(["5m", "1h"]))
})
export type NamedToolChoice = { readonly "type": "function"; readonly "function": { readonly "name": string } }
export const NamedToolChoice = Schema.Struct({
  "type": Schema.Literal("function"),
  "function": Schema.Struct({ "name": Schema.String })
})
export type ChatStreamOptions = { readonly "include_usage"?: boolean }
export const ChatStreamOptions = Schema.Struct({ "include_usage": Schema.optionalKey(Schema.Boolean) })
export type ChatStreamingMessageToolCall = {
  readonly "index": number
  readonly "id"?: string | null
  readonly "type"?: "function" | null
  readonly "function"?: { readonly "name"?: string | null; readonly "arguments"?: string }
}
export const ChatStreamingMessageToolCall = Schema.Struct({
  "index": Schema.Number.check(Schema.isFinite()),
  "id": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  "type": Schema.optionalKey(Schema.Union([Schema.Literal("function"), Schema.Null])),
  "function": Schema.optionalKey(
    Schema.Struct({
      "name": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
      "arguments": Schema.optionalKey(Schema.String)
    })
  )
})
export type ChatError = {
  readonly "error": {
    readonly "code": string | number | null
    readonly "message": string
    readonly "param"?: string | null
    readonly "type"?: string | null
  }
}
export const ChatError = Schema.Struct({
  "error": Schema.Struct({
    "code": Schema.Union([Schema.Union([Schema.String, Schema.Number.check(Schema.isFinite())]), Schema.Null]),
    "message": Schema.String,
    "param": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
    "type": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]))
  })
})
export type OpenAIResponsesAnnotation = FileCitation | URLCitation | FilePath
export const OpenAIResponsesAnnotation = Schema.Union([FileCitation, URLCitation, FilePath])
export type OutputItemReasoning = {
  readonly "type": "reasoning"
  readonly "id": string
  readonly "content"?: ReadonlyArray<ReasoningTextContent>
  readonly "summary": ReadonlyArray<ReasoningSummaryText>
  readonly "encrypted_content"?: string
  readonly "status"?: "completed" | "incomplete" | "in_progress"
}
export const OutputItemReasoning = Schema.Struct({
  "type": Schema.Literal("reasoning"),
  "id": Schema.String,
  "content": Schema.optionalKey(Schema.Array(ReasoningTextContent)),
  "summary": Schema.Array(ReasoningSummaryText),
  "encrypted_content": Schema.optionalKey(Schema.String),
  "status": Schema.optionalKey(Schema.Literals(["completed", "incomplete", "in_progress"]))
})
export type ResponsesOutputItemReasoning = {
  readonly "type": "reasoning"
  readonly "id": string
  readonly "content"?: ReadonlyArray<ReasoningTextContent>
  readonly "summary": ReadonlyArray<ReasoningSummaryText>
  readonly "encrypted_content"?: string
  readonly "status"?: "completed" | "incomplete" | "in_progress"
  readonly "signature"?: string
  readonly "format"?:
    | "unknown"
    | "openai-responses-v1"
    | "azure-openai-responses-v1"
    | "xai-responses-v1"
    | "anthropic-claude-v1"
    | "google-gemini-v1"
}
export const ResponsesOutputItemReasoning = Schema.Struct({
  "type": Schema.Literal("reasoning"),
  "id": Schema.String,
  "content": Schema.optionalKey(Schema.Array(ReasoningTextContent)),
  "summary": Schema.Array(ReasoningSummaryText),
  "encrypted_content": Schema.optionalKey(Schema.String),
  "status": Schema.optionalKey(Schema.Literals(["completed", "incomplete", "in_progress"])),
  "signature": Schema.optionalKey(
    Schema.String.annotate({ "description": "A signature for the reasoning content, used for verification" })
  ),
  "format": Schema.optionalKey(
    Schema.Literals([
      "unknown",
      "openai-responses-v1",
      "azure-openai-responses-v1",
      "xai-responses-v1",
      "anthropic-claude-v1",
      "google-gemini-v1"
    ]).annotate({ "description": "The format of the reasoning content" })
  )
}).annotate({ "description": "An output item containing reasoning" })
export type OpenResponsesReasoningSummaryPartAddedEvent = {
  readonly "type": "response.reasoning_summary_part.added"
  readonly "output_index": number
  readonly "item_id": string
  readonly "summary_index": number
  readonly "part": ReasoningSummaryText
  readonly "sequence_number": number
}
export const OpenResponsesReasoningSummaryPartAddedEvent = Schema.Struct({
  "type": Schema.Literal("response.reasoning_summary_part.added"),
  "output_index": Schema.Number.check(Schema.isFinite()),
  "item_id": Schema.String,
  "summary_index": Schema.Number.check(Schema.isFinite()),
  "part": ReasoningSummaryText,
  "sequence_number": Schema.Number.check(Schema.isFinite())
}).annotate({ "description": "Event emitted when a reasoning summary part is added" })
export type OpenResponsesReasoningSummaryPartDoneEvent = {
  readonly "type": "response.reasoning_summary_part.done"
  readonly "output_index": number
  readonly "item_id": string
  readonly "summary_index": number
  readonly "part": ReasoningSummaryText
  readonly "sequence_number": number
}
export const OpenResponsesReasoningSummaryPartDoneEvent = Schema.Struct({
  "type": Schema.Literal("response.reasoning_summary_part.done"),
  "output_index": Schema.Number.check(Schema.isFinite()),
  "item_id": Schema.String,
  "summary_index": Schema.Number.check(Schema.isFinite()),
  "part": ReasoningSummaryText,
  "sequence_number": Schema.Number.check(Schema.isFinite())
}).annotate({ "description": "Event emitted when a reasoning summary part is complete" })
export type OpenResponsesReasoning = {
  readonly "type": "reasoning"
  readonly "id": string
  readonly "content"?: ReadonlyArray<ReasoningTextContent>
  readonly "summary": ReadonlyArray<ReasoningSummaryText>
  readonly "encrypted_content"?: string
  readonly "status"?: "completed" | "incomplete" | "in_progress"
  readonly "signature"?: string
  readonly "format"?:
    | "unknown"
    | "openai-responses-v1"
    | "azure-openai-responses-v1"
    | "xai-responses-v1"
    | "anthropic-claude-v1"
    | "google-gemini-v1"
}
export const OpenResponsesReasoning = Schema.Struct({
  "type": Schema.Literal("reasoning"),
  "id": Schema.String,
  "content": Schema.optionalKey(Schema.Array(ReasoningTextContent)),
  "summary": Schema.Array(ReasoningSummaryText),
  "encrypted_content": Schema.optionalKey(Schema.String),
  "status": Schema.optionalKey(Schema.Literals(["completed", "incomplete", "in_progress"])),
  "signature": Schema.optionalKey(Schema.String),
  "format": Schema.optionalKey(
    Schema.Literals([
      "unknown",
      "openai-responses-v1",
      "azure-openai-responses-v1",
      "xai-responses-v1",
      "anthropic-claude-v1",
      "google-gemini-v1"
    ])
  )
}).annotate({ "description": "Reasoning output item with signature and format extensions" })
export type OutputItemWebSearchCall = {
  readonly "type": "web_search_call"
  readonly "id": string
  readonly "status": WebSearchStatus
}
export const OutputItemWebSearchCall = Schema.Struct({
  "type": Schema.Literal("web_search_call"),
  "id": Schema.String,
  "status": WebSearchStatus
})
export type ResponsesWebSearchCallOutput = {
  readonly "type": "web_search_call"
  readonly "id": string
  readonly "status": WebSearchStatus
}
export const ResponsesWebSearchCallOutput = Schema.Struct({
  "type": Schema.Literal("web_search_call"),
  "id": Schema.String,
  "status": WebSearchStatus
})
export type OutputItemFileSearchCall = {
  readonly "type": "file_search_call"
  readonly "id": string
  readonly "queries": ReadonlyArray<string>
  readonly "status": WebSearchStatus
}
export const OutputItemFileSearchCall = Schema.Struct({
  "type": Schema.Literal("file_search_call"),
  "id": Schema.String,
  "queries": Schema.Array(Schema.String),
  "status": WebSearchStatus
})
export type ResponsesOutputItemFileSearchCall = {
  readonly "type": "file_search_call"
  readonly "id": string
  readonly "queries": ReadonlyArray<string>
  readonly "status": WebSearchStatus
}
export const ResponsesOutputItemFileSearchCall = Schema.Struct({
  "type": Schema.Literal("file_search_call"),
  "id": Schema.String,
  "queries": Schema.Array(Schema.String),
  "status": WebSearchStatus
})
export type OutputItemImageGenerationCall = {
  readonly "type": "image_generation_call"
  readonly "id": string
  readonly "result"?: string
  readonly "status": ImageGenerationStatus
}
export const OutputItemImageGenerationCall = Schema.Struct({
  "type": Schema.Literal("image_generation_call"),
  "id": Schema.String,
  "result": Schema.optionalKey(Schema.String),
  "status": ImageGenerationStatus
})
export type ResponsesImageGenerationCall = {
  readonly "type": "image_generation_call"
  readonly "id": string
  readonly "result"?: string
  readonly "status": ImageGenerationStatus
}
export const ResponsesImageGenerationCall = Schema.Struct({
  "type": Schema.Literal("image_generation_call"),
  "id": Schema.String,
  "result": Schema.optionalKey(Schema.String),
  "status": ImageGenerationStatus
})
export type OpenResponsesFunctionToolCall = {
  readonly "type": "function_call"
  readonly "call_id": string
  readonly "name": string
  readonly "arguments": string
  readonly "id": string
  readonly "status"?: ToolCallStatus
}
export const OpenResponsesFunctionToolCall = Schema.Struct({
  "type": Schema.Literal("function_call"),
  "call_id": Schema.String,
  "name": Schema.String,
  "arguments": Schema.String,
  "id": Schema.String,
  "status": Schema.optionalKey(ToolCallStatus)
}).annotate({ "description": "A function call initiated by the model" })
export type OpenResponsesFunctionCallOutput = {
  readonly "type": "function_call_output"
  readonly "id"?: string
  readonly "call_id": string
  readonly "output": string
  readonly "status"?: ToolCallStatus
}
export const OpenResponsesFunctionCallOutput = Schema.Struct({
  "type": Schema.Literal("function_call_output"),
  "id": Schema.optionalKey(Schema.String),
  "call_id": Schema.String,
  "output": Schema.String,
  "status": Schema.optionalKey(ToolCallStatus)
}).annotate({ "description": "The output from a function call execution" })
export type OpenResponsesWebSearchPreviewTool = {
  readonly "type": "web_search_preview"
  readonly "search_context_size"?: ResponsesSearchContextSize
  readonly "user_location"?: WebSearchPreviewToolUserLocation
}
export const OpenResponsesWebSearchPreviewTool = Schema.Struct({
  "type": Schema.Literal("web_search_preview"),
  "search_context_size": Schema.optionalKey(ResponsesSearchContextSize),
  "user_location": Schema.optionalKey(WebSearchPreviewToolUserLocation)
}).annotate({ "description": "Web search preview tool configuration" })
export type OpenResponsesWebSearchPreview20250311Tool = {
  readonly "type": "web_search_preview_2025_03_11"
  readonly "search_context_size"?: ResponsesSearchContextSize
  readonly "user_location"?: WebSearchPreviewToolUserLocation
}
export const OpenResponsesWebSearchPreview20250311Tool = Schema.Struct({
  "type": Schema.Literal("web_search_preview_2025_03_11"),
  "search_context_size": Schema.optionalKey(ResponsesSearchContextSize),
  "user_location": Schema.optionalKey(WebSearchPreviewToolUserLocation)
}).annotate({ "description": "Web search preview tool configuration (2025-03-11 version)" })
export type OpenResponsesWebSearchTool = {
  readonly "type": "web_search"
  readonly "filters"?: { readonly "allowed_domains"?: ReadonlyArray<string> }
  readonly "search_context_size"?: ResponsesSearchContextSize
  readonly "user_location"?: ResponsesWebSearchUserLocation
}
export const OpenResponsesWebSearchTool = Schema.Struct({
  "type": Schema.Literal("web_search"),
  "filters": Schema.optionalKey(Schema.Struct({ "allowed_domains": Schema.optionalKey(Schema.Array(Schema.String)) })),
  "search_context_size": Schema.optionalKey(ResponsesSearchContextSize),
  "user_location": Schema.optionalKey(ResponsesWebSearchUserLocation)
}).annotate({ "description": "Web search tool configuration" })
export type OpenResponsesWebSearch20250826Tool = {
  readonly "type": "web_search_2025_08_26"
  readonly "filters"?: { readonly "allowed_domains"?: ReadonlyArray<string> }
  readonly "search_context_size"?: ResponsesSearchContextSize
  readonly "user_location"?: ResponsesWebSearchUserLocation
}
export const OpenResponsesWebSearch20250826Tool = Schema.Struct({
  "type": Schema.Literal("web_search_2025_08_26"),
  "filters": Schema.optionalKey(Schema.Struct({ "allowed_domains": Schema.optionalKey(Schema.Array(Schema.String)) })),
  "search_context_size": Schema.optionalKey(ResponsesSearchContextSize),
  "user_location": Schema.optionalKey(ResponsesWebSearchUserLocation)
}).annotate({ "description": "Web search tool configuration (2025-08-26 version)" })
export type OpenAIResponsesReasoningConfig = {
  readonly "effort"?: OpenAIResponsesReasoningEffort
  readonly "summary"?: ReasoningSummaryVerbosity
}
export const OpenAIResponsesReasoningConfig = Schema.Struct({
  "effort": Schema.optionalKey(OpenAIResponsesReasoningEffort),
  "summary": Schema.optionalKey(ReasoningSummaryVerbosity)
})
export type OpenResponsesReasoningConfig = {
  readonly "effort"?: OpenAIResponsesReasoningEffort
  readonly "summary"?: ReasoningSummaryVerbosity
  readonly "max_tokens"?: number
  readonly "enabled"?: boolean
}
export const OpenResponsesReasoningConfig = Schema.Struct({
  "effort": Schema.optionalKey(OpenAIResponsesReasoningEffort),
  "summary": Schema.optionalKey(ReasoningSummaryVerbosity),
  "max_tokens": Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
  "enabled": Schema.optionalKey(Schema.Boolean)
}).annotate({ "description": "Configuration for reasoning mode in the response" })
export type ResponseFormatTextConfig =
  | ResponsesFormatText
  | ResponsesFormatJSONObject
  | ResponsesFormatTextJSONSchemaConfig
export const ResponseFormatTextConfig = Schema.Union([
  ResponsesFormatText,
  ResponsesFormatJSONObject,
  ResponsesFormatTextJSONSchemaConfig
]).annotate({ "description": "Text response format configuration" })
export type OpenResponsesLogProbs = {
  readonly "logprob": number
  readonly "token": string
  readonly "top_logprobs"?: ReadonlyArray<OpenResponsesTopLogprobs>
}
export const OpenResponsesLogProbs = Schema.Struct({
  "logprob": Schema.Number.check(Schema.isFinite()),
  "token": Schema.String,
  "top_logprobs": Schema.optionalKey(Schema.Array(OpenResponsesTopLogprobs))
}).annotate({ "description": "Log probability information for a token" })
export type BadRequestResponse = { readonly "error": BadRequestResponseErrorData; readonly "user_id"?: string }
export const BadRequestResponse = Schema.Struct({
  "error": BadRequestResponseErrorData,
  "user_id": Schema.optionalKey(Schema.String)
}).annotate({ "description": "Bad Request - Invalid request parameters or malformed input" })
export type UnauthorizedResponse = { readonly "error": UnauthorizedResponseErrorData; readonly "user_id"?: string }
export const UnauthorizedResponse = Schema.Struct({
  "error": UnauthorizedResponseErrorData,
  "user_id": Schema.optionalKey(Schema.String)
}).annotate({ "description": "Unauthorized - Authentication required or invalid credentials" })
export type PaymentRequiredResponse = {
  readonly "error": PaymentRequiredResponseErrorData
  readonly "user_id"?: string
}
export const PaymentRequiredResponse = Schema.Struct({
  "error": PaymentRequiredResponseErrorData,
  "user_id": Schema.optionalKey(Schema.String)
}).annotate({ "description": "Payment Required - Insufficient credits or quota to complete request" })
export type NotFoundResponse = { readonly "error": NotFoundResponseErrorData; readonly "user_id"?: string }
export const NotFoundResponse = Schema.Struct({
  "error": NotFoundResponseErrorData,
  "user_id": Schema.optionalKey(Schema.String)
}).annotate({ "description": "Not Found - Resource does not exist" })
export type RequestTimeoutResponse = { readonly "error": RequestTimeoutResponseErrorData; readonly "user_id"?: string }
export const RequestTimeoutResponse = Schema.Struct({
  "error": RequestTimeoutResponseErrorData,
  "user_id": Schema.optionalKey(Schema.String)
}).annotate({ "description": "Request Timeout - Operation exceeded time limit" })
export type PayloadTooLargeResponse = {
  readonly "error": PayloadTooLargeResponseErrorData
  readonly "user_id"?: string
}
export const PayloadTooLargeResponse = Schema.Struct({
  "error": PayloadTooLargeResponseErrorData,
  "user_id": Schema.optionalKey(Schema.String)
}).annotate({ "description": "Payload Too Large - Request payload exceeds size limits" })
export type UnprocessableEntityResponse = {
  readonly "error": UnprocessableEntityResponseErrorData
  readonly "user_id"?: string
}
export const UnprocessableEntityResponse = Schema.Struct({
  "error": UnprocessableEntityResponseErrorData,
  "user_id": Schema.optionalKey(Schema.String)
}).annotate({ "description": "Unprocessable Entity - Semantic validation failure" })
export type TooManyRequestsResponse = {
  readonly "error": TooManyRequestsResponseErrorData
  readonly "user_id"?: string
}
export const TooManyRequestsResponse = Schema.Struct({
  "error": TooManyRequestsResponseErrorData,
  "user_id": Schema.optionalKey(Schema.String)
}).annotate({ "description": "Too Many Requests - Rate limit exceeded" })
export type InternalServerResponse = { readonly "error": InternalServerResponseErrorData; readonly "user_id"?: string }
export const InternalServerResponse = Schema.Struct({
  "error": InternalServerResponseErrorData,
  "user_id": Schema.optionalKey(Schema.String)
}).annotate({ "description": "Internal Server Error - Unexpected server error" })
export type BadGatewayResponse = { readonly "error": BadGatewayResponseErrorData; readonly "user_id"?: string }
export const BadGatewayResponse = Schema.Struct({
  "error": BadGatewayResponseErrorData,
  "user_id": Schema.optionalKey(Schema.String)
}).annotate({ "description": "Bad Gateway - Provider/upstream API failure" })
export type ServiceUnavailableResponse = {
  readonly "error": ServiceUnavailableResponseErrorData
  readonly "user_id"?: string
}
export const ServiceUnavailableResponse = Schema.Struct({
  "error": ServiceUnavailableResponseErrorData,
  "user_id": Schema.optionalKey(Schema.String)
}).annotate({ "description": "Service Unavailable - Service temporarily unavailable" })
export type EdgeNetworkTimeoutResponse = {
  readonly "error": EdgeNetworkTimeoutResponseErrorData
  readonly "user_id"?: string
}
export const EdgeNetworkTimeoutResponse = Schema.Struct({
  "error": EdgeNetworkTimeoutResponseErrorData,
  "user_id": Schema.optionalKey(Schema.String)
}).annotate({ "description": "Infrastructure Timeout - Provider request timed out at edge network" })
export type ProviderOverloadedResponse = {
  readonly "error": ProviderOverloadedResponseErrorData
  readonly "user_id"?: string
}
export const ProviderOverloadedResponse = Schema.Struct({
  "error": ProviderOverloadedResponseErrorData,
  "user_id": Schema.optionalKey(Schema.String)
}).annotate({ "description": "Provider Overloaded - Provider is temporarily overloaded" })
export type OpenResponsesEasyInputMessage = {
  readonly "type"?: "message"
  readonly "role": "user" | "system" | "assistant" | "developer"
  readonly "content":
    | ReadonlyArray<
      | ResponseInputText
      | { readonly "type": "input_image"; readonly "detail": "auto" | "high" | "low"; readonly "image_url"?: string }
      | ResponseInputFile
      | ResponseInputAudio
      | ResponseInputVideo
    >
    | string
}
export const OpenResponsesEasyInputMessage = Schema.Struct({
  "type": Schema.optionalKey(Schema.Literal("message")),
  "role": Schema.Literals(["user", "system", "assistant", "developer"]),
  "content": Schema.Union([
    Schema.Array(
      Schema.Union([
        ResponseInputText,
        Schema.Struct({
          "type": Schema.Literal("input_image"),
          "detail": Schema.Literals(["auto", "high", "low"]),
          "image_url": Schema.optionalKey(Schema.String)
        }).annotate({ "description": "Image input content item" }),
        ResponseInputFile,
        ResponseInputAudio,
        ResponseInputVideo
      ], { mode: "oneOf" })
    ),
    Schema.String
  ])
})
export type OpenResponsesInputMessageItem = {
  readonly "id"?: string
  readonly "type"?: "message"
  readonly "role": "user" | "system" | "developer"
  readonly "content": ReadonlyArray<
    | ResponseInputText
    | { readonly "type": "input_image"; readonly "detail": "auto" | "high" | "low"; readonly "image_url"?: string }
    | ResponseInputFile
    | ResponseInputAudio
    | ResponseInputVideo
  >
}
export const OpenResponsesInputMessageItem = Schema.Struct({
  "id": Schema.optionalKey(Schema.String),
  "type": Schema.optionalKey(Schema.Literal("message")),
  "role": Schema.Literals(["user", "system", "developer"]),
  "content": Schema.Array(
    Schema.Union([
      ResponseInputText,
      Schema.Struct({
        "type": Schema.Literal("input_image"),
        "detail": Schema.Literals(["auto", "high", "low"]),
        "image_url": Schema.optionalKey(Schema.String)
      }).annotate({ "description": "Image input content item" }),
      ResponseInputFile,
      ResponseInputAudio,
      ResponseInputVideo
    ], { mode: "oneOf" })
  )
})
export type ProviderSortConfig = { readonly "by"?: ProviderSort | null; readonly "partition"?: "model" | "none" | null }
export const ProviderSortConfig = Schema.Struct({
  "by": Schema.optionalKey(Schema.Union([ProviderSort, Schema.Null])),
  "partition": Schema.optionalKey(Schema.Union([Schema.Literals(["model", "none"]), Schema.Null]))
})
export type PreferredMinThroughput = number | PercentileThroughputCutoffs | unknown
export const PreferredMinThroughput = Schema.Union([
  Schema.Number.check(Schema.isFinite()),
  PercentileThroughputCutoffs,
  Schema.Unknown
]).annotate({
  "description":
    "Preferred minimum throughput (in tokens per second). Can be a number (applies to p50) or an object with percentile-specific cutoffs. Endpoints below the threshold(s) may still be used, but are deprioritized in routing. When using fallback models, this may cause a fallback model to be used instead of the primary model if it meets the threshold."
})
export type PreferredMaxLatency = number | PercentileLatencyCutoffs | unknown
export const PreferredMaxLatency = Schema.Union([
  Schema.Number.check(Schema.isFinite()),
  PercentileLatencyCutoffs,
  Schema.Unknown
]).annotate({
  "description":
    "Preferred maximum latency (in seconds). Can be a number (applies to p50) or an object with percentile-specific cutoffs. Endpoints above the threshold(s) may still be used, but are deprioritized in routing. When using fallback models, this may cause a fallback model to be used instead of the primary model if it meets the threshold."
})
export type PDFParserOptions = { readonly "engine"?: PDFParserEngine }
export const PDFParserOptions = Schema.Struct({ "engine": Schema.optionalKey(PDFParserEngine) }).annotate({
  "description": "Options for PDF parsing."
})
export type ForbiddenResponse = { readonly "error": ForbiddenResponseErrorData; readonly "user_id"?: string }
export const ForbiddenResponse = Schema.Struct({
  "error": ForbiddenResponseErrorData,
  "user_id": Schema.optionalKey(Schema.String)
}).annotate({ "description": "Forbidden - Authentication successful but insufficient permissions" })
export type ModelArchitecture = {
  readonly "tokenizer"?: ModelGroup
  readonly "instruct_type"?:
    | "none"
    | "airoboros"
    | "alpaca"
    | "alpaca-modif"
    | "chatml"
    | "claude"
    | "code-llama"
    | "gemma"
    | "llama2"
    | "llama3"
    | "mistral"
    | "nemotron"
    | "neural"
    | "openchat"
    | "phi3"
    | "rwkv"
    | "vicuna"
    | "zephyr"
    | "deepseek-r1"
    | "deepseek-v3.1"
    | "qwq"
    | "qwen3"
  readonly "modality": string
  readonly "input_modalities": ReadonlyArray<InputModality>
  readonly "output_modalities": ReadonlyArray<OutputModality>
}
export const ModelArchitecture = Schema.Struct({
  "tokenizer": Schema.optionalKey(ModelGroup),
  "instruct_type": Schema.optionalKey(
    Schema.Literals([
      "none",
      "airoboros",
      "alpaca",
      "alpaca-modif",
      "chatml",
      "claude",
      "code-llama",
      "gemma",
      "llama2",
      "llama3",
      "mistral",
      "nemotron",
      "neural",
      "openchat",
      "phi3",
      "rwkv",
      "vicuna",
      "zephyr",
      "deepseek-r1",
      "deepseek-v3.1",
      "qwq",
      "qwen3"
    ]).annotate({ "description": "Instruction format type" })
  ),
  "modality": Schema.String.annotate({ "description": "Primary modality of the model" }),
  "input_modalities": Schema.Array(InputModality).annotate({ "description": "Supported input modalities" }),
  "output_modalities": Schema.Array(OutputModality).annotate({ "description": "Supported output modalities" })
}).annotate({ "description": "Model architecture information" })
export type PublicEndpoint = {
  readonly "name": string
  readonly "model_id": string
  readonly "model_name": string
  readonly "context_length": number
  readonly "pricing": {
    readonly "prompt": string
    readonly "completion": string
    readonly "request"?: string
    readonly "image"?: string
    readonly "image_token"?: string
    readonly "image_output"?: string
    readonly "audio"?: string
    readonly "audio_output"?: string
    readonly "input_audio_cache"?: string
    readonly "web_search"?: string
    readonly "internal_reasoning"?: string
    readonly "input_cache_read"?: string
    readonly "input_cache_write"?: string
    readonly "discount"?: number
  }
  readonly "provider_name": ProviderName
  readonly "tag": string
  readonly "quantization": "int4" | "int8" | "fp4" | "fp6" | "fp8" | "fp16" | "bf16" | "fp32" | "unknown"
  readonly "max_completion_tokens": number
  readonly "max_prompt_tokens": number
  readonly "supported_parameters": ReadonlyArray<Parameter>
  readonly "status"?: EndpointStatus
  readonly "uptime_last_30m": number
  readonly "supports_implicit_caching": boolean
  readonly "latency_last_30m": PercentileStats
  readonly "throughput_last_30m": {
    readonly "p50": number
    readonly "p75": number
    readonly "p90": number
    readonly "p99": number
  }
}
export const PublicEndpoint = Schema.Struct({
  "name": Schema.String,
  "model_id": Schema.String.annotate({ "description": "The unique identifier for the model (permaslug)" }),
  "model_name": Schema.String,
  "context_length": Schema.Number.check(Schema.isFinite()),
  "pricing": Schema.Struct({
    "prompt": Schema.String.annotate({ "description": "A number or string value representing a large number" }),
    "completion": Schema.String.annotate({ "description": "A number or string value representing a large number" }),
    "request": Schema.optionalKey(
      Schema.String.annotate({ "description": "A number or string value representing a large number" })
    ),
    "image": Schema.optionalKey(
      Schema.String.annotate({ "description": "A number or string value representing a large number" })
    ),
    "image_token": Schema.optionalKey(
      Schema.String.annotate({ "description": "A number or string value representing a large number" })
    ),
    "image_output": Schema.optionalKey(
      Schema.String.annotate({ "description": "A number or string value representing a large number" })
    ),
    "audio": Schema.optionalKey(
      Schema.String.annotate({ "description": "A number or string value representing a large number" })
    ),
    "audio_output": Schema.optionalKey(
      Schema.String.annotate({ "description": "A number or string value representing a large number" })
    ),
    "input_audio_cache": Schema.optionalKey(
      Schema.String.annotate({ "description": "A number or string value representing a large number" })
    ),
    "web_search": Schema.optionalKey(
      Schema.String.annotate({ "description": "A number or string value representing a large number" })
    ),
    "internal_reasoning": Schema.optionalKey(
      Schema.String.annotate({ "description": "A number or string value representing a large number" })
    ),
    "input_cache_read": Schema.optionalKey(
      Schema.String.annotate({ "description": "A number or string value representing a large number" })
    ),
    "input_cache_write": Schema.optionalKey(
      Schema.String.annotate({ "description": "A number or string value representing a large number" })
    ),
    "discount": Schema.optionalKey(Schema.Number.check(Schema.isFinite()))
  }),
  "provider_name": ProviderName,
  "tag": Schema.String,
  "quantization": Schema.Literals(["int4", "int8", "fp4", "fp6", "fp8", "fp16", "bf16", "fp32", "unknown"]),
  "max_completion_tokens": Schema.Number.check(Schema.isFinite()),
  "max_prompt_tokens": Schema.Number.check(Schema.isFinite()),
  "supported_parameters": Schema.Array(Parameter),
  "status": Schema.optionalKey(EndpointStatus),
  "uptime_last_30m": Schema.Number.check(Schema.isFinite()),
  "supports_implicit_caching": Schema.Boolean,
  "latency_last_30m": PercentileStats,
  "throughput_last_30m": Schema.Struct({
    "p50": Schema.Number.annotate({ "description": "Median (50th percentile)" }).check(Schema.isFinite()),
    "p75": Schema.Number.annotate({ "description": "75th percentile" }).check(Schema.isFinite()),
    "p90": Schema.Number.annotate({ "description": "90th percentile" }).check(Schema.isFinite()),
    "p99": Schema.Number.annotate({ "description": "99th percentile" }).check(Schema.isFinite())
  }).annotate({
    "description":
      "Throughput percentiles in tokens per second over the last 30 minutes. Throughput measures output token generation speed. Only visible when authenticated with an API key or cookie; returns null for unauthenticated requests."
  })
}).annotate({ "description": "Information about a specific model endpoint" })
export type __schema20 = {
  readonly "type": "reasoning.summary"
  readonly "summary": string
  readonly "id"?: __schema21
  readonly "format"?: __schema22
  readonly "index"?: __schema11
} | {
  readonly "type": "reasoning.encrypted"
  readonly "data": string
  readonly "id"?: __schema21
  readonly "format"?: __schema22
  readonly "index"?: __schema11
} | {
  readonly "type": "reasoning.text"
  readonly "text"?: string | null
  readonly "signature"?: string | null
  readonly "id"?: __schema21
  readonly "format"?: __schema22
  readonly "index"?: __schema11
}
export const __schema20 = Schema.Union([
  Schema.Struct({
    "type": Schema.Literal("reasoning.summary"),
    "summary": Schema.String,
    "id": Schema.optionalKey(__schema21),
    "format": Schema.optionalKey(__schema22),
    "index": Schema.optionalKey(__schema11)
  }),
  Schema.Struct({
    "type": Schema.Literal("reasoning.encrypted"),
    "data": Schema.String,
    "id": Schema.optionalKey(__schema21),
    "format": Schema.optionalKey(__schema22),
    "index": Schema.optionalKey(__schema11)
  }),
  Schema.Struct({
    "type": Schema.Literal("reasoning.text"),
    "text": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
    "signature": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
    "id": Schema.optionalKey(__schema21),
    "format": Schema.optionalKey(__schema22),
    "index": Schema.optionalKey(__schema11)
  })
], { mode: "oneOf" })
export type __schema14 = __schema11 | ModelName | __schema13
export const __schema14 = Schema.Union([__schema11, ModelName, __schema13])
export type ChatMessageTokenLogprobs = {
  readonly "content": ReadonlyArray<ChatMessageTokenLogprob> | null
  readonly "refusal": ReadonlyArray<ChatMessageTokenLogprob> | null
}
export const ChatMessageTokenLogprobs = Schema.Struct({
  "content": Schema.Union([Schema.Array(ChatMessageTokenLogprob), Schema.Null]),
  "refusal": Schema.Union([Schema.Array(ChatMessageTokenLogprob), Schema.Null])
})
export type __schema26 = ChatCompletionFinishReason | null
export const __schema26 = Schema.Union([ChatCompletionFinishReason, Schema.Null])
export type ResponseFormatJSONSchema = { readonly "type": "json_schema"; readonly "json_schema": JSONSchemaConfig }
export const ResponseFormatJSONSchema = Schema.Struct({
  "type": Schema.Literal("json_schema"),
  "json_schema": JSONSchemaConfig
})
export type ChatMessageContentItemText = {
  readonly "type": "text"
  readonly "text": string
  readonly "cache_control"?: ChatMessageContentItemCacheControl
}
export const ChatMessageContentItemText = Schema.Struct({
  "type": Schema.Literal("text"),
  "text": Schema.String,
  "cache_control": Schema.optionalKey(ChatMessageContentItemCacheControl)
})
export type ToolDefinitionJson = {
  readonly "type": "function"
  readonly "function": {
    readonly "name": string
    readonly "description"?: string
    readonly "parameters"?: {}
    readonly "strict"?: boolean | null
  }
  readonly "cache_control"?: ChatMessageContentItemCacheControl
}
export const ToolDefinitionJson = Schema.Struct({
  "type": Schema.Literal("function"),
  "function": Schema.Struct({
    "name": Schema.String.check(Schema.isMaxLength(64)),
    "description": Schema.optionalKey(Schema.String),
    "parameters": Schema.optionalKey(Schema.Struct({}).check(Schema.isPropertyNames(Schema.String))),
    "strict": Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null]))
  }),
  "cache_control": Schema.optionalKey(ChatMessageContentItemCacheControl)
})
export type ToolChoiceOption = "none" | "auto" | "required" | NamedToolChoice
export const ToolChoiceOption = Schema.Union([
  Schema.Literal("none"),
  Schema.Literal("auto"),
  Schema.Literal("required"),
  NamedToolChoice
])
export type ResponseOutputText = {
  readonly "type": "output_text"
  readonly "text": string
  readonly "annotations"?: ReadonlyArray<OpenAIResponsesAnnotation>
  readonly "logprobs"?: ReadonlyArray<
    {
      readonly "token": string
      readonly "bytes": ReadonlyArray<number>
      readonly "logprob": number
      readonly "top_logprobs": ReadonlyArray<
        { readonly "token": string; readonly "bytes": ReadonlyArray<number>; readonly "logprob": number }
      >
    }
  >
}
export const ResponseOutputText = Schema.Struct({
  "type": Schema.Literal("output_text"),
  "text": Schema.String,
  "annotations": Schema.optionalKey(Schema.Array(OpenAIResponsesAnnotation)),
  "logprobs": Schema.optionalKey(Schema.Array(Schema.Struct({
    "token": Schema.String,
    "bytes": Schema.Array(Schema.Number.check(Schema.isFinite())),
    "logprob": Schema.Number.check(Schema.isFinite()),
    "top_logprobs": Schema.Array(
      Schema.Struct({
        "token": Schema.String,
        "bytes": Schema.Array(Schema.Number.check(Schema.isFinite())),
        "logprob": Schema.Number.check(Schema.isFinite())
      })
    )
  })))
})
export type OpenResponsesOutputTextAnnotationAddedEvent = {
  readonly "type": "response.output_text.annotation.added"
  readonly "output_index": number
  readonly "item_id": string
  readonly "content_index": number
  readonly "sequence_number": number
  readonly "annotation_index": number
  readonly "annotation": OpenAIResponsesAnnotation
}
export const OpenResponsesOutputTextAnnotationAddedEvent = Schema.Struct({
  "type": Schema.Literal("response.output_text.annotation.added"),
  "output_index": Schema.Number.check(Schema.isFinite()),
  "item_id": Schema.String,
  "content_index": Schema.Number.check(Schema.isFinite()),
  "sequence_number": Schema.Number.check(Schema.isFinite()),
  "annotation_index": Schema.Number.check(Schema.isFinite()),
  "annotation": OpenAIResponsesAnnotation
}).annotate({ "description": "Event emitted when a text annotation is added to output" })
export type ResponseTextConfig = {
  readonly "format"?: ResponseFormatTextConfig
  readonly "verbosity"?: "high" | "low" | "medium"
}
export const ResponseTextConfig = Schema.Struct({
  "format": Schema.optionalKey(ResponseFormatTextConfig),
  "verbosity": Schema.optionalKey(Schema.Literals(["high", "low", "medium"]))
}).annotate({ "description": "Text output configuration including format and verbosity" })
export type OpenResponsesResponseText = {
  readonly "format"?: ResponseFormatTextConfig
  readonly "verbosity"?: "high" | "low" | "medium"
}
export const OpenResponsesResponseText = Schema.Struct({
  "format": Schema.optionalKey(ResponseFormatTextConfig),
  "verbosity": Schema.optionalKey(Schema.Literals(["high", "low", "medium"]))
}).annotate({ "description": "Text output configuration including format and verbosity" })
export type OpenResponsesTextDeltaEvent = {
  readonly "type": "response.output_text.delta"
  readonly "logprobs": ReadonlyArray<OpenResponsesLogProbs>
  readonly "output_index": number
  readonly "item_id": string
  readonly "content_index": number
  readonly "delta": string
  readonly "sequence_number": number
}
export const OpenResponsesTextDeltaEvent = Schema.Struct({
  "type": Schema.Literal("response.output_text.delta"),
  "logprobs": Schema.Array(OpenResponsesLogProbs),
  "output_index": Schema.Number.check(Schema.isFinite()),
  "item_id": Schema.String,
  "content_index": Schema.Number.check(Schema.isFinite()),
  "delta": Schema.String,
  "sequence_number": Schema.Number.check(Schema.isFinite())
}).annotate({ "description": "Event emitted when a text delta is streamed" })
export type OpenResponsesTextDoneEvent = {
  readonly "type": "response.output_text.done"
  readonly "output_index": number
  readonly "item_id": string
  readonly "content_index": number
  readonly "text": string
  readonly "sequence_number": number
  readonly "logprobs": ReadonlyArray<OpenResponsesLogProbs>
}
export const OpenResponsesTextDoneEvent = Schema.Struct({
  "type": Schema.Literal("response.output_text.done"),
  "output_index": Schema.Number.check(Schema.isFinite()),
  "item_id": Schema.String,
  "content_index": Schema.Number.check(Schema.isFinite()),
  "text": Schema.String,
  "sequence_number": Schema.Number.check(Schema.isFinite()),
  "logprobs": Schema.Array(OpenResponsesLogProbs)
}).annotate({ "description": "Event emitted when text streaming is complete" })
export type ProviderSortUnion = ProviderSort | ProviderSortConfig
export const ProviderSortUnion = Schema.Union([ProviderSort, ProviderSortConfig])
export type ProviderPreferences = {
  readonly "allow_fallbacks"?: boolean
  readonly "require_parameters"?: boolean
  readonly "data_collection"?: DataCollection
  readonly "zdr"?: boolean
  readonly "enforce_distillable_text"?: boolean
  readonly "order"?: ReadonlyArray<ProviderName | string>
  readonly "only"?: ReadonlyArray<ProviderName | string>
  readonly "ignore"?: ReadonlyArray<ProviderName | string>
  readonly "quantizations"?: ReadonlyArray<Quantization>
  readonly "sort"?: "price" | "price" | "throughput" | "throughput" | "latency" | "latency"
  readonly "max_price"?: {
    readonly "prompt"?: BigNumberUnion
    readonly "completion"?: string
    readonly "image"?: string
    readonly "audio"?: string
    readonly "request"?: string
  }
  readonly "preferred_min_throughput"?: PreferredMinThroughput
  readonly "preferred_max_latency"?: PreferredMaxLatency
}
export const ProviderPreferences = Schema.Struct({
  "allow_fallbacks": Schema.optionalKey(Schema.Boolean.annotate({
    "description":
      "Whether to allow backup providers to serve requests\n- true: (default) when the primary provider (or your custom providers in \"order\") is unavailable, use the next best provider.\n- false: use only the primary/custom provider, and return the upstream error if it's unavailable.\n"
  })),
  "require_parameters": Schema.optionalKey(
    Schema.Boolean.annotate({
      "description":
        "Whether to filter providers to only those that support the parameters you've provided. If this setting is omitted or set to false, then providers will receive only the parameters they support, and ignore the rest."
    })
  ),
  "data_collection": Schema.optionalKey(DataCollection),
  "zdr": Schema.optionalKey(
    Schema.Boolean.annotate({
      "description":
        "Whether to restrict routing to only ZDR (Zero Data Retention) endpoints. When true, only endpoints that do not retain prompts will be used."
    })
  ),
  "enforce_distillable_text": Schema.optionalKey(
    Schema.Boolean.annotate({
      "description":
        "Whether to restrict routing to only models that allow text distillation. When true, only models where the author has allowed distillation will be used."
    })
  ),
  "order": Schema.optionalKey(
    Schema.Array(Schema.Union([ProviderName, Schema.String])).annotate({
      "description":
        "An ordered list of provider slugs. The router will attempt to use the first provider in the subset of this list that supports your requested model, and fall back to the next if it is unavailable. If no providers are available, the request will fail with an error message."
    })
  ),
  "only": Schema.optionalKey(
    Schema.Array(Schema.Union([ProviderName, Schema.String])).annotate({
      "description":
        "List of provider slugs to allow. If provided, this list is merged with your account-wide allowed provider settings for this request."
    })
  ),
  "ignore": Schema.optionalKey(
    Schema.Array(Schema.Union([ProviderName, Schema.String])).annotate({
      "description":
        "List of provider slugs to ignore. If provided, this list is merged with your account-wide ignored provider settings for this request."
    })
  ),
  "quantizations": Schema.optionalKey(
    Schema.Array(Quantization).annotate({ "description": "A list of quantization levels to filter the provider by." })
  ),
  "sort": Schema.optionalKey(
    Schema.Union([
      Schema.Union([Schema.Literal("price"), Schema.Literal("price")]).annotate({
        "description":
          "The sorting strategy to use for this request, if \"order\" is not specified. When set, no load balancing is performed."
      }),
      Schema.Union([Schema.Literal("throughput"), Schema.Literal("throughput")]).annotate({
        "description":
          "The sorting strategy to use for this request, if \"order\" is not specified. When set, no load balancing is performed."
      }),
      Schema.Union([Schema.Literal("latency"), Schema.Literal("latency")]).annotate({
        "description":
          "The sorting strategy to use for this request, if \"order\" is not specified. When set, no load balancing is performed."
      })
    ])
  ),
  "max_price": Schema.optionalKey(
    Schema.Struct({
      "prompt": Schema.optionalKey(BigNumberUnion),
      "completion": Schema.optionalKey(
        Schema.String.annotate({ "description": "Price per million completion tokens" })
      ),
      "image": Schema.optionalKey(Schema.String.annotate({ "description": "Price per image" })),
      "audio": Schema.optionalKey(Schema.String.annotate({ "description": "Price per audio unit" })),
      "request": Schema.optionalKey(Schema.String.annotate({ "description": "Price per request" }))
    }).annotate({
      "description":
        "The object specifying the maximum price you want to pay for this request. USD price per million tokens, for prompt and completion."
    })
  ),
  "preferred_min_throughput": Schema.optionalKey(PreferredMinThroughput),
  "preferred_max_latency": Schema.optionalKey(PreferredMaxLatency)
}).annotate({ "description": "Provider routing preferences for the request." })
export type AnthropicMessagesRequest = {
  readonly "model": string
  readonly "max_tokens": number
  readonly "messages": ReadonlyArray<OpenRouterAnthropicMessageParam>
  readonly "system"?:
    | string
    | ReadonlyArray<
      {
        readonly "type": "text"
        readonly "text": string
        readonly "citations"?: ReadonlyArray<
          {
            readonly "type": "char_location"
            readonly "cited_text": string
            readonly "document_index": number
            readonly "document_title": string
            readonly "start_char_index": number
            readonly "end_char_index": number
          } | {
            readonly "type": "page_location"
            readonly "cited_text": string
            readonly "document_index": number
            readonly "document_title": string
            readonly "start_page_number": number
            readonly "end_page_number": number
          } | {
            readonly "type": "content_block_location"
            readonly "cited_text": string
            readonly "document_index": number
            readonly "document_title": string
            readonly "start_block_index": number
            readonly "end_block_index": number
          } | {
            readonly "type": "web_search_result_location"
            readonly "cited_text": string
            readonly "encrypted_index": string
            readonly "title": string
            readonly "url": string
          } | {
            readonly "type": "search_result_location"
            readonly "cited_text": string
            readonly "search_result_index": number
            readonly "source": string
            readonly "title": string
            readonly "start_block_index": number
            readonly "end_block_index": number
          }
        >
        readonly "cache_control"?: { readonly "type": "ephemeral"; readonly "ttl"?: "5m" | "1h" }
      }
    >
  readonly "metadata"?: { readonly "user_id"?: string }
  readonly "stop_sequences"?: ReadonlyArray<string>
  readonly "stream"?: boolean
  readonly "temperature"?: number
  readonly "top_p"?: number
  readonly "top_k"?: number
  readonly "tools"?: ReadonlyArray<
    {
      readonly "name": string
      readonly "description"?: string
      readonly "input_schema": {
        readonly "type": "object"
        readonly "properties"?: unknown
        readonly "required"?: ReadonlyArray<string>
      }
      readonly "type"?: "custom"
      readonly "cache_control"?: { readonly "type": "ephemeral"; readonly "ttl"?: "5m" | "1h" }
    } | {
      readonly "type": "bash_20250124"
      readonly "name": "bash"
      readonly "cache_control"?: { readonly "type": "ephemeral"; readonly "ttl"?: "5m" | "1h" }
    } | {
      readonly "type": "text_editor_20250124"
      readonly "name": "str_replace_editor"
      readonly "cache_control"?: { readonly "type": "ephemeral"; readonly "ttl"?: "5m" | "1h" }
    } | {
      readonly "type": "web_search_20250305"
      readonly "name": "web_search"
      readonly "allowed_domains"?: ReadonlyArray<string>
      readonly "blocked_domains"?: ReadonlyArray<string>
      readonly "max_uses"?: number
      readonly "user_location"?: {
        readonly "type": "approximate"
        readonly "city"?: string
        readonly "country"?: string
        readonly "region"?: string
        readonly "timezone"?: string
      }
      readonly "cache_control"?: { readonly "type": "ephemeral"; readonly "ttl"?: "5m" | "1h" }
    }
  >
  readonly "tool_choice"?:
    | { readonly "type": "auto"; readonly "disable_parallel_tool_use"?: boolean }
    | { readonly "type": "any"; readonly "disable_parallel_tool_use"?: boolean }
    | { readonly "type": "none" }
    | { readonly "type": "tool"; readonly "name": string; readonly "disable_parallel_tool_use"?: boolean }
  readonly "thinking"?: { readonly "type": "enabled"; readonly "budget_tokens": number } | {
    readonly "type": "disabled"
  } | { readonly "type": "adaptive" }
  readonly "service_tier"?: "auto" | "standard_only"
  readonly "provider"?: {
    readonly "allow_fallbacks"?: boolean
    readonly "require_parameters"?: boolean
    readonly "data_collection"?: DataCollection
    readonly "zdr"?: boolean
    readonly "enforce_distillable_text"?: boolean
    readonly "order"?: ReadonlyArray<ProviderName | string>
    readonly "only"?: ReadonlyArray<ProviderName | string>
    readonly "ignore"?: ReadonlyArray<ProviderName | string>
    readonly "quantizations"?: ReadonlyArray<Quantization>
    readonly "sort"?: "price" | "price" | "throughput" | "throughput" | "latency" | "latency"
    readonly "max_price"?: {
      readonly "prompt"?: BigNumberUnion
      readonly "completion"?: string
      readonly "image"?: string
      readonly "audio"?: string
      readonly "request"?: string
    }
    readonly "preferred_min_throughput"?: PreferredMinThroughput
    readonly "preferred_max_latency"?: PreferredMaxLatency
  }
  readonly "plugins"?: ReadonlyArray<
    | { readonly "id": "auto-router"; readonly "enabled"?: boolean; readonly "allowed_models"?: ReadonlyArray<string> }
    | { readonly "id": "moderation" }
    | {
      readonly "id": "web"
      readonly "enabled"?: boolean
      readonly "max_results"?: number
      readonly "search_prompt"?: string
      readonly "engine"?: WebSearchEngine
    }
    | { readonly "id": "file-parser"; readonly "enabled"?: boolean; readonly "pdf"?: PDFParserOptions }
    | { readonly "id": "response-healing"; readonly "enabled"?: boolean }
  >
  readonly "route"?: "fallback" | "sort"
  readonly "user"?: string
  readonly "session_id"?: string
  readonly "trace"?: {
    readonly "trace_id"?: string
    readonly "trace_name"?: string
    readonly "span_name"?: string
    readonly "generation_name"?: string
    readonly "parent_span_id"?: string
  }
  readonly "models"?: ReadonlyArray<string>
  readonly "output_config"?: AnthropicOutputConfig
}
export const AnthropicMessagesRequest = Schema.Struct({
  "model": Schema.String,
  "max_tokens": Schema.Number.check(Schema.isFinite()),
  "messages": Schema.Array(OpenRouterAnthropicMessageParam),
  "system": Schema.optionalKey(Schema.Union([
    Schema.String,
    Schema.Array(Schema.Struct({
      "type": Schema.Literal("text"),
      "text": Schema.String,
      "citations": Schema.optionalKey(Schema.Array(Schema.Union([
        Schema.Struct({
          "type": Schema.Literal("char_location"),
          "cited_text": Schema.String,
          "document_index": Schema.Number.check(Schema.isFinite()),
          "document_title": Schema.String,
          "start_char_index": Schema.Number.check(Schema.isFinite()),
          "end_char_index": Schema.Number.check(Schema.isFinite())
        }),
        Schema.Struct({
          "type": Schema.Literal("page_location"),
          "cited_text": Schema.String,
          "document_index": Schema.Number.check(Schema.isFinite()),
          "document_title": Schema.String,
          "start_page_number": Schema.Number.check(Schema.isFinite()),
          "end_page_number": Schema.Number.check(Schema.isFinite())
        }),
        Schema.Struct({
          "type": Schema.Literal("content_block_location"),
          "cited_text": Schema.String,
          "document_index": Schema.Number.check(Schema.isFinite()),
          "document_title": Schema.String,
          "start_block_index": Schema.Number.check(Schema.isFinite()),
          "end_block_index": Schema.Number.check(Schema.isFinite())
        }),
        Schema.Struct({
          "type": Schema.Literal("web_search_result_location"),
          "cited_text": Schema.String,
          "encrypted_index": Schema.String,
          "title": Schema.String,
          "url": Schema.String
        }),
        Schema.Struct({
          "type": Schema.Literal("search_result_location"),
          "cited_text": Schema.String,
          "search_result_index": Schema.Number.check(Schema.isFinite()),
          "source": Schema.String,
          "title": Schema.String,
          "start_block_index": Schema.Number.check(Schema.isFinite()),
          "end_block_index": Schema.Number.check(Schema.isFinite())
        })
      ], { mode: "oneOf" }))),
      "cache_control": Schema.optionalKey(
        Schema.Struct({ "type": Schema.Literal("ephemeral"), "ttl": Schema.optionalKey(Schema.Literals(["5m", "1h"])) })
      )
    }))
  ])),
  "metadata": Schema.optionalKey(Schema.Struct({ "user_id": Schema.optionalKey(Schema.String) })),
  "stop_sequences": Schema.optionalKey(Schema.Array(Schema.String)),
  "stream": Schema.optionalKey(Schema.Boolean),
  "temperature": Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
  "top_p": Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
  "top_k": Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
  "tools": Schema.optionalKey(Schema.Array(Schema.Union([
    Schema.Struct({
      "name": Schema.String,
      "description": Schema.optionalKey(Schema.String),
      "input_schema": Schema.Struct({
        "type": Schema.Literal("object"),
        "properties": Schema.optionalKey(Schema.Unknown),
        "required": Schema.optionalKey(Schema.Array(Schema.String))
      }),
      "type": Schema.optionalKey(Schema.Literal("custom")),
      "cache_control": Schema.optionalKey(
        Schema.Struct({ "type": Schema.Literal("ephemeral"), "ttl": Schema.optionalKey(Schema.Literals(["5m", "1h"])) })
      )
    }),
    Schema.Struct({
      "type": Schema.Literal("bash_20250124"),
      "name": Schema.Literal("bash"),
      "cache_control": Schema.optionalKey(
        Schema.Struct({ "type": Schema.Literal("ephemeral"), "ttl": Schema.optionalKey(Schema.Literals(["5m", "1h"])) })
      )
    }),
    Schema.Struct({
      "type": Schema.Literal("text_editor_20250124"),
      "name": Schema.Literal("str_replace_editor"),
      "cache_control": Schema.optionalKey(
        Schema.Struct({ "type": Schema.Literal("ephemeral"), "ttl": Schema.optionalKey(Schema.Literals(["5m", "1h"])) })
      )
    }),
    Schema.Struct({
      "type": Schema.Literal("web_search_20250305"),
      "name": Schema.Literal("web_search"),
      "allowed_domains": Schema.optionalKey(Schema.Array(Schema.String)),
      "blocked_domains": Schema.optionalKey(Schema.Array(Schema.String)),
      "max_uses": Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
      "user_location": Schema.optionalKey(
        Schema.Struct({
          "type": Schema.Literal("approximate"),
          "city": Schema.optionalKey(Schema.String),
          "country": Schema.optionalKey(Schema.String),
          "region": Schema.optionalKey(Schema.String),
          "timezone": Schema.optionalKey(Schema.String)
        })
      ),
      "cache_control": Schema.optionalKey(
        Schema.Struct({ "type": Schema.Literal("ephemeral"), "ttl": Schema.optionalKey(Schema.Literals(["5m", "1h"])) })
      )
    })
  ], { mode: "oneOf" }))),
  "tool_choice": Schema.optionalKey(
    Schema.Union([
      Schema.Struct({
        "type": Schema.Literal("auto"),
        "disable_parallel_tool_use": Schema.optionalKey(Schema.Boolean)
      }),
      Schema.Struct({ "type": Schema.Literal("any"), "disable_parallel_tool_use": Schema.optionalKey(Schema.Boolean) }),
      Schema.Struct({ "type": Schema.Literal("none") }),
      Schema.Struct({
        "type": Schema.Literal("tool"),
        "name": Schema.String,
        "disable_parallel_tool_use": Schema.optionalKey(Schema.Boolean)
      })
    ], { mode: "oneOf" })
  ),
  "thinking": Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ "type": Schema.Literal("enabled"), "budget_tokens": Schema.Number.check(Schema.isFinite()) }),
      Schema.Struct({ "type": Schema.Literal("disabled") }),
      Schema.Struct({ "type": Schema.Literal("adaptive") })
    ], { mode: "oneOf" })
  ),
  "service_tier": Schema.optionalKey(Schema.Literals(["auto", "standard_only"])),
  "provider": Schema.optionalKey(
    Schema.Struct({
      "allow_fallbacks": Schema.optionalKey(Schema.Boolean.annotate({
        "description":
          "Whether to allow backup providers to serve requests\n- true: (default) when the primary provider (or your custom providers in \"order\") is unavailable, use the next best provider.\n- false: use only the primary/custom provider, and return the upstream error if it's unavailable.\n"
      })),
      "require_parameters": Schema.optionalKey(
        Schema.Boolean.annotate({
          "description":
            "Whether to filter providers to only those that support the parameters you've provided. If this setting is omitted or set to false, then providers will receive only the parameters they support, and ignore the rest."
        })
      ),
      "data_collection": Schema.optionalKey(DataCollection),
      "zdr": Schema.optionalKey(
        Schema.Boolean.annotate({
          "description":
            "Whether to restrict routing to only ZDR (Zero Data Retention) endpoints. When true, only endpoints that do not retain prompts will be used."
        })
      ),
      "enforce_distillable_text": Schema.optionalKey(
        Schema.Boolean.annotate({
          "description":
            "Whether to restrict routing to only models that allow text distillation. When true, only models where the author has allowed distillation will be used."
        })
      ),
      "order": Schema.optionalKey(
        Schema.Array(Schema.Union([ProviderName, Schema.String])).annotate({
          "description":
            "An ordered list of provider slugs. The router will attempt to use the first provider in the subset of this list that supports your requested model, and fall back to the next if it is unavailable. If no providers are available, the request will fail with an error message."
        })
      ),
      "only": Schema.optionalKey(
        Schema.Array(Schema.Union([ProviderName, Schema.String])).annotate({
          "description":
            "List of provider slugs to allow. If provided, this list is merged with your account-wide allowed provider settings for this request."
        })
      ),
      "ignore": Schema.optionalKey(
        Schema.Array(Schema.Union([ProviderName, Schema.String])).annotate({
          "description":
            "List of provider slugs to ignore. If provided, this list is merged with your account-wide ignored provider settings for this request."
        })
      ),
      "quantizations": Schema.optionalKey(
        Schema.Array(Quantization).annotate({
          "description": "A list of quantization levels to filter the provider by."
        })
      ),
      "sort": Schema.optionalKey(
        Schema.Union([
          Schema.Union([Schema.Literal("price"), Schema.Literal("price")]).annotate({
            "description":
              "The sorting strategy to use for this request, if \"order\" is not specified. When set, no load balancing is performed."
          }),
          Schema.Union([Schema.Literal("throughput"), Schema.Literal("throughput")]).annotate({
            "description":
              "The sorting strategy to use for this request, if \"order\" is not specified. When set, no load balancing is performed."
          }),
          Schema.Union([Schema.Literal("latency"), Schema.Literal("latency")]).annotate({
            "description":
              "The sorting strategy to use for this request, if \"order\" is not specified. When set, no load balancing is performed."
          })
        ])
      ),
      "max_price": Schema.optionalKey(
        Schema.Struct({
          "prompt": Schema.optionalKey(BigNumberUnion),
          "completion": Schema.optionalKey(
            Schema.String.annotate({ "description": "Price per million completion tokens" })
          ),
          "image": Schema.optionalKey(Schema.String.annotate({ "description": "Price per image" })),
          "audio": Schema.optionalKey(Schema.String.annotate({ "description": "Price per audio unit" })),
          "request": Schema.optionalKey(Schema.String.annotate({ "description": "Price per request" }))
        }).annotate({
          "description":
            "The object specifying the maximum price you want to pay for this request. USD price per million tokens, for prompt and completion."
        })
      ),
      "preferred_min_throughput": Schema.optionalKey(PreferredMinThroughput),
      "preferred_max_latency": Schema.optionalKey(PreferredMaxLatency)
    }).annotate({
      "description": "When multiple model providers are available, optionally indicate your routing preference."
    })
  ),
  "plugins": Schema.optionalKey(
    Schema.Array(Schema.Union([
      Schema.Struct({
        "id": Schema.Literal("auto-router"),
        "enabled": Schema.optionalKey(
          Schema.Boolean.annotate({
            "description": "Set to false to disable the auto-router plugin for this request. Defaults to true."
          })
        ),
        "allowed_models": Schema.optionalKey(
          Schema.Array(Schema.String).annotate({
            "description":
              "List of model patterns to filter which models the auto-router can route between. Supports wildcards (e.g., \"anthropic/*\" matches all Anthropic models). When not specified, uses the default supported models list."
          })
        )
      }),
      Schema.Struct({ "id": Schema.Literal("moderation") }),
      Schema.Struct({
        "id": Schema.Literal("web"),
        "enabled": Schema.optionalKey(
          Schema.Boolean.annotate({
            "description": "Set to false to disable the web-search plugin for this request. Defaults to true."
          })
        ),
        "max_results": Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
        "search_prompt": Schema.optionalKey(Schema.String),
        "engine": Schema.optionalKey(WebSearchEngine)
      }),
      Schema.Struct({
        "id": Schema.Literal("file-parser"),
        "enabled": Schema.optionalKey(
          Schema.Boolean.annotate({
            "description": "Set to false to disable the file-parser plugin for this request. Defaults to true."
          })
        ),
        "pdf": Schema.optionalKey(PDFParserOptions)
      }),
      Schema.Struct({
        "id": Schema.Literal("response-healing"),
        "enabled": Schema.optionalKey(
          Schema.Boolean.annotate({
            "description": "Set to false to disable the response-healing plugin for this request. Defaults to true."
          })
        )
      })
    ], { mode: "oneOf" })).annotate({
      "description": "Plugins you want to enable for this request, including their settings."
    })
  ),
  "route": Schema.optionalKey(
    Schema.Literals(["fallback", "sort"]).annotate({
      "description":
        "**DEPRECATED** Use providers.sort.partition instead. Backwards-compatible alias for providers.sort.partition. Accepts legacy values: \"fallback\" (maps to \"model\"), \"sort\" (maps to \"none\")."
    })
  ),
  "user": Schema.optionalKey(
    Schema.String.annotate({
      "description":
        "A unique identifier representing your end-user, which helps distinguish between different users of your app. This allows your app to identify specific users in case of abuse reports, preventing your entire app from being affected by the actions of individual users. Maximum of 128 characters."
    }).check(Schema.isMaxLength(128))
  ),
  "session_id": Schema.optionalKey(
    Schema.String.annotate({
      "description":
        "A unique identifier for grouping related requests (e.g., a conversation or agent workflow) for observability. If provided in both the request body and the x-session-id header, the body value takes precedence. Maximum of 128 characters."
    }).check(Schema.isMaxLength(128))
  ),
  "trace": Schema.optionalKey(
    Schema.Struct({
      "trace_id": Schema.optionalKey(Schema.String),
      "trace_name": Schema.optionalKey(Schema.String),
      "span_name": Schema.optionalKey(Schema.String),
      "generation_name": Schema.optionalKey(Schema.String),
      "parent_span_id": Schema.optionalKey(Schema.String)
    }).annotate({
      "description":
        "Metadata for observability and tracing. Known keys (trace_id, trace_name, span_name, generation_name, parent_span_id) have special handling. Additional keys are passed through as custom metadata to configured broadcast destinations."
    })
  ),
  "models": Schema.optionalKey(Schema.Array(Schema.String)),
  "output_config": Schema.optionalKey(AnthropicOutputConfig)
}).annotate({ "description": "Request schema for Anthropic Messages API endpoint" })
export type Model = {
  readonly "id": string
  readonly "canonical_slug": string
  readonly "hugging_face_id"?: string
  readonly "name": string
  readonly "created": number
  readonly "description"?: string
  readonly "pricing": PublicPricing
  readonly "context_length": number
  readonly "architecture": ModelArchitecture
  readonly "top_provider": TopProviderInfo
  readonly "per_request_limits": PerRequestLimits
  readonly "supported_parameters": ReadonlyArray<Parameter>
  readonly "default_parameters": DefaultParameters
  readonly "expiration_date"?: string
}
export const Model = Schema.Struct({
  "id": Schema.String.annotate({ "description": "Unique identifier for the model" }),
  "canonical_slug": Schema.String.annotate({ "description": "Canonical slug for the model" }),
  "hugging_face_id": Schema.optionalKey(
    Schema.String.annotate({ "description": "Hugging Face model identifier, if applicable" })
  ),
  "name": Schema.String.annotate({ "description": "Display name of the model" }),
  "created": Schema.Number.annotate({ "description": "Unix timestamp of when the model was created" }).check(
    Schema.isFinite()
  ),
  "description": Schema.optionalKey(Schema.String.annotate({ "description": "Description of the model" })),
  "pricing": PublicPricing,
  "context_length": Schema.Number.annotate({ "description": "Maximum context length in tokens" }).check(
    Schema.isFinite()
  ),
  "architecture": ModelArchitecture,
  "top_provider": TopProviderInfo,
  "per_request_limits": PerRequestLimits,
  "supported_parameters": Schema.Array(Parameter).annotate({
    "description": "List of supported parameters for this model"
  }),
  "default_parameters": DefaultParameters,
  "expiration_date": Schema.optionalKey(
    Schema.String.annotate({
      "description":
        "The date after which the model may be removed. ISO 8601 date string (YYYY-MM-DD) or null if no expiration."
    })
  )
}).annotate({ "description": "Information about an AI model available on OpenRouter" })
export type ListEndpointsResponse = {
  readonly "id": string
  readonly "name": string
  readonly "created": number
  readonly "description": string
  readonly "architecture": {
    readonly "tokenizer":
      | "Router"
      | "Media"
      | "Other"
      | "GPT"
      | "Claude"
      | "Gemini"
      | "Grok"
      | "Cohere"
      | "Nova"
      | "Qwen"
      | "Yi"
      | "DeepSeek"
      | "Mistral"
      | "Llama2"
      | "Llama3"
      | "Llama4"
      | "PaLM"
      | "RWKV"
      | "Qwen3"
    readonly "instruct_type":
      | "none"
      | "airoboros"
      | "alpaca"
      | "alpaca-modif"
      | "chatml"
      | "claude"
      | "code-llama"
      | "gemma"
      | "llama2"
      | "llama3"
      | "mistral"
      | "nemotron"
      | "neural"
      | "openchat"
      | "phi3"
      | "rwkv"
      | "vicuna"
      | "zephyr"
      | "deepseek-r1"
      | "deepseek-v3.1"
      | "qwq"
      | "qwen3"
    readonly "modality": string
    readonly "input_modalities": ReadonlyArray<"text" | "image" | "file" | "audio" | "video">
    readonly "output_modalities": ReadonlyArray<"text" | "image" | "embeddings" | "audio">
  }
  readonly "endpoints": ReadonlyArray<PublicEndpoint>
}
export const ListEndpointsResponse = Schema.Struct({
  "id": Schema.String.annotate({ "description": "Unique identifier for the model" }),
  "name": Schema.String.annotate({ "description": "Display name of the model" }),
  "created": Schema.Number.annotate({ "description": "Unix timestamp of when the model was created" }).check(
    Schema.isFinite()
  ),
  "description": Schema.String.annotate({ "description": "Description of the model" }),
  "architecture": Schema.Struct({
    "tokenizer": Schema.Union([
      Schema.Literal("Router").annotate({ "description": "Tokenizer type used by the model" }),
      Schema.Literal("Media").annotate({ "description": "Tokenizer type used by the model" }),
      Schema.Literal("Other").annotate({ "description": "Tokenizer type used by the model" }),
      Schema.Literal("GPT").annotate({ "description": "Tokenizer type used by the model" }),
      Schema.Literal("Claude").annotate({ "description": "Tokenizer type used by the model" }),
      Schema.Literal("Gemini").annotate({ "description": "Tokenizer type used by the model" }),
      Schema.Literal("Grok").annotate({ "description": "Tokenizer type used by the model" }),
      Schema.Literal("Cohere").annotate({ "description": "Tokenizer type used by the model" }),
      Schema.Literal("Nova").annotate({ "description": "Tokenizer type used by the model" }),
      Schema.Literal("Qwen").annotate({ "description": "Tokenizer type used by the model" }),
      Schema.Literal("Yi").annotate({ "description": "Tokenizer type used by the model" }),
      Schema.Literal("DeepSeek").annotate({ "description": "Tokenizer type used by the model" }),
      Schema.Literal("Mistral").annotate({ "description": "Tokenizer type used by the model" }),
      Schema.Literal("Llama2").annotate({ "description": "Tokenizer type used by the model" }),
      Schema.Literal("Llama3").annotate({ "description": "Tokenizer type used by the model" }),
      Schema.Literal("Llama4").annotate({ "description": "Tokenizer type used by the model" }),
      Schema.Literal("PaLM").annotate({ "description": "Tokenizer type used by the model" }),
      Schema.Literal("RWKV").annotate({ "description": "Tokenizer type used by the model" }),
      Schema.Literal("Qwen3").annotate({ "description": "Tokenizer type used by the model" })
    ]).annotate({ "description": "Tokenizer type used by the model" }),
    "instruct_type": Schema.Union([
      Schema.Literal("none").annotate({ "description": "Instruction format type" }),
      Schema.Literal("airoboros").annotate({ "description": "Instruction format type" }),
      Schema.Literal("alpaca").annotate({ "description": "Instruction format type" }),
      Schema.Literal("alpaca-modif").annotate({ "description": "Instruction format type" }),
      Schema.Literal("chatml").annotate({ "description": "Instruction format type" }),
      Schema.Literal("claude").annotate({ "description": "Instruction format type" }),
      Schema.Literal("code-llama").annotate({ "description": "Instruction format type" }),
      Schema.Literal("gemma").annotate({ "description": "Instruction format type" }),
      Schema.Literal("llama2").annotate({ "description": "Instruction format type" }),
      Schema.Literal("llama3").annotate({ "description": "Instruction format type" }),
      Schema.Literal("mistral").annotate({ "description": "Instruction format type" }),
      Schema.Literal("nemotron").annotate({ "description": "Instruction format type" }),
      Schema.Literal("neural").annotate({ "description": "Instruction format type" }),
      Schema.Literal("openchat").annotate({ "description": "Instruction format type" }),
      Schema.Literal("phi3").annotate({ "description": "Instruction format type" }),
      Schema.Literal("rwkv").annotate({ "description": "Instruction format type" }),
      Schema.Literal("vicuna").annotate({ "description": "Instruction format type" }),
      Schema.Literal("zephyr").annotate({ "description": "Instruction format type" }),
      Schema.Literal("deepseek-r1").annotate({ "description": "Instruction format type" }),
      Schema.Literal("deepseek-v3.1").annotate({ "description": "Instruction format type" }),
      Schema.Literal("qwq").annotate({ "description": "Instruction format type" }),
      Schema.Literal("qwen3").annotate({ "description": "Instruction format type" })
    ]).annotate({ "description": "Instruction format type" }),
    "modality": Schema.String.annotate({ "description": "Primary modality of the model" }),
    "input_modalities": Schema.Array(
      Schema.Union([
        Schema.Literal("text"),
        Schema.Literal("image"),
        Schema.Literal("file"),
        Schema.Literal("audio"),
        Schema.Literal("video")
      ])
    ).annotate({ "description": "Supported input modalities" }),
    "output_modalities": Schema.Array(
      Schema.Union([
        Schema.Literal("text"),
        Schema.Literal("image"),
        Schema.Literal("embeddings"),
        Schema.Literal("audio")
      ])
    ).annotate({ "description": "Supported output modalities" })
  }).annotate({ "description": "Model architecture information" }),
  "endpoints": Schema.Array(PublicEndpoint).annotate({ "description": "List of available endpoints for this model" })
}).annotate({ "description": "List of available endpoints for a model" })
export type ChatStreamingMessageChunk = {
  readonly "role"?: "assistant"
  readonly "content"?: string | null
  readonly "reasoning"?: string | null
  readonly "refusal"?: string | null
  readonly "tool_calls"?: ReadonlyArray<ChatStreamingMessageToolCall>
  readonly "reasoning_details"?: ReadonlyArray<__schema20>
  readonly "images"?:
    | ReadonlyArray<{ readonly "type": "image_url"; readonly "image_url": { readonly "url": string } }>
    | null
  readonly "annotations"?:
    | ReadonlyArray<
      {
        readonly "type": "url_citation"
        readonly "url_citation": {
          readonly "url": string
          readonly "title"?: string
          readonly "start_index"?: number
          readonly "end_index"?: number
          readonly "content"?: string
        }
      } | {
        readonly "type": "file_annotation"
        readonly "file_annotation": { readonly "file_id": string; readonly "quote"?: string }
      } | {
        readonly "type": "file"
        readonly "file": {
          readonly "hash": string
          readonly "name": string
          readonly "content"?: ReadonlyArray<{ readonly "type": string; readonly "text"?: string }>
        }
      }
    >
    | null
}
export const ChatStreamingMessageChunk = Schema.Struct({
  "role": Schema.optionalKey(Schema.Literal("assistant")),
  "content": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  "reasoning": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  "refusal": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  "tool_calls": Schema.optionalKey(Schema.Array(ChatStreamingMessageToolCall)),
  "reasoning_details": Schema.optionalKey(Schema.Array(__schema20)),
  "images": Schema.optionalKey(
    Schema.Union([
      Schema.Array(
        Schema.Struct({ "type": Schema.Literal("image_url"), "image_url": Schema.Struct({ "url": Schema.String }) })
      ),
      Schema.Null
    ])
  ),
  "annotations": Schema.optionalKey(Schema.Union([
    Schema.Array(Schema.Union([
      Schema.Struct({
        "type": Schema.Literal("url_citation"),
        "url_citation": Schema.Struct({
          "url": Schema.String,
          "title": Schema.optionalKey(Schema.String),
          "start_index": Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
          "end_index": Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
          "content": Schema.optionalKey(Schema.String)
        })
      }),
      Schema.Struct({
        "type": Schema.Literal("file_annotation"),
        "file_annotation": Schema.Struct({ "file_id": Schema.String, "quote": Schema.optionalKey(Schema.String) })
      }),
      Schema.Struct({
        "type": Schema.Literal("file"),
        "file": Schema.Struct({
          "hash": Schema.String,
          "name": Schema.String,
          "content": Schema.optionalKey(
            Schema.Array(Schema.Struct({ "type": Schema.String, "text": Schema.optionalKey(Schema.String) }))
          )
        })
      })
    ], { mode: "oneOf" })),
    Schema.Null
  ]))
})
export type ChatMessageContentItem =
  | ChatMessageContentItemText
  | ChatMessageContentItemImage
  | ChatMessageContentItemAudio
  | ChatMessageContentItemVideo
export const ChatMessageContentItem = Schema.Union([
  ChatMessageContentItemText,
  ChatMessageContentItemImage,
  ChatMessageContentItemAudio,
  ChatMessageContentItemVideo
], { mode: "oneOf" })
export type SystemMessage = {
  readonly "role": "system"
  readonly "content": string | ReadonlyArray<ChatMessageContentItemText>
  readonly "name"?: string
}
export const SystemMessage = Schema.Struct({
  "role": Schema.Literal("system"),
  "content": Schema.Union([Schema.String, Schema.Array(ChatMessageContentItemText)]),
  "name": Schema.optionalKey(Schema.String)
})
export type DeveloperMessage = {
  readonly "role": "developer"
  readonly "content": string | ReadonlyArray<ChatMessageContentItemText>
  readonly "name"?: string
}
export const DeveloperMessage = Schema.Struct({
  "role": Schema.Literal("developer"),
  "content": Schema.Union([Schema.String, Schema.Array(ChatMessageContentItemText)]),
  "name": Schema.optionalKey(Schema.String)
})
export type OutputMessage = {
  readonly "id": string
  readonly "role": "assistant"
  readonly "type": "message"
  readonly "status"?: "completed" | "incomplete" | "in_progress"
  readonly "content": ReadonlyArray<ResponseOutputText | OpenAIResponsesRefusalContent>
}
export const OutputMessage = Schema.Struct({
  "id": Schema.String,
  "role": Schema.Literal("assistant"),
  "type": Schema.Literal("message"),
  "status": Schema.optionalKey(Schema.Literals(["completed", "incomplete", "in_progress"])),
  "content": Schema.Array(Schema.Union([ResponseOutputText, OpenAIResponsesRefusalContent]))
})
export type ResponsesOutputMessage = {
  readonly "id": string
  readonly "role": "assistant"
  readonly "type": "message"
  readonly "status"?: "completed" | "incomplete" | "in_progress"
  readonly "content": ReadonlyArray<ResponseOutputText | OpenAIResponsesRefusalContent>
}
export const ResponsesOutputMessage = Schema.Struct({
  "id": Schema.String,
  "role": Schema.Literal("assistant"),
  "type": Schema.Literal("message"),
  "status": Schema.optionalKey(Schema.Literals(["completed", "incomplete", "in_progress"])),
  "content": Schema.Array(Schema.Union([ResponseOutputText, OpenAIResponsesRefusalContent]))
}).annotate({ "description": "An output message item" })
export type OpenResponsesContentPartAddedEvent = {
  readonly "type": "response.content_part.added"
  readonly "output_index": number
  readonly "item_id": string
  readonly "content_index": number
  readonly "part": ResponseOutputText | OpenAIResponsesRefusalContent
  readonly "sequence_number": number
}
export const OpenResponsesContentPartAddedEvent = Schema.Struct({
  "type": Schema.Literal("response.content_part.added"),
  "output_index": Schema.Number.check(Schema.isFinite()),
  "item_id": Schema.String,
  "content_index": Schema.Number.check(Schema.isFinite()),
  "part": Schema.Union([ResponseOutputText, OpenAIResponsesRefusalContent]),
  "sequence_number": Schema.Number.check(Schema.isFinite())
}).annotate({ "description": "Event emitted when a new content part is added to an output item" })
export type OpenResponsesContentPartDoneEvent = {
  readonly "type": "response.content_part.done"
  readonly "output_index": number
  readonly "item_id": string
  readonly "content_index": number
  readonly "part": ResponseOutputText | OpenAIResponsesRefusalContent
  readonly "sequence_number": number
}
export const OpenResponsesContentPartDoneEvent = Schema.Struct({
  "type": Schema.Literal("response.content_part.done"),
  "output_index": Schema.Number.check(Schema.isFinite()),
  "item_id": Schema.String,
  "content_index": Schema.Number.check(Schema.isFinite()),
  "part": Schema.Union([ResponseOutputText, OpenAIResponsesRefusalContent]),
  "sequence_number": Schema.Number.check(Schema.isFinite())
}).annotate({ "description": "Event emitted when a content part is complete" })
export type ModelsListResponseData = ReadonlyArray<Model>
export const ModelsListResponseData = Schema.Array(Model).annotate({ "description": "List of available models" })
export type ChatStreamingChoice = {
  readonly "delta": ChatStreamingMessageChunk
  readonly "finish_reason"?: __schema26
  readonly "index": number
  readonly "logprobs"?: ChatMessageTokenLogprobs | null
}
export const ChatStreamingChoice = Schema.Struct({
  "delta": ChatStreamingMessageChunk,
  "finish_reason": Schema.optionalKey(__schema26),
  "index": Schema.Number.check(Schema.isFinite()),
  "logprobs": Schema.optionalKey(Schema.Union([ChatMessageTokenLogprobs, Schema.Null]))
})
export type UserMessage = {
  readonly "role": "user"
  readonly "content": string | ReadonlyArray<ChatMessageContentItem>
  readonly "name"?: string
}
export const UserMessage = Schema.Struct({
  "role": Schema.Literal("user"),
  "content": Schema.Union([Schema.String, Schema.Array(ChatMessageContentItem)]),
  "name": Schema.optionalKey(Schema.String)
})
export type AssistantMessage = {
  readonly "role": "assistant"
  readonly "content"?: string | ReadonlyArray<ChatMessageContentItem> | null
  readonly "name"?: string
  readonly "tool_calls"?: ReadonlyArray<ChatMessageToolCall>
  readonly "refusal"?: string | null
  readonly "reasoning"?: string | null
  readonly "reasoning_details"?: ReadonlyArray<__schema20>
  readonly "images"?:
    | ReadonlyArray<{ readonly "type": "image_url"; readonly "image_url": { readonly "url": string } }>
    | null
  readonly "annotations"?:
    | ReadonlyArray<
      {
        readonly "type": "url_citation"
        readonly "url_citation": {
          readonly "url": string
          readonly "title"?: string
          readonly "start_index"?: number
          readonly "end_index"?: number
          readonly "content"?: string
        }
      } | {
        readonly "type": "file_annotation"
        readonly "file_annotation": { readonly "file_id": string; readonly "quote"?: string }
      } | {
        readonly "type": "file"
        readonly "file": {
          readonly "hash": string
          readonly "name": string
          readonly "content"?: ReadonlyArray<{ readonly "type": string; readonly "text"?: string }>
        }
      }
    >
    | null
}
export const AssistantMessage = Schema.Struct({
  "role": Schema.Literal("assistant"),
  "content": Schema.optionalKey(
    Schema.Union([Schema.Union([Schema.String, Schema.Array(ChatMessageContentItem)]), Schema.Null])
  ),
  "name": Schema.optionalKey(Schema.String),
  "tool_calls": Schema.optionalKey(Schema.Array(ChatMessageToolCall)),
  "refusal": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  "reasoning": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  "reasoning_details": Schema.optionalKey(Schema.Array(__schema20)),
  "images": Schema.optionalKey(
    Schema.Union([
      Schema.Array(
        Schema.Struct({ "type": Schema.Literal("image_url"), "image_url": Schema.Struct({ "url": Schema.String }) })
      ),
      Schema.Null
    ])
  ),
  "annotations": Schema.optionalKey(Schema.Union([
    Schema.Array(Schema.Union([
      Schema.Struct({
        "type": Schema.Literal("url_citation"),
        "url_citation": Schema.Struct({
          "url": Schema.String,
          "title": Schema.optionalKey(Schema.String),
          "start_index": Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
          "end_index": Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
          "content": Schema.optionalKey(Schema.String)
        })
      }),
      Schema.Struct({
        "type": Schema.Literal("file_annotation"),
        "file_annotation": Schema.Struct({ "file_id": Schema.String, "quote": Schema.optionalKey(Schema.String) })
      }),
      Schema.Struct({
        "type": Schema.Literal("file"),
        "file": Schema.Struct({
          "hash": Schema.String,
          "name": Schema.String,
          "content": Schema.optionalKey(
            Schema.Array(Schema.Struct({ "type": Schema.String, "text": Schema.optionalKey(Schema.String) }))
          )
        })
      })
    ], { mode: "oneOf" })),
    Schema.Null
  ]))
})
export type ToolResponseMessage = {
  readonly "role": "tool"
  readonly "content": string | ReadonlyArray<ChatMessageContentItem>
  readonly "tool_call_id": string
}
export const ToolResponseMessage = Schema.Struct({
  "role": Schema.Literal("tool"),
  "content": Schema.Union([Schema.String, Schema.Array(ChatMessageContentItem)]),
  "tool_call_id": Schema.String
})
export type OpenAIResponsesInput =
  | string
  | ReadonlyArray<
    | {
      readonly "type"?: "message"
      readonly "role": "user" | "system" | "assistant" | "developer"
      readonly "content":
        | ReadonlyArray<ResponseInputText | ResponseInputImage | ResponseInputFile | ResponseInputAudio>
        | string
    }
    | {
      readonly "id": string
      readonly "type"?: "message"
      readonly "role": "user" | "system" | "developer"
      readonly "content": ReadonlyArray<ResponseInputText | ResponseInputImage | ResponseInputFile | ResponseInputAudio>
    }
    | {
      readonly "type": "function_call_output"
      readonly "id"?: string
      readonly "call_id": string
      readonly "output": string
      readonly "status"?: ToolCallStatus
    }
    | {
      readonly "type": "function_call"
      readonly "call_id": string
      readonly "name": string
      readonly "arguments": string
      readonly "id"?: string
      readonly "status"?: ToolCallStatus
    }
    | OutputItemImageGenerationCall
    | OutputMessage
  >
  | unknown
export const OpenAIResponsesInput = Schema.Union([
  Schema.String,
  Schema.Array(Schema.Union([
    Schema.Struct({
      "type": Schema.optionalKey(Schema.Literal("message")),
      "role": Schema.Literals(["user", "system", "assistant", "developer"]),
      "content": Schema.Union([
        Schema.Array(
          Schema.Union([ResponseInputText, ResponseInputImage, ResponseInputFile, ResponseInputAudio], {
            mode: "oneOf"
          })
        ),
        Schema.String
      ])
    }),
    Schema.Struct({
      "id": Schema.String,
      "type": Schema.optionalKey(Schema.Literal("message")),
      "role": Schema.Literals(["user", "system", "developer"]),
      "content": Schema.Array(
        Schema.Union([ResponseInputText, ResponseInputImage, ResponseInputFile, ResponseInputAudio], { mode: "oneOf" })
      )
    }),
    Schema.Struct({
      "type": Schema.Literal("function_call_output"),
      "id": Schema.optionalKey(Schema.String),
      "call_id": Schema.String,
      "output": Schema.String,
      "status": Schema.optionalKey(ToolCallStatus)
    }),
    Schema.Struct({
      "type": Schema.Literal("function_call"),
      "call_id": Schema.String,
      "name": Schema.String,
      "arguments": Schema.String,
      "id": Schema.optionalKey(Schema.String),
      "status": Schema.optionalKey(ToolCallStatus)
    }),
    OutputItemImageGenerationCall,
    OutputMessage
  ])),
  Schema.Unknown
])
export type OpenResponsesOutputItemAddedEvent = {
  readonly "type": "response.output_item.added"
  readonly "output_index": number
  readonly "item":
    | OutputMessage
    | OutputItemReasoning
    | OutputItemFunctionCall
    | OutputItemWebSearchCall
    | OutputItemFileSearchCall
    | OutputItemImageGenerationCall
  readonly "sequence_number": number
}
export const OpenResponsesOutputItemAddedEvent = Schema.Struct({
  "type": Schema.Literal("response.output_item.added"),
  "output_index": Schema.Number.check(Schema.isFinite()),
  "item": Schema.Union([
    OutputMessage,
    OutputItemReasoning,
    OutputItemFunctionCall,
    OutputItemWebSearchCall,
    OutputItemFileSearchCall,
    OutputItemImageGenerationCall
  ], { mode: "oneOf" }),
  "sequence_number": Schema.Number.check(Schema.isFinite())
}).annotate({ "description": "Event emitted when a new output item is added to the response" })
export type OpenResponsesOutputItemDoneEvent = {
  readonly "type": "response.output_item.done"
  readonly "output_index": number
  readonly "item":
    | OutputMessage
    | OutputItemReasoning
    | OutputItemFunctionCall
    | OutputItemWebSearchCall
    | OutputItemFileSearchCall
    | OutputItemImageGenerationCall
  readonly "sequence_number": number
}
export const OpenResponsesOutputItemDoneEvent = Schema.Struct({
  "type": Schema.Literal("response.output_item.done"),
  "output_index": Schema.Number.check(Schema.isFinite()),
  "item": Schema.Union([
    OutputMessage,
    OutputItemReasoning,
    OutputItemFunctionCall,
    OutputItemWebSearchCall,
    OutputItemFileSearchCall,
    OutputItemImageGenerationCall
  ], { mode: "oneOf" }),
  "sequence_number": Schema.Number.check(Schema.isFinite())
}).annotate({ "description": "Event emitted when an output item is complete" })
export type OpenResponsesInput =
  | string
  | ReadonlyArray<
    | OpenResponsesReasoning
    | OpenResponsesEasyInputMessage
    | OpenResponsesInputMessageItem
    | OpenResponsesFunctionToolCall
    | OpenResponsesFunctionCallOutput
    | ResponsesOutputMessage
    | ResponsesOutputItemReasoning
    | ResponsesOutputItemFunctionCall
    | ResponsesWebSearchCallOutput
    | ResponsesOutputItemFileSearchCall
    | ResponsesImageGenerationCall
  >
export const OpenResponsesInput = Schema.Union([
  Schema.String,
  Schema.Array(
    Schema.Union([
      OpenResponsesReasoning,
      OpenResponsesEasyInputMessage,
      OpenResponsesInputMessageItem,
      OpenResponsesFunctionToolCall,
      OpenResponsesFunctionCallOutput,
      ResponsesOutputMessage,
      ResponsesOutputItemReasoning,
      ResponsesOutputItemFunctionCall,
      ResponsesWebSearchCallOutput,
      ResponsesOutputItemFileSearchCall,
      ResponsesImageGenerationCall
    ])
  )
]).annotate({ "description": "Input for a response request - can be a string or array of items" })
export type ModelsListResponse = { readonly "data": ModelsListResponseData }
export const ModelsListResponse = Schema.Struct({ "data": ModelsListResponseData }).annotate({
  "description": "List of available models"
})
export type ChatStreamingResponseChunk = {
  readonly "data": {
    readonly "id": string
    readonly "choices": ReadonlyArray<ChatStreamingChoice>
    readonly "created": number
    readonly "model": string
    readonly "object": "chat.completion.chunk"
    readonly "system_fingerprint"?: string | null
    readonly "error"?: { readonly "message": string; readonly "code": number }
    readonly "usage"?: ChatGenerationTokenUsage
  }
}
export const ChatStreamingResponseChunk = Schema.Struct({
  "data": Schema.Struct({
    "id": Schema.String,
    "choices": Schema.Array(ChatStreamingChoice),
    "created": Schema.Number.check(Schema.isFinite()),
    "model": Schema.String,
    "object": Schema.Literal("chat.completion.chunk"),
    "system_fingerprint": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
    "error": Schema.optionalKey(
      Schema.Struct({ "message": Schema.String, "code": Schema.Number.check(Schema.isFinite()) })
    ),
    "usage": Schema.optionalKey(ChatGenerationTokenUsage)
  })
})
export type ChatResponseChoice = {
  readonly "finish_reason": __schema26
  readonly "index": number
  readonly "message": AssistantMessage
  readonly "logprobs"?: ChatMessageTokenLogprobs | null
}
export const ChatResponseChoice = Schema.Struct({
  "finish_reason": __schema26,
  "index": Schema.Number.check(Schema.isFinite()),
  "message": AssistantMessage,
  "logprobs": Schema.optionalKey(Schema.Union([ChatMessageTokenLogprobs, Schema.Null]))
})
export type Message = SystemMessage | UserMessage | DeveloperMessage | AssistantMessage | ToolResponseMessage
export const Message = Schema.Union([
  SystemMessage,
  UserMessage,
  DeveloperMessage,
  AssistantMessage,
  ToolResponseMessage
], { mode: "oneOf" })
export type OpenAIResponsesNonStreamingResponse = {
  readonly "id": string
  readonly "object": "response"
  readonly "created_at": number
  readonly "model": string
  readonly "status": OpenAIResponsesResponseStatus
  readonly "completed_at": number
  readonly "output": ReadonlyArray<
    | OutputMessage
    | OutputItemReasoning
    | OutputItemFunctionCall
    | OutputItemWebSearchCall
    | OutputItemFileSearchCall
    | OutputItemImageGenerationCall
  >
  readonly "user"?: string
  readonly "output_text"?: string
  readonly "prompt_cache_key"?: string
  readonly "safety_identifier"?: string
  readonly "error": ResponsesErrorField
  readonly "incomplete_details": OpenAIResponsesIncompleteDetails
  readonly "usage"?: OpenAIResponsesUsage
  readonly "max_tool_calls"?: number
  readonly "top_logprobs"?: number
  readonly "max_output_tokens"?: number
  readonly "temperature": number
  readonly "top_p": number
  readonly "presence_penalty": number
  readonly "frequency_penalty": number
  readonly "instructions": OpenAIResponsesInput
  readonly "metadata": OpenResponsesRequestMetadata
  readonly "tools": ReadonlyArray<
    | {
      readonly "type": "function"
      readonly "name": string
      readonly "description"?: string
      readonly "strict"?: boolean
      readonly "parameters": {}
    }
    | OpenResponsesWebSearchPreviewTool
    | OpenResponsesWebSearchPreview20250311Tool
    | OpenResponsesWebSearchTool
    | OpenResponsesWebSearch20250826Tool
  >
  readonly "tool_choice": OpenAIResponsesToolChoice
  readonly "parallel_tool_calls": boolean
  readonly "prompt"?: OpenAIResponsesPrompt
  readonly "background"?: boolean
  readonly "previous_response_id"?: string
  readonly "reasoning"?: OpenAIResponsesReasoningConfig
  readonly "service_tier"?: OpenAIResponsesServiceTier
  readonly "store"?: boolean
  readonly "truncation"?: OpenAIResponsesTruncation
  readonly "text"?: ResponseTextConfig
}
export const OpenAIResponsesNonStreamingResponse = Schema.Struct({
  "id": Schema.String,
  "object": Schema.Literal("response"),
  "created_at": Schema.Number.check(Schema.isFinite()),
  "model": Schema.String,
  "status": OpenAIResponsesResponseStatus,
  "completed_at": Schema.Number.check(Schema.isFinite()),
  "output": Schema.Array(
    Schema.Union([
      OutputMessage,
      OutputItemReasoning,
      OutputItemFunctionCall,
      OutputItemWebSearchCall,
      OutputItemFileSearchCall,
      OutputItemImageGenerationCall
    ], { mode: "oneOf" })
  ),
  "user": Schema.optionalKey(Schema.String),
  "output_text": Schema.optionalKey(Schema.String),
  "prompt_cache_key": Schema.optionalKey(Schema.String),
  "safety_identifier": Schema.optionalKey(Schema.String),
  "error": ResponsesErrorField,
  "incomplete_details": OpenAIResponsesIncompleteDetails,
  "usage": Schema.optionalKey(OpenAIResponsesUsage),
  "max_tool_calls": Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
  "top_logprobs": Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
  "max_output_tokens": Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
  "temperature": Schema.Number.check(Schema.isFinite()),
  "top_p": Schema.Number.check(Schema.isFinite()),
  "presence_penalty": Schema.Number.check(Schema.isFinite()),
  "frequency_penalty": Schema.Number.check(Schema.isFinite()),
  "instructions": OpenAIResponsesInput,
  "metadata": OpenResponsesRequestMetadata,
  "tools": Schema.Array(
    Schema.Union([
      Schema.Struct({
        "type": Schema.Literal("function"),
        "name": Schema.String,
        "description": Schema.optionalKey(Schema.String),
        "strict": Schema.optionalKey(Schema.Boolean),
        "parameters": Schema.Struct({})
      }).annotate({ "description": "Function tool definition" }),
      OpenResponsesWebSearchPreviewTool,
      OpenResponsesWebSearchPreview20250311Tool,
      OpenResponsesWebSearchTool,
      OpenResponsesWebSearch20250826Tool
    ], { mode: "oneOf" })
  ),
  "tool_choice": OpenAIResponsesToolChoice,
  "parallel_tool_calls": Schema.Boolean,
  "prompt": Schema.optionalKey(OpenAIResponsesPrompt),
  "background": Schema.optionalKey(Schema.Boolean),
  "previous_response_id": Schema.optionalKey(Schema.String),
  "reasoning": Schema.optionalKey(OpenAIResponsesReasoningConfig),
  "service_tier": Schema.optionalKey(OpenAIResponsesServiceTier),
  "store": Schema.optionalKey(Schema.Boolean),
  "truncation": Schema.optionalKey(OpenAIResponsesTruncation),
  "text": Schema.optionalKey(ResponseTextConfig)
})
export type OpenResponsesNonStreamingResponse = {
  readonly "id": string
  readonly "object": "response"
  readonly "created_at": number
  readonly "model": string
  readonly "status": OpenAIResponsesResponseStatus
  readonly "completed_at": number
  readonly "output": ReadonlyArray<
    {
      readonly "id": string
      readonly "role": "assistant"
      readonly "type": "message"
      readonly "status"?: "completed" | "incomplete" | "in_progress"
      readonly "content": ReadonlyArray<
        {
          readonly "type": "output_text"
          readonly "text": string
          readonly "annotations"?: ReadonlyArray<
            {
              readonly "type": "file_citation"
              readonly "file_id": string
              readonly "filename": string
              readonly "index": number
            } | {
              readonly "type": never
              readonly "url": string
              readonly "title": string
              readonly "start_index": number
              readonly "end_index": number
              readonly "file_id": string
              readonly "filename": string
              readonly "index": number
            } | {
              readonly "type": never
              readonly "file_id": string
              readonly "index": number
              readonly "filename": string
            } | {
              readonly "type": never
              readonly "file_id": string
              readonly "filename": string
              readonly "index": number
              readonly "url": string
              readonly "title": string
              readonly "start_index": number
              readonly "end_index": number
            } | {
              readonly "type": "url_citation"
              readonly "url": string
              readonly "title": string
              readonly "start_index": number
              readonly "end_index": number
            } | {
              readonly "type": never
              readonly "file_id": string
              readonly "index": number
              readonly "url": string
              readonly "title": string
              readonly "start_index": number
              readonly "end_index": number
            } | {
              readonly "type": never
              readonly "file_id": string
              readonly "filename": string
              readonly "index": number
            } | {
              readonly "type": never
              readonly "url": string
              readonly "title": string
              readonly "start_index": number
              readonly "end_index": number
              readonly "file_id": string
              readonly "index": number
            } | { readonly "type": "file_path"; readonly "file_id": string; readonly "index": number }
          >
          readonly "logprobs"?: ReadonlyArray<
            {
              readonly "token": string
              readonly "bytes": ReadonlyArray<number>
              readonly "logprob": number
              readonly "top_logprobs": ReadonlyArray<
                { readonly "token": string; readonly "bytes": ReadonlyArray<number>; readonly "logprob": number }
              >
            }
          >
        } | {
          readonly "type": never
          readonly "refusal": string
          readonly "text": string
          readonly "annotations"?: ReadonlyArray<OpenAIResponsesAnnotation>
          readonly "logprobs"?: ReadonlyArray<
            {
              readonly "token": string
              readonly "bytes": ReadonlyArray<number>
              readonly "logprob": number
              readonly "top_logprobs": ReadonlyArray<
                { readonly "token": string; readonly "bytes": ReadonlyArray<number>; readonly "logprob": number }
              >
            }
          >
        } | {
          readonly "type": never
          readonly "text": string
          readonly "annotations"?: ReadonlyArray<OpenAIResponsesAnnotation>
          readonly "logprobs"?: ReadonlyArray<
            {
              readonly "token": string
              readonly "bytes": ReadonlyArray<number>
              readonly "logprob": number
              readonly "top_logprobs": ReadonlyArray<
                { readonly "token": string; readonly "bytes": ReadonlyArray<number>; readonly "logprob": number }
              >
            }
          >
          readonly "refusal": string
        } | { readonly "type": "refusal"; readonly "refusal": string }
      >
    } | {
      readonly "type": never
      readonly "id": string
      readonly "content": ReadonlyArray<
        {
          readonly "type": never
          readonly "text": string
          readonly "annotations"?: ReadonlyArray<OpenAIResponsesAnnotation>
          readonly "logprobs"?: ReadonlyArray<
            {
              readonly "token": string
              readonly "bytes": ReadonlyArray<number>
              readonly "logprob": number
              readonly "top_logprobs": ReadonlyArray<
                { readonly "token": string; readonly "bytes": ReadonlyArray<number>; readonly "logprob": number }
              >
            }
          >
        } | { readonly "type": never; readonly "refusal": string; readonly "text": string }
      >
      readonly "summary": ReadonlyArray<ReasoningSummaryText>
      readonly "encrypted_content"?: string
      readonly "status"?: "completed" | "incomplete" | "in_progress"
      readonly "signature"?: string
      readonly "format"?:
        | "unknown"
        | "openai-responses-v1"
        | "azure-openai-responses-v1"
        | "xai-responses-v1"
        | "anthropic-claude-v1"
        | "google-gemini-v1"
      readonly "role": "assistant"
    } | {
      readonly "type": never
      readonly "id": string
      readonly "name": string
      readonly "arguments": string
      readonly "call_id": string
      readonly "status"?: "completed" | "incomplete" | "in_progress"
      readonly "role": "assistant"
      readonly "content": ReadonlyArray<ResponseOutputText | OpenAIResponsesRefusalContent>
    } | {
      readonly "type": never
      readonly "id": string
      readonly "status": "completed" | "in_progress"
      readonly "role": "assistant"
      readonly "content": ReadonlyArray<ResponseOutputText | OpenAIResponsesRefusalContent>
    } | {
      readonly "type": never
      readonly "id": string
      readonly "queries": ReadonlyArray<string>
      readonly "status": "completed" | "in_progress"
      readonly "role": "assistant"
      readonly "content": ReadonlyArray<ResponseOutputText | OpenAIResponsesRefusalContent>
    } | {
      readonly "type": never
      readonly "id": string
      readonly "result"?: string
      readonly "status": "in_progress" | "completed"
      readonly "role": "assistant"
      readonly "content": ReadonlyArray<ResponseOutputText | OpenAIResponsesRefusalContent>
    } | {
      readonly "id": string
      readonly "role": "assistant"
      readonly "type": never
      readonly "status"?: "completed" | "incomplete" | "in_progress"
      readonly "content": ReadonlyArray<
        {
          readonly "type": never
          readonly "text": string
          readonly "annotations"?: ReadonlyArray<OpenAIResponsesAnnotation>
          readonly "logprobs"?: ReadonlyArray<
            {
              readonly "token": string
              readonly "bytes": ReadonlyArray<number>
              readonly "logprob": number
              readonly "top_logprobs": ReadonlyArray<
                { readonly "token": string; readonly "bytes": ReadonlyArray<number>; readonly "logprob": number }
              >
            }
          >
        } | { readonly "type": never; readonly "refusal": string; readonly "text": string }
      >
      readonly "summary": ReadonlyArray<ReasoningSummaryText>
      readonly "encrypted_content"?: string
    } | {
      readonly "type": "reasoning"
      readonly "id": string
      readonly "content"?: ReadonlyArray<{ readonly "type": "reasoning_text"; readonly "text": string }>
      readonly "summary": ReadonlyArray<{ readonly "type": "summary_text"; readonly "text": string }>
      readonly "encrypted_content"?: string
      readonly "status"?: "completed" | "incomplete" | "in_progress"
      readonly "signature"?: string
      readonly "format"?:
        | "unknown"
        | "openai-responses-v1"
        | "azure-openai-responses-v1"
        | "xai-responses-v1"
        | "anthropic-claude-v1"
        | "google-gemini-v1"
    } | {
      readonly "type": never
      readonly "id": string
      readonly "name": string
      readonly "arguments": string
      readonly "call_id": string
      readonly "status"?: "completed" | "incomplete" | "in_progress"
      readonly "content"?: ReadonlyArray<ReasoningTextContent>
      readonly "summary": ReadonlyArray<ReasoningSummaryText>
      readonly "encrypted_content"?: string
    } | {
      readonly "type": never
      readonly "id": string
      readonly "status": "completed" | "in_progress"
      readonly "content"?: ReadonlyArray<ReasoningTextContent>
      readonly "summary": ReadonlyArray<ReasoningSummaryText>
      readonly "encrypted_content"?: string
    } | {
      readonly "type": never
      readonly "id": string
      readonly "queries": ReadonlyArray<string>
      readonly "status": "completed" | "in_progress"
      readonly "content"?: ReadonlyArray<ReasoningTextContent>
      readonly "summary": ReadonlyArray<ReasoningSummaryText>
      readonly "encrypted_content"?: string
    } | {
      readonly "type": never
      readonly "id": string
      readonly "result"?: string
      readonly "status": "in_progress" | "completed"
      readonly "content"?: ReadonlyArray<ReasoningTextContent>
      readonly "summary": ReadonlyArray<ReasoningSummaryText>
      readonly "encrypted_content"?: string
    } | {
      readonly "id": string
      readonly "role": "assistant"
      readonly "type": never
      readonly "status"?: "completed" | "incomplete" | "in_progress"
      readonly "content": ReadonlyArray<ResponseOutputText | OpenAIResponsesRefusalContent>
      readonly "name": string
      readonly "arguments": string
      readonly "call_id": string
    } | {
      readonly "type": never
      readonly "id": string
      readonly "content"?: ReadonlyArray<ReasoningTextContent>
      readonly "summary": ReadonlyArray<ReasoningSummaryText>
      readonly "encrypted_content"?: string
      readonly "status"?: "completed" | "incomplete" | "in_progress"
      readonly "signature"?: string
      readonly "format"?:
        | "unknown"
        | "openai-responses-v1"
        | "azure-openai-responses-v1"
        | "xai-responses-v1"
        | "anthropic-claude-v1"
        | "google-gemini-v1"
      readonly "name": string
      readonly "arguments": string
      readonly "call_id": string
    } | {
      readonly "type": "function_call"
      readonly "id"?: string
      readonly "name": string
      readonly "arguments": string
      readonly "call_id": string
      readonly "status"?: "completed" | "incomplete" | "in_progress"
    } | {
      readonly "type": never
      readonly "id": string
      readonly "status": "completed" | "in_progress"
      readonly "name": string
      readonly "arguments": string
      readonly "call_id": string
    } | {
      readonly "type": never
      readonly "id": string
      readonly "queries": ReadonlyArray<string>
      readonly "status": "completed" | "in_progress"
      readonly "name": string
      readonly "arguments": string
      readonly "call_id": string
    } | {
      readonly "type": never
      readonly "id": string
      readonly "result"?: string
      readonly "status": "in_progress" | "completed"
      readonly "name": string
      readonly "arguments": string
      readonly "call_id": string
    } | {
      readonly "id": string
      readonly "role": "assistant"
      readonly "type": never
      readonly "status": "completed" | "in_progress"
      readonly "content": ReadonlyArray<ResponseOutputText | OpenAIResponsesRefusalContent>
    } | {
      readonly "type": never
      readonly "id": string
      readonly "content"?: ReadonlyArray<ReasoningTextContent>
      readonly "summary": ReadonlyArray<ReasoningSummaryText>
      readonly "encrypted_content"?: string
      readonly "status": "completed" | "in_progress"
      readonly "signature"?: string
      readonly "format"?:
        | "unknown"
        | "openai-responses-v1"
        | "azure-openai-responses-v1"
        | "xai-responses-v1"
        | "anthropic-claude-v1"
        | "google-gemini-v1"
    } | {
      readonly "type": never
      readonly "id": string
      readonly "name": string
      readonly "arguments": string
      readonly "call_id": string
      readonly "status": "completed" | "in_progress"
    } | {
      readonly "type": "web_search_call"
      readonly "id": string
      readonly "status": "completed" | "searching" | "in_progress" | "failed"
    } | {
      readonly "type": never
      readonly "id": string
      readonly "queries": ReadonlyArray<string>
      readonly "status": "completed" | "searching" | "in_progress" | "failed"
    } | {
      readonly "type": never
      readonly "id": string
      readonly "result"?: string
      readonly "status": "in_progress" | "completed" | "failed"
    } | {
      readonly "id": string
      readonly "role": "assistant"
      readonly "type": never
      readonly "status": "completed" | "in_progress"
      readonly "content": ReadonlyArray<ResponseOutputText | OpenAIResponsesRefusalContent>
      readonly "queries": ReadonlyArray<string>
    } | {
      readonly "type": never
      readonly "id": string
      readonly "content"?: ReadonlyArray<ReasoningTextContent>
      readonly "summary": ReadonlyArray<ReasoningSummaryText>
      readonly "encrypted_content"?: string
      readonly "status": "completed" | "in_progress"
      readonly "signature"?: string
      readonly "format"?:
        | "unknown"
        | "openai-responses-v1"
        | "azure-openai-responses-v1"
        | "xai-responses-v1"
        | "anthropic-claude-v1"
        | "google-gemini-v1"
      readonly "queries": ReadonlyArray<string>
    } | {
      readonly "type": never
      readonly "id": string
      readonly "name": string
      readonly "arguments": string
      readonly "call_id": string
      readonly "status": "completed" | "in_progress"
      readonly "queries": ReadonlyArray<string>
    } | {
      readonly "type": never
      readonly "id": string
      readonly "status": "completed" | "searching" | "in_progress" | "failed"
      readonly "queries": ReadonlyArray<string>
    } | {
      readonly "type": "file_search_call"
      readonly "id": string
      readonly "queries": ReadonlyArray<string>
      readonly "status": "completed" | "searching" | "in_progress" | "failed"
    } | {
      readonly "type": never
      readonly "id": string
      readonly "result"?: string
      readonly "status": "in_progress" | "completed" | "failed"
      readonly "queries": ReadonlyArray<string>
    } | {
      readonly "id": string
      readonly "role": "assistant"
      readonly "type": never
      readonly "status": "completed" | "in_progress"
      readonly "content": ReadonlyArray<ResponseOutputText | OpenAIResponsesRefusalContent>
      readonly "result"?: string
    } | {
      readonly "type": never
      readonly "id": string
      readonly "content"?: ReadonlyArray<ReasoningTextContent>
      readonly "summary": ReadonlyArray<ReasoningSummaryText>
      readonly "encrypted_content"?: string
      readonly "status": "completed" | "in_progress"
      readonly "signature"?: string
      readonly "format"?:
        | "unknown"
        | "openai-responses-v1"
        | "azure-openai-responses-v1"
        | "xai-responses-v1"
        | "anthropic-claude-v1"
        | "google-gemini-v1"
      readonly "result"?: string
    } | {
      readonly "type": never
      readonly "id": string
      readonly "name": string
      readonly "arguments": string
      readonly "call_id": string
      readonly "status": "completed" | "in_progress"
      readonly "result"?: string
    } | {
      readonly "type": never
      readonly "id": string
      readonly "status": "completed" | "in_progress" | "failed"
      readonly "result"?: string
    } | {
      readonly "type": never
      readonly "id": string
      readonly "queries": ReadonlyArray<string>
      readonly "status": "completed" | "in_progress" | "failed"
      readonly "result"?: string
    } | {
      readonly "type": "image_generation_call"
      readonly "id": string
      readonly "result"?: string
      readonly "status": "in_progress" | "completed" | "generating" | "failed"
    }
  >
  readonly "user"?: string
  readonly "output_text"?: string
  readonly "prompt_cache_key"?: string
  readonly "safety_identifier"?: string
  readonly "error": ResponsesErrorField
  readonly "incomplete_details": OpenAIResponsesIncompleteDetails
  readonly "usage"?: {
    readonly "input_tokens": number
    readonly "input_tokens_details": { readonly "cached_tokens": number }
    readonly "output_tokens": number
    readonly "output_tokens_details": { readonly "reasoning_tokens": number }
    readonly "total_tokens": number
    readonly "cost"?: number
    readonly "is_byok"?: boolean
    readonly "cost_details"?: {
      readonly "upstream_inference_cost"?: number
      readonly "upstream_inference_input_cost": number
      readonly "upstream_inference_output_cost": number
    }
  }
  readonly "max_tool_calls"?: number
  readonly "top_logprobs"?: number
  readonly "max_output_tokens"?: number
  readonly "temperature": number
  readonly "top_p": number
  readonly "presence_penalty": number
  readonly "frequency_penalty": number
  readonly "instructions": OpenAIResponsesInput
  readonly "metadata": OpenResponsesRequestMetadata
  readonly "tools": ReadonlyArray<
    | {
      readonly "type": "function"
      readonly "name": string
      readonly "description"?: string
      readonly "strict"?: boolean
      readonly "parameters": {}
    }
    | OpenResponsesWebSearchPreviewTool
    | OpenResponsesWebSearchPreview20250311Tool
    | OpenResponsesWebSearchTool
    | OpenResponsesWebSearch20250826Tool
  >
  readonly "tool_choice": OpenAIResponsesToolChoice
  readonly "parallel_tool_calls": boolean
  readonly "prompt"?: OpenAIResponsesPrompt
  readonly "background"?: boolean
  readonly "previous_response_id"?: string
  readonly "reasoning"?: OpenAIResponsesReasoningConfig
  readonly "service_tier"?: OpenAIResponsesServiceTier
  readonly "store"?: boolean
  readonly "truncation"?: OpenAIResponsesTruncation
  readonly "text"?: ResponseTextConfig
}
export const OpenResponsesNonStreamingResponse = Schema.Struct({
  "id": Schema.String,
  "object": Schema.Literal("response"),
  "created_at": Schema.Number.check(Schema.isFinite()),
  "model": Schema.String,
  "status": OpenAIResponsesResponseStatus,
  "completed_at": Schema.Number.check(Schema.isFinite()),
  "output": Schema.Array(Schema.Union([
    Schema.Union([
      Schema.Struct({
        "id": Schema.String,
        "role": Schema.Literal("assistant"),
        "type": Schema.Literal("message"),
        "status": Schema.optionalKey(
          Schema.Union([Schema.Literal("completed"), Schema.Literal("incomplete"), Schema.Literal("in_progress")])
        ),
        "content": Schema.Array(Schema.Union([
          Schema.Union([
            Schema.Struct({
              "type": Schema.Literal("output_text"),
              "text": Schema.String,
              "annotations": Schema.optionalKey(
                Schema.Array(
                  Schema.Union([
                    Schema.Union([
                      Schema.Struct({
                        "type": Schema.Literal("file_citation"),
                        "file_id": Schema.String,
                        "filename": Schema.String,
                        "index": Schema.Number.check(Schema.isFinite())
                      }),
                      Schema.Struct({
                        "type": Schema.Never,
                        "url": Schema.String,
                        "title": Schema.String,
                        "start_index": Schema.Number.check(Schema.isFinite()),
                        "end_index": Schema.Number.check(Schema.isFinite()),
                        "file_id": Schema.String,
                        "filename": Schema.String,
                        "index": Schema.Number.check(Schema.isFinite())
                      }),
                      Schema.Struct({
                        "type": Schema.Never,
                        "file_id": Schema.String,
                        "index": Schema.Number.check(Schema.isFinite()),
                        "filename": Schema.String
                      })
                    ]),
                    Schema.Union([
                      Schema.Struct({
                        "type": Schema.Never,
                        "file_id": Schema.String,
                        "filename": Schema.String,
                        "index": Schema.Number.check(Schema.isFinite()),
                        "url": Schema.String,
                        "title": Schema.String,
                        "start_index": Schema.Number.check(Schema.isFinite()),
                        "end_index": Schema.Number.check(Schema.isFinite())
                      }),
                      Schema.Struct({
                        "type": Schema.Literal("url_citation"),
                        "url": Schema.String,
                        "title": Schema.String,
                        "start_index": Schema.Number.check(Schema.isFinite()),
                        "end_index": Schema.Number.check(Schema.isFinite())
                      }),
                      Schema.Struct({
                        "type": Schema.Never,
                        "file_id": Schema.String,
                        "index": Schema.Number.check(Schema.isFinite()),
                        "url": Schema.String,
                        "title": Schema.String,
                        "start_index": Schema.Number.check(Schema.isFinite()),
                        "end_index": Schema.Number.check(Schema.isFinite())
                      })
                    ]),
                    Schema.Union([
                      Schema.Struct({
                        "type": Schema.Never,
                        "file_id": Schema.String,
                        "filename": Schema.String,
                        "index": Schema.Number.check(Schema.isFinite())
                      }),
                      Schema.Struct({
                        "type": Schema.Never,
                        "url": Schema.String,
                        "title": Schema.String,
                        "start_index": Schema.Number.check(Schema.isFinite()),
                        "end_index": Schema.Number.check(Schema.isFinite()),
                        "file_id": Schema.String,
                        "index": Schema.Number.check(Schema.isFinite())
                      }),
                      Schema.Struct({
                        "type": Schema.Literal("file_path"),
                        "file_id": Schema.String,
                        "index": Schema.Number.check(Schema.isFinite())
                      })
                    ])
                  ])
                )
              ),
              "logprobs": Schema.optionalKey(Schema.Array(Schema.Struct({
                "token": Schema.String,
                "bytes": Schema.Array(Schema.Number.check(Schema.isFinite())),
                "logprob": Schema.Number.check(Schema.isFinite()),
                "top_logprobs": Schema.Array(
                  Schema.Struct({
                    "token": Schema.String,
                    "bytes": Schema.Array(Schema.Number.check(Schema.isFinite())),
                    "logprob": Schema.Number.check(Schema.isFinite())
                  })
                )
              })))
            }),
            Schema.Struct({
              "type": Schema.Never,
              "refusal": Schema.String,
              "text": Schema.String,
              "annotations": Schema.optionalKey(Schema.Array(OpenAIResponsesAnnotation)),
              "logprobs": Schema.optionalKey(Schema.Array(Schema.Struct({
                "token": Schema.String,
                "bytes": Schema.Array(Schema.Number.check(Schema.isFinite())),
                "logprob": Schema.Number.check(Schema.isFinite()),
                "top_logprobs": Schema.Array(
                  Schema.Struct({
                    "token": Schema.String,
                    "bytes": Schema.Array(Schema.Number.check(Schema.isFinite())),
                    "logprob": Schema.Number.check(Schema.isFinite())
                  })
                )
              })))
            })
          ]),
          Schema.Union([
            Schema.Struct({
              "type": Schema.Never,
              "text": Schema.String,
              "annotations": Schema.optionalKey(Schema.Array(OpenAIResponsesAnnotation)),
              "logprobs": Schema.optionalKey(Schema.Array(Schema.Struct({
                "token": Schema.String,
                "bytes": Schema.Array(Schema.Number.check(Schema.isFinite())),
                "logprob": Schema.Number.check(Schema.isFinite()),
                "top_logprobs": Schema.Array(
                  Schema.Struct({
                    "token": Schema.String,
                    "bytes": Schema.Array(Schema.Number.check(Schema.isFinite())),
                    "logprob": Schema.Number.check(Schema.isFinite())
                  })
                )
              }))),
              "refusal": Schema.String
            }),
            Schema.Struct({ "type": Schema.Literal("refusal"), "refusal": Schema.String })
          ])
        ]))
      }).annotate({ "description": "An output message item" }),
      Schema.Struct({
        "type": Schema.Never,
        "id": Schema.String,
        "content": Schema.Array(Schema.Union([
          Schema.Struct({
            "type": Schema.Never,
            "text": Schema.String,
            "annotations": Schema.optionalKey(Schema.Array(OpenAIResponsesAnnotation)),
            "logprobs": Schema.optionalKey(Schema.Array(Schema.Struct({
              "token": Schema.String,
              "bytes": Schema.Array(Schema.Number.check(Schema.isFinite())),
              "logprob": Schema.Number.check(Schema.isFinite()),
              "top_logprobs": Schema.Array(
                Schema.Struct({
                  "token": Schema.String,
                  "bytes": Schema.Array(Schema.Number.check(Schema.isFinite())),
                  "logprob": Schema.Number.check(Schema.isFinite())
                })
              )
            })))
          }),
          Schema.Struct({ "type": Schema.Never, "refusal": Schema.String, "text": Schema.String })
        ])),
        "summary": Schema.Array(ReasoningSummaryText),
        "encrypted_content": Schema.optionalKey(Schema.String),
        "status": Schema.optionalKey(
          Schema.Union([Schema.Literal("completed"), Schema.Literal("incomplete"), Schema.Literal("in_progress")])
        ),
        "signature": Schema.optionalKey(
          Schema.String.annotate({ "description": "A signature for the reasoning content, used for verification" })
        ),
        "format": Schema.optionalKey(
          Schema.Literals([
            "unknown",
            "openai-responses-v1",
            "azure-openai-responses-v1",
            "xai-responses-v1",
            "anthropic-claude-v1",
            "google-gemini-v1"
          ]).annotate({ "description": "The format of the reasoning content" })
        ),
        "role": Schema.Literal("assistant")
      }).annotate({ "description": "An output item containing reasoning" }),
      Schema.Struct({
        "type": Schema.Never,
        "id": Schema.String,
        "name": Schema.String,
        "arguments": Schema.String,
        "call_id": Schema.String,
        "status": Schema.optionalKey(
          Schema.Union([Schema.Literal("completed"), Schema.Literal("incomplete"), Schema.Literal("in_progress")])
        ),
        "role": Schema.Literal("assistant"),
        "content": Schema.Array(Schema.Union([ResponseOutputText, OpenAIResponsesRefusalContent]))
      }),
      Schema.Struct({
        "type": Schema.Never,
        "id": Schema.String,
        "status": Schema.Union([Schema.Literal("completed"), Schema.Literal("in_progress")]),
        "role": Schema.Literal("assistant"),
        "content": Schema.Array(Schema.Union([ResponseOutputText, OpenAIResponsesRefusalContent]))
      }),
      Schema.Struct({
        "type": Schema.Never,
        "id": Schema.String,
        "queries": Schema.Array(Schema.String),
        "status": Schema.Union([Schema.Literal("completed"), Schema.Literal("in_progress")]),
        "role": Schema.Literal("assistant"),
        "content": Schema.Array(Schema.Union([ResponseOutputText, OpenAIResponsesRefusalContent]))
      }),
      Schema.Struct({
        "type": Schema.Never,
        "id": Schema.String,
        "result": Schema.optionalKey(Schema.String),
        "status": Schema.Union([Schema.Literal("in_progress"), Schema.Literal("completed")]),
        "role": Schema.Literal("assistant"),
        "content": Schema.Array(Schema.Union([ResponseOutputText, OpenAIResponsesRefusalContent]))
      })
    ]).annotate({ "description": "An output item from the response" }),
    Schema.Union([
      Schema.Struct({
        "id": Schema.String,
        "role": Schema.Literal("assistant"),
        "type": Schema.Never,
        "status": Schema.optionalKey(
          Schema.Union([Schema.Literal("completed"), Schema.Literal("incomplete"), Schema.Literal("in_progress")])
        ),
        "content": Schema.Array(Schema.Union([
          Schema.Struct({
            "type": Schema.Never,
            "text": Schema.String,
            "annotations": Schema.optionalKey(Schema.Array(OpenAIResponsesAnnotation)),
            "logprobs": Schema.optionalKey(Schema.Array(Schema.Struct({
              "token": Schema.String,
              "bytes": Schema.Array(Schema.Number.check(Schema.isFinite())),
              "logprob": Schema.Number.check(Schema.isFinite()),
              "top_logprobs": Schema.Array(
                Schema.Struct({
                  "token": Schema.String,
                  "bytes": Schema.Array(Schema.Number.check(Schema.isFinite())),
                  "logprob": Schema.Number.check(Schema.isFinite())
                })
              )
            })))
          }),
          Schema.Struct({ "type": Schema.Never, "refusal": Schema.String, "text": Schema.String })
        ])),
        "summary": Schema.Array(ReasoningSummaryText),
        "encrypted_content": Schema.optionalKey(Schema.String)
      }).annotate({ "description": "An output message item" }),
      Schema.Struct({
        "type": Schema.Literal("reasoning"),
        "id": Schema.String,
        "content": Schema.optionalKey(
          Schema.Array(Schema.Struct({ "type": Schema.Literal("reasoning_text"), "text": Schema.String }))
        ),
        "summary": Schema.Array(Schema.Struct({ "type": Schema.Literal("summary_text"), "text": Schema.String })),
        "encrypted_content": Schema.optionalKey(Schema.String),
        "status": Schema.optionalKey(
          Schema.Union([Schema.Literal("completed"), Schema.Literal("incomplete"), Schema.Literal("in_progress")])
        ),
        "signature": Schema.optionalKey(
          Schema.String.annotate({ "description": "A signature for the reasoning content, used for verification" })
        ),
        "format": Schema.optionalKey(
          Schema.Literals([
            "unknown",
            "openai-responses-v1",
            "azure-openai-responses-v1",
            "xai-responses-v1",
            "anthropic-claude-v1",
            "google-gemini-v1"
          ]).annotate({ "description": "The format of the reasoning content" })
        )
      }).annotate({ "description": "An output item containing reasoning" }),
      Schema.Struct({
        "type": Schema.Never,
        "id": Schema.String,
        "name": Schema.String,
        "arguments": Schema.String,
        "call_id": Schema.String,
        "status": Schema.optionalKey(
          Schema.Union([Schema.Literal("completed"), Schema.Literal("incomplete"), Schema.Literal("in_progress")])
        ),
        "content": Schema.optionalKey(Schema.Array(ReasoningTextContent)),
        "summary": Schema.Array(ReasoningSummaryText),
        "encrypted_content": Schema.optionalKey(Schema.String)
      }),
      Schema.Struct({
        "type": Schema.Never,
        "id": Schema.String,
        "status": Schema.Union([Schema.Literal("completed"), Schema.Literal("in_progress")]),
        "content": Schema.optionalKey(Schema.Array(ReasoningTextContent)),
        "summary": Schema.Array(ReasoningSummaryText),
        "encrypted_content": Schema.optionalKey(Schema.String)
      }),
      Schema.Struct({
        "type": Schema.Never,
        "id": Schema.String,
        "queries": Schema.Array(Schema.String),
        "status": Schema.Union([Schema.Literal("completed"), Schema.Literal("in_progress")]),
        "content": Schema.optionalKey(Schema.Array(ReasoningTextContent)),
        "summary": Schema.Array(ReasoningSummaryText),
        "encrypted_content": Schema.optionalKey(Schema.String)
      }),
      Schema.Struct({
        "type": Schema.Never,
        "id": Schema.String,
        "result": Schema.optionalKey(Schema.String),
        "status": Schema.Union([Schema.Literal("in_progress"), Schema.Literal("completed")]),
        "content": Schema.optionalKey(Schema.Array(ReasoningTextContent)),
        "summary": Schema.Array(ReasoningSummaryText),
        "encrypted_content": Schema.optionalKey(Schema.String)
      })
    ]).annotate({ "description": "An output item from the response" }),
    Schema.Union([
      Schema.Struct({
        "id": Schema.String,
        "role": Schema.Literal("assistant"),
        "type": Schema.Never,
        "status": Schema.optionalKey(
          Schema.Union([Schema.Literal("completed"), Schema.Literal("incomplete"), Schema.Literal("in_progress")])
        ),
        "content": Schema.Array(Schema.Union([ResponseOutputText, OpenAIResponsesRefusalContent])),
        "name": Schema.String,
        "arguments": Schema.String,
        "call_id": Schema.String
      }).annotate({ "description": "An output message item" }),
      Schema.Struct({
        "type": Schema.Never,
        "id": Schema.String,
        "content": Schema.optionalKey(Schema.Array(ReasoningTextContent)),
        "summary": Schema.Array(ReasoningSummaryText),
        "encrypted_content": Schema.optionalKey(Schema.String),
        "status": Schema.optionalKey(
          Schema.Union([Schema.Literal("completed"), Schema.Literal("incomplete"), Schema.Literal("in_progress")])
        ),
        "signature": Schema.optionalKey(
          Schema.String.annotate({ "description": "A signature for the reasoning content, used for verification" })
        ),
        "format": Schema.optionalKey(
          Schema.Literals([
            "unknown",
            "openai-responses-v1",
            "azure-openai-responses-v1",
            "xai-responses-v1",
            "anthropic-claude-v1",
            "google-gemini-v1"
          ]).annotate({ "description": "The format of the reasoning content" })
        ),
        "name": Schema.String,
        "arguments": Schema.String,
        "call_id": Schema.String
      }).annotate({ "description": "An output item containing reasoning" }),
      Schema.Struct({
        "type": Schema.Literal("function_call"),
        "id": Schema.optionalKey(Schema.String),
        "name": Schema.String,
        "arguments": Schema.String,
        "call_id": Schema.String,
        "status": Schema.optionalKey(
          Schema.Union([Schema.Literal("completed"), Schema.Literal("incomplete"), Schema.Literal("in_progress")])
        )
      }),
      Schema.Struct({
        "type": Schema.Never,
        "id": Schema.String,
        "status": Schema.Union([Schema.Literal("completed"), Schema.Literal("in_progress")]),
        "name": Schema.String,
        "arguments": Schema.String,
        "call_id": Schema.String
      }),
      Schema.Struct({
        "type": Schema.Never,
        "id": Schema.String,
        "queries": Schema.Array(Schema.String),
        "status": Schema.Union([Schema.Literal("completed"), Schema.Literal("in_progress")]),
        "name": Schema.String,
        "arguments": Schema.String,
        "call_id": Schema.String
      }),
      Schema.Struct({
        "type": Schema.Never,
        "id": Schema.String,
        "result": Schema.optionalKey(Schema.String),
        "status": Schema.Union([Schema.Literal("in_progress"), Schema.Literal("completed")]),
        "name": Schema.String,
        "arguments": Schema.String,
        "call_id": Schema.String
      })
    ]).annotate({ "description": "An output item from the response" }),
    Schema.Union([
      Schema.Struct({
        "id": Schema.String,
        "role": Schema.Literal("assistant"),
        "type": Schema.Never,
        "status": Schema.Union([Schema.Literal("completed"), Schema.Literal("in_progress")]),
        "content": Schema.Array(Schema.Union([ResponseOutputText, OpenAIResponsesRefusalContent]))
      }).annotate({ "description": "An output message item" }),
      Schema.Struct({
        "type": Schema.Never,
        "id": Schema.String,
        "content": Schema.optionalKey(Schema.Array(ReasoningTextContent)),
        "summary": Schema.Array(ReasoningSummaryText),
        "encrypted_content": Schema.optionalKey(Schema.String),
        "status": Schema.Union([Schema.Literal("completed"), Schema.Literal("in_progress")]),
        "signature": Schema.optionalKey(
          Schema.String.annotate({ "description": "A signature for the reasoning content, used for verification" })
        ),
        "format": Schema.optionalKey(
          Schema.Literals([
            "unknown",
            "openai-responses-v1",
            "azure-openai-responses-v1",
            "xai-responses-v1",
            "anthropic-claude-v1",
            "google-gemini-v1"
          ]).annotate({ "description": "The format of the reasoning content" })
        )
      }).annotate({ "description": "An output item containing reasoning" }),
      Schema.Struct({
        "type": Schema.Never,
        "id": Schema.String,
        "name": Schema.String,
        "arguments": Schema.String,
        "call_id": Schema.String,
        "status": Schema.Union([Schema.Literal("completed"), Schema.Literal("in_progress")])
      }),
      Schema.Struct({
        "type": Schema.Literal("web_search_call"),
        "id": Schema.String,
        "status": Schema.Union([
          Schema.Literal("completed"),
          Schema.Literal("searching"),
          Schema.Literal("in_progress"),
          Schema.Literal("failed")
        ])
      }),
      Schema.Struct({
        "type": Schema.Never,
        "id": Schema.String,
        "queries": Schema.Array(Schema.String),
        "status": Schema.Union([
          Schema.Literal("completed"),
          Schema.Literal("searching"),
          Schema.Literal("in_progress"),
          Schema.Literal("failed")
        ])
      }),
      Schema.Struct({
        "type": Schema.Never,
        "id": Schema.String,
        "result": Schema.optionalKey(Schema.String),
        "status": Schema.Union([Schema.Literal("in_progress"), Schema.Literal("completed"), Schema.Literal("failed")])
      })
    ]).annotate({ "description": "An output item from the response" }),
    Schema.Union([
      Schema.Struct({
        "id": Schema.String,
        "role": Schema.Literal("assistant"),
        "type": Schema.Never,
        "status": Schema.Union([Schema.Literal("completed"), Schema.Literal("in_progress")]),
        "content": Schema.Array(Schema.Union([ResponseOutputText, OpenAIResponsesRefusalContent])),
        "queries": Schema.Array(Schema.String)
      }).annotate({ "description": "An output message item" }),
      Schema.Struct({
        "type": Schema.Never,
        "id": Schema.String,
        "content": Schema.optionalKey(Schema.Array(ReasoningTextContent)),
        "summary": Schema.Array(ReasoningSummaryText),
        "encrypted_content": Schema.optionalKey(Schema.String),
        "status": Schema.Union([Schema.Literal("completed"), Schema.Literal("in_progress")]),
        "signature": Schema.optionalKey(
          Schema.String.annotate({ "description": "A signature for the reasoning content, used for verification" })
        ),
        "format": Schema.optionalKey(
          Schema.Literals([
            "unknown",
            "openai-responses-v1",
            "azure-openai-responses-v1",
            "xai-responses-v1",
            "anthropic-claude-v1",
            "google-gemini-v1"
          ]).annotate({ "description": "The format of the reasoning content" })
        ),
        "queries": Schema.Array(Schema.String)
      }).annotate({ "description": "An output item containing reasoning" }),
      Schema.Struct({
        "type": Schema.Never,
        "id": Schema.String,
        "name": Schema.String,
        "arguments": Schema.String,
        "call_id": Schema.String,
        "status": Schema.Union([Schema.Literal("completed"), Schema.Literal("in_progress")]),
        "queries": Schema.Array(Schema.String)
      }),
      Schema.Struct({
        "type": Schema.Never,
        "id": Schema.String,
        "status": Schema.Union([
          Schema.Literal("completed"),
          Schema.Literal("searching"),
          Schema.Literal("in_progress"),
          Schema.Literal("failed")
        ]),
        "queries": Schema.Array(Schema.String)
      }),
      Schema.Struct({
        "type": Schema.Literal("file_search_call"),
        "id": Schema.String,
        "queries": Schema.Array(Schema.String),
        "status": Schema.Union([
          Schema.Literal("completed"),
          Schema.Literal("searching"),
          Schema.Literal("in_progress"),
          Schema.Literal("failed")
        ])
      }),
      Schema.Struct({
        "type": Schema.Never,
        "id": Schema.String,
        "result": Schema.optionalKey(Schema.String),
        "status": Schema.Union([Schema.Literal("in_progress"), Schema.Literal("completed"), Schema.Literal("failed")]),
        "queries": Schema.Array(Schema.String)
      })
    ]).annotate({ "description": "An output item from the response" }),
    Schema.Union([
      Schema.Struct({
        "id": Schema.String,
        "role": Schema.Literal("assistant"),
        "type": Schema.Never,
        "status": Schema.Union([Schema.Literal("completed"), Schema.Literal("in_progress")]),
        "content": Schema.Array(Schema.Union([ResponseOutputText, OpenAIResponsesRefusalContent])),
        "result": Schema.optionalKey(Schema.String)
      }).annotate({ "description": "An output message item" }),
      Schema.Struct({
        "type": Schema.Never,
        "id": Schema.String,
        "content": Schema.optionalKey(Schema.Array(ReasoningTextContent)),
        "summary": Schema.Array(ReasoningSummaryText),
        "encrypted_content": Schema.optionalKey(Schema.String),
        "status": Schema.Union([Schema.Literal("completed"), Schema.Literal("in_progress")]),
        "signature": Schema.optionalKey(
          Schema.String.annotate({ "description": "A signature for the reasoning content, used for verification" })
        ),
        "format": Schema.optionalKey(
          Schema.Literals([
            "unknown",
            "openai-responses-v1",
            "azure-openai-responses-v1",
            "xai-responses-v1",
            "anthropic-claude-v1",
            "google-gemini-v1"
          ]).annotate({ "description": "The format of the reasoning content" })
        ),
        "result": Schema.optionalKey(Schema.String)
      }).annotate({ "description": "An output item containing reasoning" }),
      Schema.Struct({
        "type": Schema.Never,
        "id": Schema.String,
        "name": Schema.String,
        "arguments": Schema.String,
        "call_id": Schema.String,
        "status": Schema.Union([Schema.Literal("completed"), Schema.Literal("in_progress")]),
        "result": Schema.optionalKey(Schema.String)
      }),
      Schema.Struct({
        "type": Schema.Never,
        "id": Schema.String,
        "status": Schema.Union([Schema.Literal("completed"), Schema.Literal("in_progress"), Schema.Literal("failed")]),
        "result": Schema.optionalKey(Schema.String)
      }),
      Schema.Struct({
        "type": Schema.Never,
        "id": Schema.String,
        "queries": Schema.Array(Schema.String),
        "status": Schema.Union([Schema.Literal("completed"), Schema.Literal("in_progress"), Schema.Literal("failed")]),
        "result": Schema.optionalKey(Schema.String)
      }),
      Schema.Struct({
        "type": Schema.Literal("image_generation_call"),
        "id": Schema.String,
        "result": Schema.optionalKey(Schema.String),
        "status": Schema.Union([
          Schema.Literal("in_progress"),
          Schema.Literal("completed"),
          Schema.Literal("generating"),
          Schema.Literal("failed")
        ])
      })
    ]).annotate({ "description": "An output item from the response" })
  ])),
  "user": Schema.optionalKey(Schema.String),
  "output_text": Schema.optionalKey(Schema.String),
  "prompt_cache_key": Schema.optionalKey(Schema.String),
  "safety_identifier": Schema.optionalKey(Schema.String),
  "error": ResponsesErrorField,
  "incomplete_details": OpenAIResponsesIncompleteDetails,
  "usage": Schema.optionalKey(
    Schema.Struct({
      "input_tokens": Schema.Number.check(Schema.isFinite()),
      "input_tokens_details": Schema.Struct({ "cached_tokens": Schema.Number.check(Schema.isFinite()) }),
      "output_tokens": Schema.Number.check(Schema.isFinite()),
      "output_tokens_details": Schema.Struct({ "reasoning_tokens": Schema.Number.check(Schema.isFinite()) }),
      "total_tokens": Schema.Number.check(Schema.isFinite()),
      "cost": Schema.optionalKey(
        Schema.Number.annotate({ "description": "Cost of the completion" }).check(Schema.isFinite())
      ),
      "is_byok": Schema.optionalKey(
        Schema.Boolean.annotate({
          "description": "Whether a request was made using a Bring Your Own Key configuration"
        })
      ),
      "cost_details": Schema.optionalKey(
        Schema.Struct({
          "upstream_inference_cost": Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
          "upstream_inference_input_cost": Schema.Number.check(Schema.isFinite()),
          "upstream_inference_output_cost": Schema.Number.check(Schema.isFinite())
        })
      )
    }).annotate({ "description": "Token usage information for the response" })
  ),
  "max_tool_calls": Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
  "top_logprobs": Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
  "max_output_tokens": Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
  "temperature": Schema.Number.check(Schema.isFinite()),
  "top_p": Schema.Number.check(Schema.isFinite()),
  "presence_penalty": Schema.Number.check(Schema.isFinite()),
  "frequency_penalty": Schema.Number.check(Schema.isFinite()),
  "instructions": OpenAIResponsesInput,
  "metadata": OpenResponsesRequestMetadata,
  "tools": Schema.Array(
    Schema.Union([
      Schema.Struct({
        "type": Schema.Literal("function"),
        "name": Schema.String,
        "description": Schema.optionalKey(Schema.String),
        "strict": Schema.optionalKey(Schema.Boolean),
        "parameters": Schema.Struct({})
      }).annotate({ "description": "Function tool definition" }),
      OpenResponsesWebSearchPreviewTool,
      OpenResponsesWebSearchPreview20250311Tool,
      OpenResponsesWebSearchTool,
      OpenResponsesWebSearch20250826Tool
    ], { mode: "oneOf" })
  ),
  "tool_choice": OpenAIResponsesToolChoice,
  "parallel_tool_calls": Schema.Boolean,
  "prompt": Schema.optionalKey(OpenAIResponsesPrompt),
  "background": Schema.optionalKey(Schema.Boolean),
  "previous_response_id": Schema.optionalKey(Schema.String),
  "reasoning": Schema.optionalKey(OpenAIResponsesReasoningConfig),
  "service_tier": Schema.optionalKey(OpenAIResponsesServiceTier),
  "store": Schema.optionalKey(Schema.Boolean),
  "truncation": Schema.optionalKey(OpenAIResponsesTruncation),
  "text": Schema.optionalKey(ResponseTextConfig)
}).annotate({ "description": "Complete non-streaming response from the Responses API" })
export type OpenResponsesRequest = {
  readonly "input"?: OpenResponsesInput
  readonly "instructions"?: string
  readonly "metadata"?: OpenResponsesRequestMetadata
  readonly "tools"?: ReadonlyArray<
    | {
      readonly "type": "function"
      readonly "name": string
      readonly "description"?: string
      readonly "strict"?: boolean
      readonly "parameters": {}
    }
    | OpenResponsesWebSearchPreviewTool
    | OpenResponsesWebSearchPreview20250311Tool
    | OpenResponsesWebSearchTool
    | OpenResponsesWebSearch20250826Tool
  >
  readonly "tool_choice"?: OpenAIResponsesToolChoice
  readonly "parallel_tool_calls"?: boolean
  readonly "model"?: string
  readonly "models"?: ReadonlyArray<string>
  readonly "text"?: OpenResponsesResponseText
  readonly "reasoning"?: OpenResponsesReasoningConfig
  readonly "max_output_tokens"?: number
  readonly "temperature"?: number
  readonly "top_p"?: number
  readonly "top_logprobs"?: number
  readonly "max_tool_calls"?: number
  readonly "presence_penalty"?: number
  readonly "frequency_penalty"?: number
  readonly "top_k"?: number
  readonly "image_config"?: {}
  readonly "modalities"?: ReadonlyArray<ResponsesOutputModality>
  readonly "prompt_cache_key"?: string
  readonly "previous_response_id"?: string
  readonly "prompt"?: OpenAIResponsesPrompt
  readonly "include"?: ReadonlyArray<OpenAIResponsesIncludable>
  readonly "background"?: boolean
  readonly "safety_identifier"?: string
  readonly "store"?: false
  readonly "service_tier"?: "auto"
  readonly "truncation"?: "auto" | "disabled"
  readonly "stream"?: boolean
  readonly "provider"?: {
    readonly "allow_fallbacks"?: boolean
    readonly "require_parameters"?: boolean
    readonly "data_collection"?: DataCollection
    readonly "zdr"?: boolean
    readonly "enforce_distillable_text"?: boolean
    readonly "order"?: ReadonlyArray<ProviderName | string>
    readonly "only"?: ReadonlyArray<ProviderName | string>
    readonly "ignore"?: ReadonlyArray<ProviderName | string>
    readonly "quantizations"?: ReadonlyArray<Quantization>
    readonly "sort"?: ProviderSort | ProviderSortConfig | unknown
    readonly "max_price"?: {
      readonly "prompt"?: BigNumberUnion
      readonly "completion"?: string
      readonly "image"?: string
      readonly "audio"?: string
      readonly "request"?: string
    }
    readonly "preferred_min_throughput"?: PreferredMinThroughput
    readonly "preferred_max_latency"?: PreferredMaxLatency
  }
  readonly "plugins"?: ReadonlyArray<
    | { readonly "id": "auto-router"; readonly "enabled"?: boolean; readonly "allowed_models"?: ReadonlyArray<string> }
    | { readonly "id": "moderation" }
    | {
      readonly "id": "web"
      readonly "enabled"?: boolean
      readonly "max_results"?: number
      readonly "search_prompt"?: string
      readonly "engine"?: WebSearchEngine
    }
    | { readonly "id": "file-parser"; readonly "enabled"?: boolean; readonly "pdf"?: PDFParserOptions }
    | { readonly "id": "response-healing"; readonly "enabled"?: boolean }
  >
  readonly "route"?: "fallback" | "sort"
  readonly "user"?: string
  readonly "session_id"?: string
  readonly "trace"?: {
    readonly "trace_id"?: string
    readonly "trace_name"?: string
    readonly "span_name"?: string
    readonly "generation_name"?: string
    readonly "parent_span_id"?: string
  }
}
export const OpenResponsesRequest = Schema.Struct({
  "input": Schema.optionalKey(OpenResponsesInput),
  "instructions": Schema.optionalKey(Schema.String),
  "metadata": Schema.optionalKey(OpenResponsesRequestMetadata),
  "tools": Schema.optionalKey(
    Schema.Array(
      Schema.Union([
        Schema.Struct({
          "type": Schema.Literal("function"),
          "name": Schema.String,
          "description": Schema.optionalKey(Schema.String),
          "strict": Schema.optionalKey(Schema.Boolean),
          "parameters": Schema.Struct({})
        }).annotate({ "description": "Function tool definition" }),
        OpenResponsesWebSearchPreviewTool,
        OpenResponsesWebSearchPreview20250311Tool,
        OpenResponsesWebSearchTool,
        OpenResponsesWebSearch20250826Tool
      ], { mode: "oneOf" })
    )
  ),
  "tool_choice": Schema.optionalKey(OpenAIResponsesToolChoice),
  "parallel_tool_calls": Schema.optionalKey(Schema.Boolean),
  "model": Schema.optionalKey(Schema.String),
  "models": Schema.optionalKey(Schema.Array(Schema.String)),
  "text": Schema.optionalKey(OpenResponsesResponseText),
  "reasoning": Schema.optionalKey(OpenResponsesReasoningConfig),
  "max_output_tokens": Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
  "temperature": Schema.optionalKey(
    Schema.Number.check(Schema.isFinite()).check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(2))
  ),
  "top_p": Schema.optionalKey(Schema.Number.check(Schema.isFinite()).check(Schema.isGreaterThanOrEqualTo(0))),
  "top_logprobs": Schema.optionalKey(
    Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(20))
  ),
  "max_tool_calls": Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  "presence_penalty": Schema.optionalKey(
    Schema.Number.check(Schema.isFinite()).check(Schema.isGreaterThanOrEqualTo(-2)).check(Schema.isLessThanOrEqualTo(2))
  ),
  "frequency_penalty": Schema.optionalKey(
    Schema.Number.check(Schema.isFinite()).check(Schema.isGreaterThanOrEqualTo(-2)).check(Schema.isLessThanOrEqualTo(2))
  ),
  "top_k": Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
  "image_config": Schema.optionalKey(
    Schema.Struct({}).annotate({
      "description":
        "Provider-specific image configuration options. Keys and values vary by model/provider. See https://openrouter.ai/docs/features/multimodal/image-generation for more details."
    })
  ),
  "modalities": Schema.optionalKey(
    Schema.Array(ResponsesOutputModality).annotate({
      "description": "Output modalities for the response. Supported values are \"text\" and \"image\"."
    })
  ),
  "prompt_cache_key": Schema.optionalKey(Schema.String),
  "previous_response_id": Schema.optionalKey(Schema.String),
  "prompt": Schema.optionalKey(OpenAIResponsesPrompt),
  "include": Schema.optionalKey(Schema.Array(OpenAIResponsesIncludable)),
  "background": Schema.optionalKey(Schema.Boolean),
  "safety_identifier": Schema.optionalKey(Schema.String),
  "store": Schema.optionalKey(Schema.Literal(false)),
  "service_tier": Schema.optionalKey(Schema.Literal("auto")),
  "truncation": Schema.optionalKey(Schema.Literals(["auto", "disabled"])),
  "stream": Schema.optionalKey(Schema.Boolean),
  "provider": Schema.optionalKey(
    Schema.Struct({
      "allow_fallbacks": Schema.optionalKey(Schema.Boolean.annotate({
        "description":
          "Whether to allow backup providers to serve requests\n- true: (default) when the primary provider (or your custom providers in \"order\") is unavailable, use the next best provider.\n- false: use only the primary/custom provider, and return the upstream error if it's unavailable.\n"
      })),
      "require_parameters": Schema.optionalKey(
        Schema.Boolean.annotate({
          "description":
            "Whether to filter providers to only those that support the parameters you've provided. If this setting is omitted or set to false, then providers will receive only the parameters they support, and ignore the rest."
        })
      ),
      "data_collection": Schema.optionalKey(DataCollection),
      "zdr": Schema.optionalKey(
        Schema.Boolean.annotate({
          "description":
            "Whether to restrict routing to only ZDR (Zero Data Retention) endpoints. When true, only endpoints that do not retain prompts will be used."
        })
      ),
      "enforce_distillable_text": Schema.optionalKey(
        Schema.Boolean.annotate({
          "description":
            "Whether to restrict routing to only models that allow text distillation. When true, only models where the author has allowed distillation will be used."
        })
      ),
      "order": Schema.optionalKey(
        Schema.Array(Schema.Union([ProviderName, Schema.String])).annotate({
          "description":
            "An ordered list of provider slugs. The router will attempt to use the first provider in the subset of this list that supports your requested model, and fall back to the next if it is unavailable. If no providers are available, the request will fail with an error message."
        })
      ),
      "only": Schema.optionalKey(
        Schema.Array(Schema.Union([ProviderName, Schema.String])).annotate({
          "description":
            "List of provider slugs to allow. If provided, this list is merged with your account-wide allowed provider settings for this request."
        })
      ),
      "ignore": Schema.optionalKey(
        Schema.Array(Schema.Union([ProviderName, Schema.String])).annotate({
          "description":
            "List of provider slugs to ignore. If provided, this list is merged with your account-wide ignored provider settings for this request."
        })
      ),
      "quantizations": Schema.optionalKey(
        Schema.Array(Quantization).annotate({
          "description": "A list of quantization levels to filter the provider by."
        })
      ),
      "sort": Schema.optionalKey(
        Schema.Union([ProviderSort, ProviderSortConfig, Schema.Unknown]).annotate({
          "description":
            "The sorting strategy to use for this request, if \"order\" is not specified. When set, no load balancing is performed."
        })
      ),
      "max_price": Schema.optionalKey(
        Schema.Struct({
          "prompt": Schema.optionalKey(BigNumberUnion),
          "completion": Schema.optionalKey(
            Schema.String.annotate({ "description": "Price per million completion tokens" })
          ),
          "image": Schema.optionalKey(Schema.String.annotate({ "description": "Price per image" })),
          "audio": Schema.optionalKey(Schema.String.annotate({ "description": "Price per audio unit" })),
          "request": Schema.optionalKey(Schema.String.annotate({ "description": "Price per request" }))
        }).annotate({
          "description":
            "The object specifying the maximum price you want to pay for this request. USD price per million tokens, for prompt and completion."
        })
      ),
      "preferred_min_throughput": Schema.optionalKey(PreferredMinThroughput),
      "preferred_max_latency": Schema.optionalKey(PreferredMaxLatency)
    }).annotate({
      "description": "When multiple model providers are available, optionally indicate your routing preference."
    })
  ),
  "plugins": Schema.optionalKey(
    Schema.Array(Schema.Union([
      Schema.Struct({
        "id": Schema.Literal("auto-router"),
        "enabled": Schema.optionalKey(
          Schema.Boolean.annotate({
            "description": "Set to false to disable the auto-router plugin for this request. Defaults to true."
          })
        ),
        "allowed_models": Schema.optionalKey(
          Schema.Array(Schema.String).annotate({
            "description":
              "List of model patterns to filter which models the auto-router can route between. Supports wildcards (e.g., \"anthropic/*\" matches all Anthropic models). When not specified, uses the default supported models list."
          })
        )
      }),
      Schema.Struct({ "id": Schema.Literal("moderation") }),
      Schema.Struct({
        "id": Schema.Literal("web"),
        "enabled": Schema.optionalKey(
          Schema.Boolean.annotate({
            "description": "Set to false to disable the web-search plugin for this request. Defaults to true."
          })
        ),
        "max_results": Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
        "search_prompt": Schema.optionalKey(Schema.String),
        "engine": Schema.optionalKey(WebSearchEngine)
      }),
      Schema.Struct({
        "id": Schema.Literal("file-parser"),
        "enabled": Schema.optionalKey(
          Schema.Boolean.annotate({
            "description": "Set to false to disable the file-parser plugin for this request. Defaults to true."
          })
        ),
        "pdf": Schema.optionalKey(PDFParserOptions)
      }),
      Schema.Struct({
        "id": Schema.Literal("response-healing"),
        "enabled": Schema.optionalKey(
          Schema.Boolean.annotate({
            "description": "Set to false to disable the response-healing plugin for this request. Defaults to true."
          })
        )
      })
    ], { mode: "oneOf" })).annotate({
      "description": "Plugins you want to enable for this request, including their settings."
    })
  ),
  "route": Schema.optionalKey(
    Schema.Literals(["fallback", "sort"]).annotate({
      "description":
        "**DEPRECATED** Use providers.sort.partition instead. Backwards-compatible alias for providers.sort.partition. Accepts legacy values: \"fallback\" (maps to \"model\"), \"sort\" (maps to \"none\")."
    })
  ),
  "user": Schema.optionalKey(
    Schema.String.annotate({
      "description":
        "A unique identifier representing your end-user, which helps distinguish between different users of your app. This allows your app to identify specific users in case of abuse reports, preventing your entire app from being affected by the actions of individual users. Maximum of 128 characters."
    }).check(Schema.isMaxLength(128))
  ),
  "session_id": Schema.optionalKey(
    Schema.String.annotate({
      "description":
        "A unique identifier for grouping related requests (e.g., a conversation or agent workflow) for observability. If provided in both the request body and the x-session-id header, the body value takes precedence. Maximum of 128 characters."
    }).check(Schema.isMaxLength(128))
  ),
  "trace": Schema.optionalKey(
    Schema.Struct({
      "trace_id": Schema.optionalKey(Schema.String),
      "trace_name": Schema.optionalKey(Schema.String),
      "span_name": Schema.optionalKey(Schema.String),
      "generation_name": Schema.optionalKey(Schema.String),
      "parent_span_id": Schema.optionalKey(Schema.String)
    }).annotate({
      "description":
        "Metadata for observability and tracing. Known keys (trace_id, trace_name, span_name, generation_name, parent_span_id) have special handling. Additional keys are passed through as custom metadata to configured broadcast destinations."
    })
  )
}).annotate({ "description": "Request schema for Responses endpoint" })
export type ChatGenerationParams = {
  readonly "provider"?: {
    readonly "allow_fallbacks"?: boolean | null
    readonly "require_parameters"?: boolean | null
    readonly "data_collection"?: "deny" | "allow" | null
    readonly "zdr"?: boolean | null
    readonly "enforce_distillable_text"?: boolean | null
    readonly "order"?: __schema5 | null
    readonly "only"?: __schema5 | null
    readonly "ignore"?: __schema5 | null
    readonly "quantizations"?:
      | ReadonlyArray<"int4" | "int8" | "fp4" | "fp6" | "fp8" | "fp16" | "bf16" | "fp32" | "unknown">
      | null
    readonly "sort"?: ProviderSortUnion | null
    readonly "max_price"?: {
      readonly "prompt"?: __schema11 | ModelName | __schema13
      readonly "completion"?: __schema11 | ModelName | __schema13
      readonly "image"?: __schema14
      readonly "audio"?: __schema14
      readonly "request"?: __schema14
    }
    readonly "preferred_min_throughput"?: number | {
      readonly "p50"?: number | null
      readonly "p75"?: number | null
      readonly "p90"?: number | null
      readonly "p99"?: number | null
    } | null
    readonly "preferred_max_latency"?: number | {
      readonly "p50"?: number | null
      readonly "p75"?: number | null
      readonly "p90"?: number | null
      readonly "p99"?: number | null
    } | null
  } | null
  readonly "plugins"?: ReadonlyArray<
    | { readonly "id": "auto-router"; readonly "enabled"?: boolean; readonly "allowed_models"?: ReadonlyArray<string> }
    | { readonly "id": "moderation" }
    | {
      readonly "id": "web"
      readonly "enabled"?: boolean
      readonly "max_results"?: number
      readonly "search_prompt"?: string
      readonly "engine"?: "native" | "exa"
    }
    | {
      readonly "id": "file-parser"
      readonly "enabled"?: boolean
      readonly "pdf"?: { readonly "engine"?: "mistral-ocr" | "pdf-text" | "native" }
    }
    | { readonly "id": "response-healing"; readonly "enabled"?: boolean }
  >
  readonly "route"?: "fallback" | "sort" | null
  readonly "user"?: string
  readonly "session_id"?: string
  readonly "trace"?: {
    readonly "trace_id"?: string
    readonly "trace_name"?: string
    readonly "span_name"?: string
    readonly "generation_name"?: string
    readonly "parent_span_id"?: string
  }
  readonly "messages": ReadonlyArray<Message>
  readonly "model"?: ModelName
  readonly "models"?: ReadonlyArray<ModelName>
  readonly "frequency_penalty"?: number | null
  readonly "logit_bias"?: {} | null
  readonly "logprobs"?: boolean | null
  readonly "top_logprobs"?: number | null
  readonly "max_completion_tokens"?: number | null
  readonly "max_tokens"?: number | null
  readonly "metadata"?: {}
  readonly "presence_penalty"?: number | null
  readonly "reasoning"?: {
    readonly "effort"?: "xhigh" | "high" | "medium" | "low" | "minimal" | "none" | null
    readonly "summary"?: ReasoningSummaryVerbosity | null
  }
  readonly "response_format"?:
    | { readonly "type": "text" }
    | { readonly "type": "json_object" }
    | ResponseFormatJSONSchema
    | ResponseFormatTextGrammar
    | { readonly "type": "python" }
  readonly "seed"?: number | null
  readonly "stop"?: string | ReadonlyArray<ModelName> | null
  readonly "stream"?: boolean
  readonly "stream_options"?: ChatStreamOptions | null
  readonly "temperature"?: number | null
  readonly "parallel_tool_calls"?: boolean | null
  readonly "tool_choice"?: ToolChoiceOption
  readonly "tools"?: ReadonlyArray<ToolDefinitionJson>
  readonly "top_p"?: number | null
  readonly "debug"?: { readonly "echo_upstream_body"?: boolean }
  readonly "image_config"?: {}
  readonly "modalities"?: ReadonlyArray<"text" | "image">
}
export const ChatGenerationParams = Schema.Struct({
  "provider": Schema.optionalKey(
    Schema.Union([
      Schema.Struct({
        "allow_fallbacks": Schema.optionalKey(
          Schema.Union([Schema.Boolean, Schema.Null]).annotate({
            "description":
              "Whether to allow backup providers to serve requests\n- true: (default) when the primary provider (or your custom providers in \"order\") is unavailable, use the next best provider.\n- false: use only the primary/custom provider, and return the upstream error if it's unavailable.\n"
          })
        ),
        "require_parameters": Schema.optionalKey(
          Schema.Union([Schema.Boolean, Schema.Null]).annotate({
            "description":
              "Whether to filter providers to only those that support the parameters you've provided. If this setting is omitted or set to false, then providers will receive only the parameters they support, and ignore the rest."
          })
        ),
        "data_collection": Schema.optionalKey(
          Schema.Union([Schema.Literals(["deny", "allow"]), Schema.Null]).annotate({
            "description":
              "Data collection setting. If no available model provider meets the requirement, your request will return an error.\n- allow: (default) allow providers which store user data non-transiently and may train on it\n\n- deny: use only providers which do not collect user data."
          })
        ),
        "zdr": Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
        "enforce_distillable_text": Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
        "order": Schema.optionalKey(
          Schema.Union([__schema5, Schema.Null]).annotate({
            "description":
              "An ordered list of provider slugs. The router will attempt to use the first provider in the subset of this list that supports your requested model, and fall back to the next if it is unavailable. If no providers are available, the request will fail with an error message."
          })
        ),
        "only": Schema.optionalKey(
          Schema.Union([__schema5, Schema.Null]).annotate({
            "description":
              "List of provider slugs to allow. If provided, this list is merged with your account-wide allowed provider settings for this request."
          })
        ),
        "ignore": Schema.optionalKey(
          Schema.Union([__schema5, Schema.Null]).annotate({
            "description":
              "List of provider slugs to ignore. If provided, this list is merged with your account-wide ignored provider settings for this request."
          })
        ),
        "quantizations": Schema.optionalKey(
          Schema.Union([
            Schema.Array(Schema.Literals(["int4", "int8", "fp4", "fp6", "fp8", "fp16", "bf16", "fp32", "unknown"])),
            Schema.Null
          ]).annotate({ "description": "A list of quantization levels to filter the provider by." })
        ),
        "sort": Schema.optionalKey(
          Schema.Union([ProviderSortUnion, Schema.Null]).annotate({
            "description":
              "The sorting strategy to use for this request, if \"order\" is not specified. When set, no load balancing is performed."
          })
        ),
        "max_price": Schema.optionalKey(
          Schema.Struct({
            "prompt": Schema.optionalKey(Schema.Union([__schema11, ModelName, __schema13])),
            "completion": Schema.optionalKey(Schema.Union([__schema11, ModelName, __schema13])),
            "image": Schema.optionalKey(__schema14),
            "audio": Schema.optionalKey(__schema14),
            "request": Schema.optionalKey(__schema14)
          }).annotate({
            "description":
              "The object specifying the maximum price you want to pay for this request. USD price per million tokens, for prompt and completion."
          })
        ),
        "preferred_min_throughput": Schema.optionalKey(
          Schema.Union([
            Schema.Union([
              Schema.Number.check(Schema.isFinite()),
              Schema.Struct({
                "p50": Schema.optionalKey(Schema.Union([Schema.Number.check(Schema.isFinite()), Schema.Null])),
                "p75": Schema.optionalKey(Schema.Union([Schema.Number.check(Schema.isFinite()), Schema.Null])),
                "p90": Schema.optionalKey(Schema.Union([Schema.Number.check(Schema.isFinite()), Schema.Null])),
                "p99": Schema.optionalKey(Schema.Union([Schema.Number.check(Schema.isFinite()), Schema.Null]))
              })
            ]),
            Schema.Null
          ]).annotate({
            "description":
              "Preferred minimum throughput (in tokens per second). Can be a number (applies to p50) or an object with percentile-specific cutoffs. Endpoints below the threshold(s) may still be used, but are deprioritized in routing. When using fallback models, this may cause a fallback model to be used instead of the primary model if it meets the threshold."
          })
        ),
        "preferred_max_latency": Schema.optionalKey(
          Schema.Union([
            Schema.Union([
              Schema.Number.check(Schema.isFinite()),
              Schema.Struct({
                "p50": Schema.optionalKey(Schema.Union([Schema.Number.check(Schema.isFinite()), Schema.Null])),
                "p75": Schema.optionalKey(Schema.Union([Schema.Number.check(Schema.isFinite()), Schema.Null])),
                "p90": Schema.optionalKey(Schema.Union([Schema.Number.check(Schema.isFinite()), Schema.Null])),
                "p99": Schema.optionalKey(Schema.Union([Schema.Number.check(Schema.isFinite()), Schema.Null]))
              })
            ]),
            Schema.Null
          ]).annotate({
            "description":
              "Preferred maximum latency (in seconds). Can be a number (applies to p50) or an object with percentile-specific cutoffs. Endpoints above the threshold(s) may still be used, but are deprioritized in routing. When using fallback models, this may cause a fallback model to be used instead of the primary model if it meets the threshold."
          })
        )
      }),
      Schema.Null
    ]).annotate({
      "description": "When multiple model providers are available, optionally indicate your routing preference."
    })
  ),
  "plugins": Schema.optionalKey(
    Schema.Array(
      Schema.Union([
        Schema.Struct({
          "id": Schema.Literal("auto-router"),
          "enabled": Schema.optionalKey(Schema.Boolean),
          "allowed_models": Schema.optionalKey(Schema.Array(Schema.String))
        }),
        Schema.Struct({ "id": Schema.Literal("moderation") }),
        Schema.Struct({
          "id": Schema.Literal("web"),
          "enabled": Schema.optionalKey(Schema.Boolean),
          "max_results": Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
          "search_prompt": Schema.optionalKey(Schema.String),
          "engine": Schema.optionalKey(Schema.Literals(["native", "exa"]))
        }),
        Schema.Struct({
          "id": Schema.Literal("file-parser"),
          "enabled": Schema.optionalKey(Schema.Boolean),
          "pdf": Schema.optionalKey(
            Schema.Struct({ "engine": Schema.optionalKey(Schema.Literals(["mistral-ocr", "pdf-text", "native"])) })
          )
        }),
        Schema.Struct({ "id": Schema.Literal("response-healing"), "enabled": Schema.optionalKey(Schema.Boolean) })
      ], { mode: "oneOf" })
    ).annotate({ "description": "Plugins you want to enable for this request, including their settings." })
  ),
  "route": Schema.optionalKey(Schema.Union([Schema.Literals(["fallback", "sort"]), Schema.Null])),
  "user": Schema.optionalKey(Schema.String),
  "session_id": Schema.optionalKey(
    Schema.String.annotate({
      "description":
        "A unique identifier for grouping related requests (e.g., a conversation or agent workflow) for observability. If provided in both the request body and the x-session-id header, the body value takes precedence. Maximum of 128 characters."
    }).check(Schema.isMaxLength(128))
  ),
  "trace": Schema.optionalKey(
    Schema.Struct({
      "trace_id": Schema.optionalKey(Schema.String),
      "trace_name": Schema.optionalKey(Schema.String),
      "span_name": Schema.optionalKey(Schema.String),
      "generation_name": Schema.optionalKey(Schema.String),
      "parent_span_id": Schema.optionalKey(Schema.String)
    }).annotate({
      "description":
        "Metadata for observability and tracing. Known keys (trace_id, trace_name, span_name, generation_name, parent_span_id) have special handling. Additional keys are passed through as custom metadata to configured broadcast destinations."
    })
  ),
  "messages": Schema.Array(Message).check(Schema.isMinLength(1)),
  "model": Schema.optionalKey(ModelName),
  "models": Schema.optionalKey(Schema.Array(ModelName)),
  "frequency_penalty": Schema.optionalKey(
    Schema.Union([
      Schema.Number.check(Schema.isFinite()).check(Schema.isGreaterThanOrEqualTo(-2)).check(
        Schema.isLessThanOrEqualTo(2)
      ),
      Schema.Null
    ])
  ),
  "logit_bias": Schema.optionalKey(
    Schema.Union([Schema.Struct({}).check(Schema.isPropertyNames(Schema.String)), Schema.Null])
  ),
  "logprobs": Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  "top_logprobs": Schema.optionalKey(
    Schema.Union([
      Schema.Number.check(Schema.isFinite()).check(Schema.isGreaterThanOrEqualTo(0)).check(
        Schema.isLessThanOrEqualTo(20)
      ),
      Schema.Null
    ])
  ),
  "max_completion_tokens": Schema.optionalKey(
    Schema.Union([Schema.Number.check(Schema.isFinite()).check(Schema.isGreaterThanOrEqualTo(1)), Schema.Null])
  ),
  "max_tokens": Schema.optionalKey(
    Schema.Union([Schema.Number.check(Schema.isFinite()).check(Schema.isGreaterThanOrEqualTo(1)), Schema.Null])
  ),
  "metadata": Schema.optionalKey(Schema.Struct({}).check(Schema.isPropertyNames(Schema.String))),
  "presence_penalty": Schema.optionalKey(
    Schema.Union([
      Schema.Number.check(Schema.isFinite()).check(Schema.isGreaterThanOrEqualTo(-2)).check(
        Schema.isLessThanOrEqualTo(2)
      ),
      Schema.Null
    ])
  ),
  "reasoning": Schema.optionalKey(
    Schema.Struct({
      "effort": Schema.optionalKey(
        Schema.Union([Schema.Literals(["xhigh", "high", "medium", "low", "minimal", "none"]), Schema.Null])
      ),
      "summary": Schema.optionalKey(Schema.Union([ReasoningSummaryVerbosity, Schema.Null]))
    })
  ),
  "response_format": Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ "type": Schema.Literal("text") }),
      Schema.Struct({ "type": Schema.Literal("json_object") }),
      ResponseFormatJSONSchema,
      ResponseFormatTextGrammar,
      Schema.Struct({ "type": Schema.Literal("python") })
    ], { mode: "oneOf" })
  ),
  "seed": Schema.optionalKey(
    Schema.Union([
      Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(-9007199254740991)).check(
        Schema.isLessThanOrEqualTo(9007199254740991)
      ),
      Schema.Null
    ])
  ),
  "stop": Schema.optionalKey(
    Schema.Union([Schema.Union([Schema.String, Schema.Array(ModelName).check(Schema.isMaxLength(4))]), Schema.Null])
  ),
  "stream": Schema.optionalKey(Schema.Boolean),
  "stream_options": Schema.optionalKey(Schema.Union([ChatStreamOptions, Schema.Null])),
  "temperature": Schema.optionalKey(
    Schema.Union([
      Schema.Number.check(Schema.isFinite()).check(Schema.isGreaterThanOrEqualTo(0)).check(
        Schema.isLessThanOrEqualTo(2)
      ),
      Schema.Null
    ])
  ),
  "parallel_tool_calls": Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  "tool_choice": Schema.optionalKey(ToolChoiceOption),
  "tools": Schema.optionalKey(Schema.Array(ToolDefinitionJson)),
  "top_p": Schema.optionalKey(
    Schema.Union([
      Schema.Number.check(Schema.isFinite()).check(Schema.isGreaterThanOrEqualTo(0)).check(
        Schema.isLessThanOrEqualTo(1)
      ),
      Schema.Null
    ])
  ),
  "debug": Schema.optionalKey(Schema.Struct({ "echo_upstream_body": Schema.optionalKey(Schema.Boolean) })),
  "image_config": Schema.optionalKey(Schema.Struct({}).check(Schema.isPropertyNames(Schema.String))),
  "modalities": Schema.optionalKey(Schema.Array(Schema.Literals(["text", "image"])))
})
export type OpenResponsesCreatedEvent = {
  readonly "type": "response.created"
  readonly "response": OpenAIResponsesNonStreamingResponse
  readonly "sequence_number": number
}
export const OpenResponsesCreatedEvent = Schema.Struct({
  "type": Schema.Literal("response.created"),
  "response": OpenAIResponsesNonStreamingResponse,
  "sequence_number": Schema.Number.check(Schema.isFinite())
}).annotate({ "description": "Event emitted when a response is created" })
export type OpenResponsesInProgressEvent = {
  readonly "type": "response.in_progress"
  readonly "response": OpenAIResponsesNonStreamingResponse
  readonly "sequence_number": number
}
export const OpenResponsesInProgressEvent = Schema.Struct({
  "type": Schema.Literal("response.in_progress"),
  "response": OpenAIResponsesNonStreamingResponse,
  "sequence_number": Schema.Number.check(Schema.isFinite())
}).annotate({ "description": "Event emitted when a response is in progress" })
export type OpenResponsesCompletedEvent = {
  readonly "type": "response.completed"
  readonly "response": OpenAIResponsesNonStreamingResponse
  readonly "sequence_number": number
}
export const OpenResponsesCompletedEvent = Schema.Struct({
  "type": Schema.Literal("response.completed"),
  "response": OpenAIResponsesNonStreamingResponse,
  "sequence_number": Schema.Number.check(Schema.isFinite())
}).annotate({ "description": "Event emitted when a response has completed successfully" })
export type OpenResponsesIncompleteEvent = {
  readonly "type": "response.incomplete"
  readonly "response": OpenAIResponsesNonStreamingResponse
  readonly "sequence_number": number
}
export const OpenResponsesIncompleteEvent = Schema.Struct({
  "type": Schema.Literal("response.incomplete"),
  "response": OpenAIResponsesNonStreamingResponse,
  "sequence_number": Schema.Number.check(Schema.isFinite())
}).annotate({ "description": "Event emitted when a response is incomplete" })
export type OpenResponsesFailedEvent = {
  readonly "type": "response.failed"
  readonly "response": OpenAIResponsesNonStreamingResponse
  readonly "sequence_number": number
}
export const OpenResponsesFailedEvent = Schema.Struct({
  "type": Schema.Literal("response.failed"),
  "response": OpenAIResponsesNonStreamingResponse,
  "sequence_number": Schema.Number.check(Schema.isFinite())
}).annotate({ "description": "Event emitted when a response has failed" })
export type OpenResponsesStreamEvent =
  | OpenResponsesCreatedEvent
  | OpenResponsesInProgressEvent
  | OpenResponsesCompletedEvent
  | OpenResponsesIncompleteEvent
  | OpenResponsesFailedEvent
  | OpenResponsesErrorEvent
  | OpenResponsesOutputItemAddedEvent
  | OpenResponsesOutputItemDoneEvent
  | OpenResponsesContentPartAddedEvent
  | OpenResponsesContentPartDoneEvent
  | OpenResponsesTextDeltaEvent
  | OpenResponsesTextDoneEvent
  | OpenResponsesRefusalDeltaEvent
  | OpenResponsesRefusalDoneEvent
  | OpenResponsesOutputTextAnnotationAddedEvent
  | OpenResponsesFunctionCallArgumentsDeltaEvent
  | OpenResponsesFunctionCallArgumentsDoneEvent
  | OpenResponsesReasoningDeltaEvent
  | OpenResponsesReasoningDoneEvent
  | OpenResponsesReasoningSummaryPartAddedEvent
  | OpenResponsesReasoningSummaryPartDoneEvent
  | OpenResponsesReasoningSummaryTextDeltaEvent
  | OpenResponsesReasoningSummaryTextDoneEvent
  | OpenResponsesImageGenCallInProgress
  | OpenResponsesImageGenCallGenerating
  | OpenResponsesImageGenCallPartialImage
  | OpenResponsesImageGenCallCompleted
export const OpenResponsesStreamEvent = Schema.Union([
  OpenResponsesCreatedEvent,
  OpenResponsesInProgressEvent,
  OpenResponsesCompletedEvent,
  OpenResponsesIncompleteEvent,
  OpenResponsesFailedEvent,
  OpenResponsesErrorEvent,
  OpenResponsesOutputItemAddedEvent,
  OpenResponsesOutputItemDoneEvent,
  OpenResponsesContentPartAddedEvent,
  OpenResponsesContentPartDoneEvent,
  OpenResponsesTextDeltaEvent,
  OpenResponsesTextDoneEvent,
  OpenResponsesRefusalDeltaEvent,
  OpenResponsesRefusalDoneEvent,
  OpenResponsesOutputTextAnnotationAddedEvent,
  OpenResponsesFunctionCallArgumentsDeltaEvent,
  OpenResponsesFunctionCallArgumentsDoneEvent,
  OpenResponsesReasoningDeltaEvent,
  OpenResponsesReasoningDoneEvent,
  OpenResponsesReasoningSummaryPartAddedEvent,
  OpenResponsesReasoningSummaryPartDoneEvent,
  OpenResponsesReasoningSummaryTextDeltaEvent,
  OpenResponsesReasoningSummaryTextDoneEvent,
  OpenResponsesImageGenCallInProgress,
  OpenResponsesImageGenCallGenerating,
  OpenResponsesImageGenCallPartialImage,
  OpenResponsesImageGenCallCompleted
], { mode: "oneOf" })
// schemas
export type CreateResponsesRequestJson = OpenResponsesRequest
export const CreateResponsesRequestJson = OpenResponsesRequest
export type CreateResponses200 = OpenResponsesNonStreamingResponse
export const CreateResponses200 = OpenResponsesNonStreamingResponse
export type CreateResponses200Sse = { readonly "data": OpenResponsesStreamEvent }
export const CreateResponses200Sse = Schema.Struct({ "data": OpenResponsesStreamEvent })
export type CreateResponses400 = BadRequestResponse
export const CreateResponses400 = BadRequestResponse
export type CreateResponses401 = UnauthorizedResponse
export const CreateResponses401 = UnauthorizedResponse
export type CreateResponses402 = PaymentRequiredResponse
export const CreateResponses402 = PaymentRequiredResponse
export type CreateResponses404 = NotFoundResponse
export const CreateResponses404 = NotFoundResponse
export type CreateResponses408 = RequestTimeoutResponse
export const CreateResponses408 = RequestTimeoutResponse
export type CreateResponses413 = PayloadTooLargeResponse
export const CreateResponses413 = PayloadTooLargeResponse
export type CreateResponses422 = UnprocessableEntityResponse
export const CreateResponses422 = UnprocessableEntityResponse
export type CreateResponses429 = TooManyRequestsResponse
export const CreateResponses429 = TooManyRequestsResponse
export type CreateResponses500 = InternalServerResponse
export const CreateResponses500 = InternalServerResponse
export type CreateResponses502 = BadGatewayResponse
export const CreateResponses502 = BadGatewayResponse
export type CreateResponses503 = ServiceUnavailableResponse
export const CreateResponses503 = ServiceUnavailableResponse
export type CreateResponses524 = EdgeNetworkTimeoutResponse
export const CreateResponses524 = EdgeNetworkTimeoutResponse
export type CreateResponses529 = ProviderOverloadedResponse
export const CreateResponses529 = ProviderOverloadedResponse
export type CreateMessagesRequestJson = AnthropicMessagesRequest
export const CreateMessagesRequestJson = AnthropicMessagesRequest
export type CreateMessages200 = AnthropicMessagesResponse
export const CreateMessages200 = AnthropicMessagesResponse
export type CreateMessages200Sse = { readonly "event": string; readonly "data": AnthropicMessagesStreamEvent }
export const CreateMessages200Sse = Schema.Struct({ "event": Schema.String, "data": AnthropicMessagesStreamEvent })
export type CreateMessages400 = {
  readonly "type": "error"
  readonly "error": { readonly "type": string; readonly "message": string }
}
export const CreateMessages400 = Schema.Struct({
  "type": Schema.Literal("error"),
  "error": Schema.Struct({ "type": Schema.String, "message": Schema.String })
})
export type CreateMessages401 = {
  readonly "type": "error"
  readonly "error": { readonly "type": string; readonly "message": string }
}
export const CreateMessages401 = Schema.Struct({
  "type": Schema.Literal("error"),
  "error": Schema.Struct({ "type": Schema.String, "message": Schema.String })
})
export type CreateMessages403 = {
  readonly "type": "error"
  readonly "error": { readonly "type": string; readonly "message": string }
}
export const CreateMessages403 = Schema.Struct({
  "type": Schema.Literal("error"),
  "error": Schema.Struct({ "type": Schema.String, "message": Schema.String })
})
export type CreateMessages404 = {
  readonly "type": "error"
  readonly "error": { readonly "type": string; readonly "message": string }
}
export const CreateMessages404 = Schema.Struct({
  "type": Schema.Literal("error"),
  "error": Schema.Struct({ "type": Schema.String, "message": Schema.String })
})
export type CreateMessages429 = {
  readonly "type": "error"
  readonly "error": { readonly "type": string; readonly "message": string }
}
export const CreateMessages429 = Schema.Struct({
  "type": Schema.Literal("error"),
  "error": Schema.Struct({ "type": Schema.String, "message": Schema.String })
})
export type CreateMessages500 = {
  readonly "type": "error"
  readonly "error": { readonly "type": string; readonly "message": string }
}
export const CreateMessages500 = Schema.Struct({
  "type": Schema.Literal("error"),
  "error": Schema.Struct({ "type": Schema.String, "message": Schema.String })
})
export type CreateMessages503 = {
  readonly "type": "error"
  readonly "error": { readonly "type": string; readonly "message": string }
}
export const CreateMessages503 = Schema.Struct({
  "type": Schema.Literal("error"),
  "error": Schema.Struct({ "type": Schema.String, "message": Schema.String })
})
export type CreateMessages529 = {
  readonly "type": "error"
  readonly "error": { readonly "type": string; readonly "message": string }
}
export const CreateMessages529 = Schema.Struct({
  "type": Schema.Literal("error"),
  "error": Schema.Struct({ "type": Schema.String, "message": Schema.String })
})
export type GetUserActivityParams = { readonly "date"?: string }
export const GetUserActivityParams = Schema.Struct({
  "date": Schema.optionalKey(
    Schema.String.annotate({ "description": "Filter by a single UTC date in the last 30 days (YYYY-MM-DD format)." })
  )
})
export type GetUserActivity200 = { readonly "data": ReadonlyArray<ActivityItem> }
export const GetUserActivity200 = Schema.Struct({
  "data": Schema.Array(ActivityItem).annotate({ "description": "List of activity items" })
})
export type GetUserActivity400 = BadRequestResponse
export const GetUserActivity400 = BadRequestResponse
export type GetUserActivity401 = UnauthorizedResponse
export const GetUserActivity401 = UnauthorizedResponse
export type GetUserActivity403 = ForbiddenResponse
export const GetUserActivity403 = ForbiddenResponse
export type GetUserActivity500 = InternalServerResponse
export const GetUserActivity500 = InternalServerResponse
export type GetCredits200 = { readonly "data": { readonly "total_credits": number; readonly "total_usage": number } }
export const GetCredits200 = Schema.Struct({
  "data": Schema.Struct({
    "total_credits": Schema.Number.annotate({ "description": "Total credits purchased" }).check(Schema.isFinite()),
    "total_usage": Schema.Number.annotate({ "description": "Total credits used" }).check(Schema.isFinite())
  })
}).annotate({ "description": "Total credits purchased and used" })
export type GetCredits401 = UnauthorizedResponse
export const GetCredits401 = UnauthorizedResponse
export type GetCredits403 = ForbiddenResponse
export const GetCredits403 = ForbiddenResponse
export type GetCredits500 = InternalServerResponse
export const GetCredits500 = InternalServerResponse
export type CreateCoinbaseChargeRequestJson = CreateChargeRequest
export const CreateCoinbaseChargeRequestJson = CreateChargeRequest
export type CreateCoinbaseCharge200 = {
  readonly "data": {
    readonly "id": string
    readonly "created_at": string
    readonly "expires_at": string
    readonly "web3_data": {
      readonly "transfer_intent": {
        readonly "call_data": {
          readonly "deadline": string
          readonly "fee_amount": string
          readonly "id": string
          readonly "operator": string
          readonly "prefix": string
          readonly "recipient": string
          readonly "recipient_amount": string
          readonly "recipient_currency": string
          readonly "refund_destination": string
          readonly "signature": string
        }
        readonly "metadata": {
          readonly "chain_id": number
          readonly "contract_address": string
          readonly "sender": string
        }
      }
    }
  }
}
export const CreateCoinbaseCharge200 = Schema.Struct({
  "data": Schema.Struct({
    "id": Schema.String,
    "created_at": Schema.String,
    "expires_at": Schema.String,
    "web3_data": Schema.Struct({
      "transfer_intent": Schema.Struct({
        "call_data": Schema.Struct({
          "deadline": Schema.String,
          "fee_amount": Schema.String,
          "id": Schema.String,
          "operator": Schema.String,
          "prefix": Schema.String,
          "recipient": Schema.String,
          "recipient_amount": Schema.String,
          "recipient_currency": Schema.String,
          "refund_destination": Schema.String,
          "signature": Schema.String
        }),
        "metadata": Schema.Struct({
          "chain_id": Schema.Number.check(Schema.isFinite()),
          "contract_address": Schema.String,
          "sender": Schema.String
        })
      })
    })
  })
})
export type CreateCoinbaseCharge400 = BadRequestResponse
export const CreateCoinbaseCharge400 = BadRequestResponse
export type CreateCoinbaseCharge401 = UnauthorizedResponse
export const CreateCoinbaseCharge401 = UnauthorizedResponse
export type CreateCoinbaseCharge429 = TooManyRequestsResponse
export const CreateCoinbaseCharge429 = TooManyRequestsResponse
export type CreateCoinbaseCharge500 = InternalServerResponse
export const CreateCoinbaseCharge500 = InternalServerResponse
export type CreateEmbeddingsRequestJson = {
  readonly "input":
    | string
    | ReadonlyArray<string>
    | ReadonlyArray<number>
    | ReadonlyArray<ReadonlyArray<number>>
    | ReadonlyArray<
      {
        readonly "content": ReadonlyArray<
          { readonly "type": "text"; readonly "text": string } | {
            readonly "type": "image_url"
            readonly "image_url": { readonly "url": string }
          }
        >
      }
    >
  readonly "model": string
  readonly "encoding_format"?: "float" | "base64"
  readonly "dimensions"?: number
  readonly "user"?: string
  readonly "provider"?: ProviderPreferences
  readonly "input_type"?: string
}
export const CreateEmbeddingsRequestJson = Schema.Struct({
  "input": Schema.Union([
    Schema.String,
    Schema.Array(Schema.String),
    Schema.Array(Schema.Number.check(Schema.isFinite())),
    Schema.Array(Schema.Array(Schema.Number.check(Schema.isFinite()))),
    Schema.Array(
      Schema.Struct({
        "content": Schema.Array(
          Schema.Union([
            Schema.Struct({ "type": Schema.Literal("text"), "text": Schema.String }),
            Schema.Struct({ "type": Schema.Literal("image_url"), "image_url": Schema.Struct({ "url": Schema.String }) })
          ], { mode: "oneOf" })
        )
      })
    )
  ]),
  "model": Schema.String,
  "encoding_format": Schema.optionalKey(Schema.Literals(["float", "base64"])),
  "dimensions": Schema.optionalKey(Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))),
  "user": Schema.optionalKey(Schema.String),
  "provider": Schema.optionalKey(ProviderPreferences),
  "input_type": Schema.optionalKey(Schema.String)
})
export type CreateEmbeddings200 = {
  readonly "id"?: string
  readonly "object": "list"
  readonly "data": ReadonlyArray<
    { readonly "object": "embedding"; readonly "embedding": ReadonlyArray<number> | string; readonly "index"?: number }
  >
  readonly "model": string
  readonly "usage"?: { readonly "prompt_tokens": number; readonly "total_tokens": number; readonly "cost"?: number }
}
export const CreateEmbeddings200 = Schema.Struct({
  "id": Schema.optionalKey(Schema.String),
  "object": Schema.Literal("list"),
  "data": Schema.Array(
    Schema.Struct({
      "object": Schema.Literal("embedding"),
      "embedding": Schema.Union([Schema.Array(Schema.Number.check(Schema.isFinite())), Schema.String]),
      "index": Schema.optionalKey(Schema.Number.check(Schema.isFinite()))
    })
  ),
  "model": Schema.String,
  "usage": Schema.optionalKey(
    Schema.Struct({
      "prompt_tokens": Schema.Number.check(Schema.isFinite()),
      "total_tokens": Schema.Number.check(Schema.isFinite()),
      "cost": Schema.optionalKey(Schema.Number.check(Schema.isFinite()))
    })
  )
})
export type CreateEmbeddings200Sse = string
export const CreateEmbeddings200Sse = Schema.String.annotate({
  "description": "Not used for embeddings - embeddings do not support streaming"
})
export type CreateEmbeddings400 = BadRequestResponse
export const CreateEmbeddings400 = BadRequestResponse
export type CreateEmbeddings401 = UnauthorizedResponse
export const CreateEmbeddings401 = UnauthorizedResponse
export type CreateEmbeddings402 = PaymentRequiredResponse
export const CreateEmbeddings402 = PaymentRequiredResponse
export type CreateEmbeddings404 = NotFoundResponse
export const CreateEmbeddings404 = NotFoundResponse
export type CreateEmbeddings429 = TooManyRequestsResponse
export const CreateEmbeddings429 = TooManyRequestsResponse
export type CreateEmbeddings500 = InternalServerResponse
export const CreateEmbeddings500 = InternalServerResponse
export type CreateEmbeddings502 = BadGatewayResponse
export const CreateEmbeddings502 = BadGatewayResponse
export type CreateEmbeddings503 = ServiceUnavailableResponse
export const CreateEmbeddings503 = ServiceUnavailableResponse
export type CreateEmbeddings524 = EdgeNetworkTimeoutResponse
export const CreateEmbeddings524 = EdgeNetworkTimeoutResponse
export type CreateEmbeddings529 = ProviderOverloadedResponse
export const CreateEmbeddings529 = ProviderOverloadedResponse
export type ListEmbeddingsModels200 = ModelsListResponse
export const ListEmbeddingsModels200 = ModelsListResponse
export type ListEmbeddingsModels400 = BadRequestResponse
export const ListEmbeddingsModels400 = BadRequestResponse
export type ListEmbeddingsModels500 = InternalServerResponse
export const ListEmbeddingsModels500 = InternalServerResponse
export type GetGenerationParams = { readonly "id": string }
export const GetGenerationParams = Schema.Struct({ "id": Schema.String.check(Schema.isMinLength(1)) })
export type GetGeneration200 = {
  readonly "data": {
    readonly "id": string
    readonly "upstream_id": string
    readonly "total_cost": number
    readonly "cache_discount": number
    readonly "upstream_inference_cost": number
    readonly "created_at": string
    readonly "model": string
    readonly "app_id": number
    readonly "streamed": boolean
    readonly "cancelled": boolean
    readonly "provider_name": string
    readonly "latency": number
    readonly "moderation_latency": number
    readonly "generation_time": number
    readonly "finish_reason": string
    readonly "tokens_prompt": number
    readonly "tokens_completion": number
    readonly "native_tokens_prompt": number
    readonly "native_tokens_completion": number
    readonly "native_tokens_completion_images": number
    readonly "native_tokens_reasoning": number
    readonly "native_tokens_cached": number
    readonly "num_media_prompt": number
    readonly "num_input_audio_prompt": number
    readonly "num_media_completion": number
    readonly "num_search_results": number
    readonly "origin": string
    readonly "usage": number
    readonly "is_byok": boolean
    readonly "native_finish_reason": string
    readonly "external_user": string
    readonly "api_type": "completions" | "embeddings"
    readonly "router": string
    readonly "provider_responses": ReadonlyArray<
      {
        readonly "id"?: string
        readonly "endpoint_id"?: string
        readonly "model_permaslug"?: string
        readonly "provider_name"?:
          | "AnyScale"
          | "Atoma"
          | "Cent-ML"
          | "CrofAI"
          | "Enfer"
          | "GoPomelo"
          | "HuggingFace"
          | "Hyperbolic 2"
          | "InoCloud"
          | "Kluster"
          | "Lambda"
          | "Lepton"
          | "Lynn 2"
          | "Lynn"
          | "Mancer"
          | "Meta"
          | "Modal"
          | "Nineteen"
          | "OctoAI"
          | "Recursal"
          | "Reflection"
          | "Replicate"
          | "SambaNova 2"
          | "SF Compute"
          | "Targon"
          | "Together 2"
          | "Ubicloud"
          | "01.AI"
          | "AI21"
          | "AionLabs"
          | "Alibaba"
          | "Ambient"
          | "Amazon Bedrock"
          | "Amazon Nova"
          | "Anthropic"
          | "Arcee AI"
          | "AtlasCloud"
          | "Avian"
          | "Azure"
          | "BaseTen"
          | "BytePlus"
          | "Black Forest Labs"
          | "Cerebras"
          | "Chutes"
          | "Cirrascale"
          | "Clarifai"
          | "Cloudflare"
          | "Cohere"
          | "Crusoe"
          | "DeepInfra"
          | "DeepSeek"
          | "Featherless"
          | "Fireworks"
          | "Friendli"
          | "GMICloud"
          | "Google"
          | "Google AI Studio"
          | "Groq"
          | "Hyperbolic"
          | "Inception"
          | "Inceptron"
          | "InferenceNet"
          | "Infermatic"
          | "Io Net"
          | "Inflection"
          | "Liquid"
          | "Mara"
          | "Mancer 2"
          | "Minimax"
          | "ModelRun"
          | "Mistral"
          | "Modular"
          | "Moonshot AI"
          | "Morph"
          | "NCompass"
          | "Nebius"
          | "NextBit"
          | "Novita"
          | "Nvidia"
          | "OpenAI"
          | "OpenInference"
          | "Parasail"
          | "Perplexity"
          | "Phala"
          | "Relace"
          | "SambaNova"
          | "Seed"
          | "SiliconFlow"
          | "Sourceful"
          | "StepFun"
          | "Stealth"
          | "StreamLake"
          | "Switchpoint"
          | "Together"
          | "Upstage"
          | "Venice"
          | "WandB"
          | "Xiaomi"
          | "xAI"
          | "Z.AI"
          | "FakeProvider"
        readonly "status": number
        readonly "latency"?: number
        readonly "is_byok"?: boolean
      }
    >
  }
}
export const GetGeneration200 = Schema.Struct({
  "data": Schema.Struct({
    "id": Schema.String.annotate({ "description": "Unique identifier for the generation" }),
    "upstream_id": Schema.String.annotate({ "description": "Upstream provider's identifier for this generation" }),
    "total_cost": Schema.Number.annotate({ "description": "Total cost of the generation in USD" }).check(
      Schema.isFinite()
    ),
    "cache_discount": Schema.Number.annotate({ "description": "Discount applied due to caching" }).check(
      Schema.isFinite()
    ),
    "upstream_inference_cost": Schema.Number.annotate({ "description": "Cost charged by the upstream provider" }).check(
      Schema.isFinite()
    ),
    "created_at": Schema.String.annotate({ "description": "ISO 8601 timestamp of when the generation was created" }),
    "model": Schema.String.annotate({ "description": "Model used for the generation" }),
    "app_id": Schema.Number.annotate({ "description": "ID of the app that made the request" }).check(Schema.isFinite()),
    "streamed": Schema.Boolean.annotate({ "description": "Whether the response was streamed" }),
    "cancelled": Schema.Boolean.annotate({ "description": "Whether the generation was cancelled" }),
    "provider_name": Schema.String.annotate({ "description": "Name of the provider that served the request" }),
    "latency": Schema.Number.annotate({ "description": "Total latency in milliseconds" }).check(Schema.isFinite()),
    "moderation_latency": Schema.Number.annotate({ "description": "Moderation latency in milliseconds" }).check(
      Schema.isFinite()
    ),
    "generation_time": Schema.Number.annotate({ "description": "Time taken for generation in milliseconds" }).check(
      Schema.isFinite()
    ),
    "finish_reason": Schema.String.annotate({ "description": "Reason the generation finished" }),
    "tokens_prompt": Schema.Number.annotate({ "description": "Number of tokens in the prompt" }).check(
      Schema.isFinite()
    ),
    "tokens_completion": Schema.Number.annotate({ "description": "Number of tokens in the completion" }).check(
      Schema.isFinite()
    ),
    "native_tokens_prompt": Schema.Number.annotate({ "description": "Native prompt tokens as reported by provider" })
      .check(Schema.isFinite()),
    "native_tokens_completion": Schema.Number.annotate({
      "description": "Native completion tokens as reported by provider"
    }).check(Schema.isFinite()),
    "native_tokens_completion_images": Schema.Number.annotate({
      "description": "Native completion image tokens as reported by provider"
    }).check(Schema.isFinite()),
    "native_tokens_reasoning": Schema.Number.annotate({
      "description": "Native reasoning tokens as reported by provider"
    }).check(Schema.isFinite()),
    "native_tokens_cached": Schema.Number.annotate({ "description": "Native cached tokens as reported by provider" })
      .check(Schema.isFinite()),
    "num_media_prompt": Schema.Number.annotate({ "description": "Number of media items in the prompt" }).check(
      Schema.isFinite()
    ),
    "num_input_audio_prompt": Schema.Number.annotate({ "description": "Number of audio inputs in the prompt" }).check(
      Schema.isFinite()
    ),
    "num_media_completion": Schema.Number.annotate({ "description": "Number of media items in the completion" }).check(
      Schema.isFinite()
    ),
    "num_search_results": Schema.Number.annotate({ "description": "Number of search results included" }).check(
      Schema.isFinite()
    ),
    "origin": Schema.String.annotate({ "description": "Origin URL of the request" }),
    "usage": Schema.Number.annotate({ "description": "Usage amount in USD" }).check(Schema.isFinite()),
    "is_byok": Schema.Boolean.annotate({ "description": "Whether this used bring-your-own-key" }),
    "native_finish_reason": Schema.String.annotate({ "description": "Native finish reason as reported by provider" }),
    "external_user": Schema.String.annotate({ "description": "External user identifier" }),
    "api_type": Schema.Literals(["completions", "embeddings"]).annotate({
      "description": "Type of API used for the generation"
    }),
    "router": Schema.String.annotate({ "description": "Router used for the request (e.g., openrouter/auto)" }),
    "provider_responses": Schema.Array(Schema.Struct({
      "id": Schema.optionalKey(Schema.String),
      "endpoint_id": Schema.optionalKey(Schema.String),
      "model_permaslug": Schema.optionalKey(Schema.String),
      "provider_name": Schema.optionalKey(
        Schema.Literals([
          "AnyScale",
          "Atoma",
          "Cent-ML",
          "CrofAI",
          "Enfer",
          "GoPomelo",
          "HuggingFace",
          "Hyperbolic 2",
          "InoCloud",
          "Kluster",
          "Lambda",
          "Lepton",
          "Lynn 2",
          "Lynn",
          "Mancer",
          "Meta",
          "Modal",
          "Nineteen",
          "OctoAI",
          "Recursal",
          "Reflection",
          "Replicate",
          "SambaNova 2",
          "SF Compute",
          "Targon",
          "Together 2",
          "Ubicloud",
          "01.AI",
          "AI21",
          "AionLabs",
          "Alibaba",
          "Ambient",
          "Amazon Bedrock",
          "Amazon Nova",
          "Anthropic",
          "Arcee AI",
          "AtlasCloud",
          "Avian",
          "Azure",
          "BaseTen",
          "BytePlus",
          "Black Forest Labs",
          "Cerebras",
          "Chutes",
          "Cirrascale",
          "Clarifai",
          "Cloudflare",
          "Cohere",
          "Crusoe",
          "DeepInfra",
          "DeepSeek",
          "Featherless",
          "Fireworks",
          "Friendli",
          "GMICloud",
          "Google",
          "Google AI Studio",
          "Groq",
          "Hyperbolic",
          "Inception",
          "Inceptron",
          "InferenceNet",
          "Infermatic",
          "Io Net",
          "Inflection",
          "Liquid",
          "Mara",
          "Mancer 2",
          "Minimax",
          "ModelRun",
          "Mistral",
          "Modular",
          "Moonshot AI",
          "Morph",
          "NCompass",
          "Nebius",
          "NextBit",
          "Novita",
          "Nvidia",
          "OpenAI",
          "OpenInference",
          "Parasail",
          "Perplexity",
          "Phala",
          "Relace",
          "SambaNova",
          "Seed",
          "SiliconFlow",
          "Sourceful",
          "StepFun",
          "Stealth",
          "StreamLake",
          "Switchpoint",
          "Together",
          "Upstage",
          "Venice",
          "WandB",
          "Xiaomi",
          "xAI",
          "Z.AI",
          "FakeProvider"
        ])
      ),
      "status": Schema.Number.check(Schema.isFinite()),
      "latency": Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
      "is_byok": Schema.optionalKey(Schema.Boolean)
    })).annotate({ "description": "List of provider responses for this generation, including fallback attempts" })
  }).annotate({ "description": "Generation data" })
}).annotate({ "description": "Generation response" })
export type GetGeneration401 = UnauthorizedResponse
export const GetGeneration401 = UnauthorizedResponse
export type GetGeneration402 = PaymentRequiredResponse
export const GetGeneration402 = PaymentRequiredResponse
export type GetGeneration404 = NotFoundResponse
export const GetGeneration404 = NotFoundResponse
export type GetGeneration429 = TooManyRequestsResponse
export const GetGeneration429 = TooManyRequestsResponse
export type GetGeneration500 = InternalServerResponse
export const GetGeneration500 = InternalServerResponse
export type GetGeneration502 = BadGatewayResponse
export const GetGeneration502 = BadGatewayResponse
export type GetGeneration524 = EdgeNetworkTimeoutResponse
export const GetGeneration524 = EdgeNetworkTimeoutResponse
export type GetGeneration529 = ProviderOverloadedResponse
export const GetGeneration529 = ProviderOverloadedResponse
export type ListModelsCount200 = ModelsCountResponse
export const ListModelsCount200 = ModelsCountResponse
export type ListModelsCount500 = InternalServerResponse
export const ListModelsCount500 = InternalServerResponse
export type GetModelsParams = {
  readonly "category"?:
    | "programming"
    | "roleplay"
    | "marketing"
    | "marketing/seo"
    | "technology"
    | "science"
    | "translation"
    | "legal"
    | "finance"
    | "health"
    | "trivia"
    | "academia"
  readonly "supported_parameters"?: string
}
export const GetModelsParams = Schema.Struct({
  "category": Schema.optionalKey(
    Schema.Literals([
      "programming",
      "roleplay",
      "marketing",
      "marketing/seo",
      "technology",
      "science",
      "translation",
      "legal",
      "finance",
      "health",
      "trivia",
      "academia"
    ]).annotate({ "description": "Filter models by use case category" })
  ),
  "supported_parameters": Schema.optionalKey(Schema.String)
})
export type GetModels200 = ModelsListResponse
export const GetModels200 = ModelsListResponse
export type GetModels400 = BadRequestResponse
export const GetModels400 = BadRequestResponse
export type GetModels500 = InternalServerResponse
export const GetModels500 = InternalServerResponse
export type ListModelsUser200 = ModelsListResponse
export const ListModelsUser200 = ModelsListResponse
export type ListModelsUser401 = UnauthorizedResponse
export const ListModelsUser401 = UnauthorizedResponse
export type ListModelsUser404 = NotFoundResponse
export const ListModelsUser404 = NotFoundResponse
export type ListModelsUser500 = InternalServerResponse
export const ListModelsUser500 = InternalServerResponse
export type ListEndpoints200 = { readonly "data": ListEndpointsResponse }
export const ListEndpoints200 = Schema.Struct({ "data": ListEndpointsResponse })
export type ListEndpoints404 = NotFoundResponse
export const ListEndpoints404 = NotFoundResponse
export type ListEndpoints500 = InternalServerResponse
export const ListEndpoints500 = InternalServerResponse
export type ListEndpointsZdr200 = { readonly "data": ReadonlyArray<PublicEndpoint> }
export const ListEndpointsZdr200 = Schema.Struct({ "data": Schema.Array(PublicEndpoint) })
export type ListEndpointsZdr500 = InternalServerResponse
export const ListEndpointsZdr500 = InternalServerResponse
export type ListProviders200 = {
  readonly "data": ReadonlyArray<
    {
      readonly "name": string
      readonly "slug": string
      readonly "privacy_policy_url": string
      readonly "terms_of_service_url"?: string
      readonly "status_page_url"?: string
    }
  >
}
export const ListProviders200 = Schema.Struct({
  "data": Schema.Array(Schema.Struct({
    "name": Schema.String.annotate({ "description": "Display name of the provider" }),
    "slug": Schema.String.annotate({ "description": "URL-friendly identifier for the provider" }),
    "privacy_policy_url": Schema.String.annotate({ "description": "URL to the provider's privacy policy" }),
    "terms_of_service_url": Schema.optionalKey(
      Schema.String.annotate({ "description": "URL to the provider's terms of service" })
    ),
    "status_page_url": Schema.optionalKey(
      Schema.String.annotate({ "description": "URL to the provider's status page" })
    )
  }))
})
export type ListProviders500 = InternalServerResponse
export const ListProviders500 = InternalServerResponse
export type ListParams = { readonly "include_disabled"?: string; readonly "offset"?: string }
export const ListParams = Schema.Struct({
  "include_disabled": Schema.optionalKey(
    Schema.String.annotate({ "description": "Whether to include disabled API keys in the response" })
  ),
  "offset": Schema.optionalKey(Schema.String.annotate({ "description": "Number of API keys to skip for pagination" }))
})
export type List200 = {
  readonly "data": ReadonlyArray<
    {
      readonly "hash": string
      readonly "name": string
      readonly "label": string
      readonly "disabled": boolean
      readonly "limit": number
      readonly "limit_remaining": number
      readonly "limit_reset": string
      readonly "include_byok_in_limit": boolean
      readonly "usage": number
      readonly "usage_daily": number
      readonly "usage_weekly": number
      readonly "usage_monthly": number
      readonly "byok_usage": number
      readonly "byok_usage_daily": number
      readonly "byok_usage_weekly": number
      readonly "byok_usage_monthly": number
      readonly "created_at": string
      readonly "updated_at": string
      readonly "expires_at"?: string
    }
  >
}
export const List200 = Schema.Struct({
  "data": Schema.Array(Schema.Struct({
    "hash": Schema.String.annotate({ "description": "Unique hash identifier for the API key" }),
    "name": Schema.String.annotate({ "description": "Name of the API key" }),
    "label": Schema.String.annotate({ "description": "Human-readable label for the API key" }),
    "disabled": Schema.Boolean.annotate({ "description": "Whether the API key is disabled" }),
    "limit": Schema.Number.annotate({ "description": "Spending limit for the API key in USD" }).check(
      Schema.isFinite()
    ),
    "limit_remaining": Schema.Number.annotate({ "description": "Remaining spending limit in USD" }).check(
      Schema.isFinite()
    ),
    "limit_reset": Schema.String.annotate({ "description": "Type of limit reset for the API key" }),
    "include_byok_in_limit": Schema.Boolean.annotate({
      "description": "Whether to include external BYOK usage in the credit limit"
    }),
    "usage": Schema.Number.annotate({ "description": "Total OpenRouter credit usage (in USD) for the API key" }).check(
      Schema.isFinite()
    ),
    "usage_daily": Schema.Number.annotate({ "description": "OpenRouter credit usage (in USD) for the current UTC day" })
      .check(Schema.isFinite()),
    "usage_weekly": Schema.Number.annotate({
      "description": "OpenRouter credit usage (in USD) for the current UTC week (Monday-Sunday)"
    }).check(Schema.isFinite()),
    "usage_monthly": Schema.Number.annotate({
      "description": "OpenRouter credit usage (in USD) for the current UTC month"
    }).check(Schema.isFinite()),
    "byok_usage": Schema.Number.annotate({ "description": "Total external BYOK usage (in USD) for the API key" }).check(
      Schema.isFinite()
    ),
    "byok_usage_daily": Schema.Number.annotate({
      "description": "External BYOK usage (in USD) for the current UTC day"
    }).check(Schema.isFinite()),
    "byok_usage_weekly": Schema.Number.annotate({
      "description": "External BYOK usage (in USD) for the current UTC week (Monday-Sunday)"
    }).check(Schema.isFinite()),
    "byok_usage_monthly": Schema.Number.annotate({
      "description": "External BYOK usage (in USD) for current UTC month"
    }).check(Schema.isFinite()),
    "created_at": Schema.String.annotate({ "description": "ISO 8601 timestamp of when the API key was created" }),
    "updated_at": Schema.String.annotate({ "description": "ISO 8601 timestamp of when the API key was last updated" }),
    "expires_at": Schema.optionalKey(
      Schema.String.annotate({
        "description": "ISO 8601 UTC timestamp when the API key expires, or null if no expiration",
        "format": "date-time"
      })
    )
  })).annotate({ "description": "List of API keys" })
})
export type List401 = UnauthorizedResponse
export const List401 = UnauthorizedResponse
export type List429 = TooManyRequestsResponse
export const List429 = TooManyRequestsResponse
export type List500 = InternalServerResponse
export const List500 = InternalServerResponse
export type CreateKeysRequestJson = {
  readonly "name": string
  readonly "limit"?: number
  readonly "limit_reset"?: "daily" | "weekly" | "monthly"
  readonly "include_byok_in_limit"?: boolean
  readonly "expires_at"?: string
}
export const CreateKeysRequestJson = Schema.Struct({
  "name": Schema.String.annotate({ "description": "Name for the new API key" }).check(Schema.isMinLength(1)),
  "limit": Schema.optionalKey(
    Schema.Number.annotate({ "description": "Optional spending limit for the API key in USD" }).check(Schema.isFinite())
  ),
  "limit_reset": Schema.optionalKey(
    Schema.Literals(["daily", "weekly", "monthly"]).annotate({
      "description":
        "Type of limit reset for the API key (daily, weekly, monthly, or null for no reset). Resets happen automatically at midnight UTC, and weeks are Monday through Sunday."
    })
  ),
  "include_byok_in_limit": Schema.optionalKey(
    Schema.Boolean.annotate({ "description": "Whether to include BYOK usage in the limit" })
  ),
  "expires_at": Schema.optionalKey(
    Schema.String.annotate({
      "description":
        "Optional ISO 8601 UTC timestamp when the API key should expire. Must be UTC, other timezones will be rejected",
      "format": "date-time"
    })
  )
})
export type CreateKeys201 = {
  readonly "data": {
    readonly "hash": string
    readonly "name": string
    readonly "label": string
    readonly "disabled": boolean
    readonly "limit": number
    readonly "limit_remaining": number
    readonly "limit_reset": string
    readonly "include_byok_in_limit": boolean
    readonly "usage": number
    readonly "usage_daily": number
    readonly "usage_weekly": number
    readonly "usage_monthly": number
    readonly "byok_usage": number
    readonly "byok_usage_daily": number
    readonly "byok_usage_weekly": number
    readonly "byok_usage_monthly": number
    readonly "created_at": string
    readonly "updated_at": string
    readonly "expires_at"?: string
  }
  readonly "key": string
}
export const CreateKeys201 = Schema.Struct({
  "data": Schema.Struct({
    "hash": Schema.String.annotate({ "description": "Unique hash identifier for the API key" }),
    "name": Schema.String.annotate({ "description": "Name of the API key" }),
    "label": Schema.String.annotate({ "description": "Human-readable label for the API key" }),
    "disabled": Schema.Boolean.annotate({ "description": "Whether the API key is disabled" }),
    "limit": Schema.Number.annotate({ "description": "Spending limit for the API key in USD" }).check(
      Schema.isFinite()
    ),
    "limit_remaining": Schema.Number.annotate({ "description": "Remaining spending limit in USD" }).check(
      Schema.isFinite()
    ),
    "limit_reset": Schema.String.annotate({ "description": "Type of limit reset for the API key" }),
    "include_byok_in_limit": Schema.Boolean.annotate({
      "description": "Whether to include external BYOK usage in the credit limit"
    }),
    "usage": Schema.Number.annotate({ "description": "Total OpenRouter credit usage (in USD) for the API key" }).check(
      Schema.isFinite()
    ),
    "usage_daily": Schema.Number.annotate({ "description": "OpenRouter credit usage (in USD) for the current UTC day" })
      .check(Schema.isFinite()),
    "usage_weekly": Schema.Number.annotate({
      "description": "OpenRouter credit usage (in USD) for the current UTC week (Monday-Sunday)"
    }).check(Schema.isFinite()),
    "usage_monthly": Schema.Number.annotate({
      "description": "OpenRouter credit usage (in USD) for the current UTC month"
    }).check(Schema.isFinite()),
    "byok_usage": Schema.Number.annotate({ "description": "Total external BYOK usage (in USD) for the API key" }).check(
      Schema.isFinite()
    ),
    "byok_usage_daily": Schema.Number.annotate({
      "description": "External BYOK usage (in USD) for the current UTC day"
    }).check(Schema.isFinite()),
    "byok_usage_weekly": Schema.Number.annotate({
      "description": "External BYOK usage (in USD) for the current UTC week (Monday-Sunday)"
    }).check(Schema.isFinite()),
    "byok_usage_monthly": Schema.Number.annotate({
      "description": "External BYOK usage (in USD) for current UTC month"
    }).check(Schema.isFinite()),
    "created_at": Schema.String.annotate({ "description": "ISO 8601 timestamp of when the API key was created" }),
    "updated_at": Schema.String.annotate({ "description": "ISO 8601 timestamp of when the API key was last updated" }),
    "expires_at": Schema.optionalKey(
      Schema.String.annotate({
        "description": "ISO 8601 UTC timestamp when the API key expires, or null if no expiration",
        "format": "date-time"
      })
    )
  }).annotate({ "description": "The created API key information" }),
  "key": Schema.String.annotate({ "description": "The actual API key string (only shown once)" })
})
export type CreateKeys400 = BadRequestResponse
export const CreateKeys400 = BadRequestResponse
export type CreateKeys401 = UnauthorizedResponse
export const CreateKeys401 = UnauthorizedResponse
export type CreateKeys429 = TooManyRequestsResponse
export const CreateKeys429 = TooManyRequestsResponse
export type CreateKeys500 = InternalServerResponse
export const CreateKeys500 = InternalServerResponse
export type GetKey200 = {
  readonly "data": {
    readonly "hash": string
    readonly "name": string
    readonly "label": string
    readonly "disabled": boolean
    readonly "limit": number
    readonly "limit_remaining": number
    readonly "limit_reset": string
    readonly "include_byok_in_limit": boolean
    readonly "usage": number
    readonly "usage_daily": number
    readonly "usage_weekly": number
    readonly "usage_monthly": number
    readonly "byok_usage": number
    readonly "byok_usage_daily": number
    readonly "byok_usage_weekly": number
    readonly "byok_usage_monthly": number
    readonly "created_at": string
    readonly "updated_at": string
    readonly "expires_at"?: string
  }
}
export const GetKey200 = Schema.Struct({
  "data": Schema.Struct({
    "hash": Schema.String.annotate({ "description": "Unique hash identifier for the API key" }),
    "name": Schema.String.annotate({ "description": "Name of the API key" }),
    "label": Schema.String.annotate({ "description": "Human-readable label for the API key" }),
    "disabled": Schema.Boolean.annotate({ "description": "Whether the API key is disabled" }),
    "limit": Schema.Number.annotate({ "description": "Spending limit for the API key in USD" }).check(
      Schema.isFinite()
    ),
    "limit_remaining": Schema.Number.annotate({ "description": "Remaining spending limit in USD" }).check(
      Schema.isFinite()
    ),
    "limit_reset": Schema.String.annotate({ "description": "Type of limit reset for the API key" }),
    "include_byok_in_limit": Schema.Boolean.annotate({
      "description": "Whether to include external BYOK usage in the credit limit"
    }),
    "usage": Schema.Number.annotate({ "description": "Total OpenRouter credit usage (in USD) for the API key" }).check(
      Schema.isFinite()
    ),
    "usage_daily": Schema.Number.annotate({ "description": "OpenRouter credit usage (in USD) for the current UTC day" })
      .check(Schema.isFinite()),
    "usage_weekly": Schema.Number.annotate({
      "description": "OpenRouter credit usage (in USD) for the current UTC week (Monday-Sunday)"
    }).check(Schema.isFinite()),
    "usage_monthly": Schema.Number.annotate({
      "description": "OpenRouter credit usage (in USD) for the current UTC month"
    }).check(Schema.isFinite()),
    "byok_usage": Schema.Number.annotate({ "description": "Total external BYOK usage (in USD) for the API key" }).check(
      Schema.isFinite()
    ),
    "byok_usage_daily": Schema.Number.annotate({
      "description": "External BYOK usage (in USD) for the current UTC day"
    }).check(Schema.isFinite()),
    "byok_usage_weekly": Schema.Number.annotate({
      "description": "External BYOK usage (in USD) for the current UTC week (Monday-Sunday)"
    }).check(Schema.isFinite()),
    "byok_usage_monthly": Schema.Number.annotate({
      "description": "External BYOK usage (in USD) for current UTC month"
    }).check(Schema.isFinite()),
    "created_at": Schema.String.annotate({ "description": "ISO 8601 timestamp of when the API key was created" }),
    "updated_at": Schema.String.annotate({ "description": "ISO 8601 timestamp of when the API key was last updated" }),
    "expires_at": Schema.optionalKey(
      Schema.String.annotate({
        "description": "ISO 8601 UTC timestamp when the API key expires, or null if no expiration",
        "format": "date-time"
      })
    )
  }).annotate({ "description": "The API key information" })
})
export type GetKey401 = UnauthorizedResponse
export const GetKey401 = UnauthorizedResponse
export type GetKey404 = NotFoundResponse
export const GetKey404 = NotFoundResponse
export type GetKey429 = TooManyRequestsResponse
export const GetKey429 = TooManyRequestsResponse
export type GetKey500 = InternalServerResponse
export const GetKey500 = InternalServerResponse
export type DeleteKeys200 = { readonly "deleted": true }
export const DeleteKeys200 = Schema.Struct({
  "deleted": Schema.Literal(true).annotate({ "description": "Confirmation that the API key was deleted" })
})
export type DeleteKeys401 = UnauthorizedResponse
export const DeleteKeys401 = UnauthorizedResponse
export type DeleteKeys404 = NotFoundResponse
export const DeleteKeys404 = NotFoundResponse
export type DeleteKeys429 = TooManyRequestsResponse
export const DeleteKeys429 = TooManyRequestsResponse
export type DeleteKeys500 = InternalServerResponse
export const DeleteKeys500 = InternalServerResponse
export type UpdateKeysRequestJson = {
  readonly "name"?: string
  readonly "disabled"?: boolean
  readonly "limit"?: number
  readonly "limit_reset"?: "daily" | "weekly" | "monthly"
  readonly "include_byok_in_limit"?: boolean
}
export const UpdateKeysRequestJson = Schema.Struct({
  "name": Schema.optionalKey(Schema.String.annotate({ "description": "New name for the API key" })),
  "disabled": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Whether to disable the API key" })),
  "limit": Schema.optionalKey(
    Schema.Number.annotate({ "description": "New spending limit for the API key in USD" }).check(Schema.isFinite())
  ),
  "limit_reset": Schema.optionalKey(
    Schema.Literals(["daily", "weekly", "monthly"]).annotate({
      "description":
        "New limit reset type for the API key (daily, weekly, monthly, or null for no reset). Resets happen automatically at midnight UTC, and weeks are Monday through Sunday."
    })
  ),
  "include_byok_in_limit": Schema.optionalKey(
    Schema.Boolean.annotate({ "description": "Whether to include BYOK usage in the limit" })
  )
})
export type UpdateKeys200 = {
  readonly "data": {
    readonly "hash": string
    readonly "name": string
    readonly "label": string
    readonly "disabled": boolean
    readonly "limit": number
    readonly "limit_remaining": number
    readonly "limit_reset": string
    readonly "include_byok_in_limit": boolean
    readonly "usage": number
    readonly "usage_daily": number
    readonly "usage_weekly": number
    readonly "usage_monthly": number
    readonly "byok_usage": number
    readonly "byok_usage_daily": number
    readonly "byok_usage_weekly": number
    readonly "byok_usage_monthly": number
    readonly "created_at": string
    readonly "updated_at": string
    readonly "expires_at"?: string
  }
}
export const UpdateKeys200 = Schema.Struct({
  "data": Schema.Struct({
    "hash": Schema.String.annotate({ "description": "Unique hash identifier for the API key" }),
    "name": Schema.String.annotate({ "description": "Name of the API key" }),
    "label": Schema.String.annotate({ "description": "Human-readable label for the API key" }),
    "disabled": Schema.Boolean.annotate({ "description": "Whether the API key is disabled" }),
    "limit": Schema.Number.annotate({ "description": "Spending limit for the API key in USD" }).check(
      Schema.isFinite()
    ),
    "limit_remaining": Schema.Number.annotate({ "description": "Remaining spending limit in USD" }).check(
      Schema.isFinite()
    ),
    "limit_reset": Schema.String.annotate({ "description": "Type of limit reset for the API key" }),
    "include_byok_in_limit": Schema.Boolean.annotate({
      "description": "Whether to include external BYOK usage in the credit limit"
    }),
    "usage": Schema.Number.annotate({ "description": "Total OpenRouter credit usage (in USD) for the API key" }).check(
      Schema.isFinite()
    ),
    "usage_daily": Schema.Number.annotate({ "description": "OpenRouter credit usage (in USD) for the current UTC day" })
      .check(Schema.isFinite()),
    "usage_weekly": Schema.Number.annotate({
      "description": "OpenRouter credit usage (in USD) for the current UTC week (Monday-Sunday)"
    }).check(Schema.isFinite()),
    "usage_monthly": Schema.Number.annotate({
      "description": "OpenRouter credit usage (in USD) for the current UTC month"
    }).check(Schema.isFinite()),
    "byok_usage": Schema.Number.annotate({ "description": "Total external BYOK usage (in USD) for the API key" }).check(
      Schema.isFinite()
    ),
    "byok_usage_daily": Schema.Number.annotate({
      "description": "External BYOK usage (in USD) for the current UTC day"
    }).check(Schema.isFinite()),
    "byok_usage_weekly": Schema.Number.annotate({
      "description": "External BYOK usage (in USD) for the current UTC week (Monday-Sunday)"
    }).check(Schema.isFinite()),
    "byok_usage_monthly": Schema.Number.annotate({
      "description": "External BYOK usage (in USD) for current UTC month"
    }).check(Schema.isFinite()),
    "created_at": Schema.String.annotate({ "description": "ISO 8601 timestamp of when the API key was created" }),
    "updated_at": Schema.String.annotate({ "description": "ISO 8601 timestamp of when the API key was last updated" }),
    "expires_at": Schema.optionalKey(
      Schema.String.annotate({
        "description": "ISO 8601 UTC timestamp when the API key expires, or null if no expiration",
        "format": "date-time"
      })
    )
  }).annotate({ "description": "The updated API key information" })
})
export type UpdateKeys400 = BadRequestResponse
export const UpdateKeys400 = BadRequestResponse
export type UpdateKeys401 = UnauthorizedResponse
export const UpdateKeys401 = UnauthorizedResponse
export type UpdateKeys404 = NotFoundResponse
export const UpdateKeys404 = NotFoundResponse
export type UpdateKeys429 = TooManyRequestsResponse
export const UpdateKeys429 = TooManyRequestsResponse
export type UpdateKeys500 = InternalServerResponse
export const UpdateKeys500 = InternalServerResponse
export type ListGuardrailsParams = { readonly "offset"?: string; readonly "limit"?: string }
export const ListGuardrailsParams = Schema.Struct({
  "offset": Schema.optionalKey(Schema.String.annotate({ "description": "Number of records to skip for pagination" })),
  "limit": Schema.optionalKey(
    Schema.String.annotate({ "description": "Maximum number of records to return (max 100)" })
  )
})
export type ListGuardrails200 = {
  readonly "data": ReadonlyArray<
    {
      readonly "id": string
      readonly "name": string
      readonly "description"?: string
      readonly "limit_usd"?: number
      readonly "reset_interval"?: "daily" | "weekly" | "monthly"
      readonly "allowed_providers"?: ReadonlyArray<string>
      readonly "allowed_models"?: ReadonlyArray<string>
      readonly "enforce_zdr"?: boolean
      readonly "created_at": string
      readonly "updated_at"?: string
    }
  >
  readonly "total_count": number
}
export const ListGuardrails200 = Schema.Struct({
  "data": Schema.Array(Schema.Struct({
    "id": Schema.String.annotate({ "description": "Unique identifier for the guardrail", "format": "uuid" }),
    "name": Schema.String.annotate({ "description": "Name of the guardrail" }),
    "description": Schema.optionalKey(Schema.String.annotate({ "description": "Description of the guardrail" })),
    "limit_usd": Schema.optionalKey(
      Schema.Number.annotate({ "description": "Spending limit in USD" }).check(Schema.isFinite()).check(
        Schema.isGreaterThanOrEqualTo(0)
      )
    ),
    "reset_interval": Schema.optionalKey(
      Schema.Literals(["daily", "weekly", "monthly"]).annotate({
        "description": "Interval at which the limit resets (daily, weekly, monthly)"
      })
    ),
    "allowed_providers": Schema.optionalKey(
      Schema.Array(Schema.String).annotate({ "description": "List of allowed provider IDs" })
    ),
    "allowed_models": Schema.optionalKey(
      Schema.Array(Schema.String).annotate({ "description": "Array of model canonical_slugs (immutable identifiers)" })
    ),
    "enforce_zdr": Schema.optionalKey(
      Schema.Boolean.annotate({ "description": "Whether to enforce zero data retention" })
    ),
    "created_at": Schema.String.annotate({ "description": "ISO 8601 timestamp of when the guardrail was created" }),
    "updated_at": Schema.optionalKey(
      Schema.String.annotate({ "description": "ISO 8601 timestamp of when the guardrail was last updated" })
    )
  })).annotate({ "description": "List of guardrails" }),
  "total_count": Schema.Number.annotate({ "description": "Total number of guardrails" }).check(Schema.isFinite())
})
export type ListGuardrails401 = UnauthorizedResponse
export const ListGuardrails401 = UnauthorizedResponse
export type ListGuardrails500 = InternalServerResponse
export const ListGuardrails500 = InternalServerResponse
export type CreateGuardrailRequestJson = {
  readonly "name": string
  readonly "description"?: string
  readonly "limit_usd"?: number
  readonly "reset_interval"?: "daily" | "weekly" | "monthly"
  readonly "allowed_providers"?: ReadonlyArray<string>
  readonly "allowed_models"?: ReadonlyArray<string>
  readonly "enforce_zdr"?: boolean
}
export const CreateGuardrailRequestJson = Schema.Struct({
  "name": Schema.String.annotate({ "description": "Name for the new guardrail" }).check(Schema.isMinLength(1)).check(
    Schema.isMaxLength(200)
  ),
  "description": Schema.optionalKey(
    Schema.String.annotate({ "description": "Description of the guardrail" }).check(Schema.isMaxLength(1000))
  ),
  "limit_usd": Schema.optionalKey(
    Schema.Number.annotate({ "description": "Spending limit in USD" }).check(Schema.isFinite()).check(
      Schema.isGreaterThanOrEqualTo(0)
    )
  ),
  "reset_interval": Schema.optionalKey(
    Schema.Literals(["daily", "weekly", "monthly"]).annotate({
      "description": "Interval at which the limit resets (daily, weekly, monthly)"
    })
  ),
  "allowed_providers": Schema.optionalKey(
    Schema.Array(Schema.String).annotate({ "description": "List of allowed provider IDs" }).check(Schema.isMinLength(1))
  ),
  "allowed_models": Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      "description": "Array of model identifiers (slug or canonical_slug accepted)"
    }).check(Schema.isMinLength(1))
  ),
  "enforce_zdr": Schema.optionalKey(
    Schema.Boolean.annotate({ "description": "Whether to enforce zero data retention" })
  )
})
export type CreateGuardrail201 = {
  readonly "data": {
    readonly "id": string
    readonly "name": string
    readonly "description"?: string
    readonly "limit_usd"?: number
    readonly "reset_interval"?: "daily" | "weekly" | "monthly"
    readonly "allowed_providers"?: ReadonlyArray<string>
    readonly "allowed_models"?: ReadonlyArray<string>
    readonly "enforce_zdr"?: boolean
    readonly "created_at": string
    readonly "updated_at"?: string
  }
}
export const CreateGuardrail201 = Schema.Struct({
  "data": Schema.Struct({
    "id": Schema.String.annotate({ "description": "Unique identifier for the guardrail", "format": "uuid" }),
    "name": Schema.String.annotate({ "description": "Name of the guardrail" }),
    "description": Schema.optionalKey(Schema.String.annotate({ "description": "Description of the guardrail" })),
    "limit_usd": Schema.optionalKey(
      Schema.Number.annotate({ "description": "Spending limit in USD" }).check(Schema.isFinite()).check(
        Schema.isGreaterThanOrEqualTo(0)
      )
    ),
    "reset_interval": Schema.optionalKey(
      Schema.Literals(["daily", "weekly", "monthly"]).annotate({
        "description": "Interval at which the limit resets (daily, weekly, monthly)"
      })
    ),
    "allowed_providers": Schema.optionalKey(
      Schema.Array(Schema.String).annotate({ "description": "List of allowed provider IDs" })
    ),
    "allowed_models": Schema.optionalKey(
      Schema.Array(Schema.String).annotate({ "description": "Array of model canonical_slugs (immutable identifiers)" })
    ),
    "enforce_zdr": Schema.optionalKey(
      Schema.Boolean.annotate({ "description": "Whether to enforce zero data retention" })
    ),
    "created_at": Schema.String.annotate({ "description": "ISO 8601 timestamp of when the guardrail was created" }),
    "updated_at": Schema.optionalKey(
      Schema.String.annotate({ "description": "ISO 8601 timestamp of when the guardrail was last updated" })
    )
  }).annotate({ "description": "The created guardrail" })
})
export type CreateGuardrail400 = BadRequestResponse
export const CreateGuardrail400 = BadRequestResponse
export type CreateGuardrail401 = UnauthorizedResponse
export const CreateGuardrail401 = UnauthorizedResponse
export type CreateGuardrail500 = InternalServerResponse
export const CreateGuardrail500 = InternalServerResponse
export type GetGuardrail200 = {
  readonly "data": {
    readonly "id": string
    readonly "name": string
    readonly "description"?: string
    readonly "limit_usd"?: number
    readonly "reset_interval"?: "daily" | "weekly" | "monthly"
    readonly "allowed_providers"?: ReadonlyArray<string>
    readonly "allowed_models"?: ReadonlyArray<string>
    readonly "enforce_zdr"?: boolean
    readonly "created_at": string
    readonly "updated_at"?: string
  }
}
export const GetGuardrail200 = Schema.Struct({
  "data": Schema.Struct({
    "id": Schema.String.annotate({ "description": "Unique identifier for the guardrail", "format": "uuid" }),
    "name": Schema.String.annotate({ "description": "Name of the guardrail" }),
    "description": Schema.optionalKey(Schema.String.annotate({ "description": "Description of the guardrail" })),
    "limit_usd": Schema.optionalKey(
      Schema.Number.annotate({ "description": "Spending limit in USD" }).check(Schema.isFinite()).check(
        Schema.isGreaterThanOrEqualTo(0)
      )
    ),
    "reset_interval": Schema.optionalKey(
      Schema.Literals(["daily", "weekly", "monthly"]).annotate({
        "description": "Interval at which the limit resets (daily, weekly, monthly)"
      })
    ),
    "allowed_providers": Schema.optionalKey(
      Schema.Array(Schema.String).annotate({ "description": "List of allowed provider IDs" })
    ),
    "allowed_models": Schema.optionalKey(
      Schema.Array(Schema.String).annotate({ "description": "Array of model canonical_slugs (immutable identifiers)" })
    ),
    "enforce_zdr": Schema.optionalKey(
      Schema.Boolean.annotate({ "description": "Whether to enforce zero data retention" })
    ),
    "created_at": Schema.String.annotate({ "description": "ISO 8601 timestamp of when the guardrail was created" }),
    "updated_at": Schema.optionalKey(
      Schema.String.annotate({ "description": "ISO 8601 timestamp of when the guardrail was last updated" })
    )
  }).annotate({ "description": "The guardrail" })
})
export type GetGuardrail401 = UnauthorizedResponse
export const GetGuardrail401 = UnauthorizedResponse
export type GetGuardrail404 = NotFoundResponse
export const GetGuardrail404 = NotFoundResponse
export type GetGuardrail500 = InternalServerResponse
export const GetGuardrail500 = InternalServerResponse
export type DeleteGuardrail200 = { readonly "deleted": true }
export const DeleteGuardrail200 = Schema.Struct({
  "deleted": Schema.Literal(true).annotate({ "description": "Confirmation that the guardrail was deleted" })
})
export type DeleteGuardrail401 = UnauthorizedResponse
export const DeleteGuardrail401 = UnauthorizedResponse
export type DeleteGuardrail404 = NotFoundResponse
export const DeleteGuardrail404 = NotFoundResponse
export type DeleteGuardrail500 = InternalServerResponse
export const DeleteGuardrail500 = InternalServerResponse
export type UpdateGuardrailRequestJson = {
  readonly "name"?: string
  readonly "description"?: string
  readonly "limit_usd"?: number
  readonly "reset_interval"?: "daily" | "weekly" | "monthly"
  readonly "allowed_providers"?: ReadonlyArray<string>
  readonly "allowed_models"?: ReadonlyArray<string>
  readonly "enforce_zdr"?: boolean
}
export const UpdateGuardrailRequestJson = Schema.Struct({
  "name": Schema.optionalKey(
    Schema.String.annotate({ "description": "New name for the guardrail" }).check(Schema.isMinLength(1)).check(
      Schema.isMaxLength(200)
    )
  ),
  "description": Schema.optionalKey(
    Schema.String.annotate({ "description": "New description for the guardrail" }).check(Schema.isMaxLength(1000))
  ),
  "limit_usd": Schema.optionalKey(
    Schema.Number.annotate({ "description": "New spending limit in USD" }).check(Schema.isFinite()).check(
      Schema.isGreaterThanOrEqualTo(0)
    )
  ),
  "reset_interval": Schema.optionalKey(
    Schema.Literals(["daily", "weekly", "monthly"]).annotate({
      "description": "Interval at which the limit resets (daily, weekly, monthly)"
    })
  ),
  "allowed_providers": Schema.optionalKey(
    Schema.Array(Schema.String).annotate({ "description": "New list of allowed provider IDs" }).check(
      Schema.isMinLength(1)
    )
  ),
  "allowed_models": Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      "description": "Array of model identifiers (slug or canonical_slug accepted)"
    }).check(Schema.isMinLength(1))
  ),
  "enforce_zdr": Schema.optionalKey(
    Schema.Boolean.annotate({ "description": "Whether to enforce zero data retention" })
  )
})
export type UpdateGuardrail200 = {
  readonly "data": {
    readonly "id": string
    readonly "name": string
    readonly "description"?: string
    readonly "limit_usd"?: number
    readonly "reset_interval"?: "daily" | "weekly" | "monthly"
    readonly "allowed_providers"?: ReadonlyArray<string>
    readonly "allowed_models"?: ReadonlyArray<string>
    readonly "enforce_zdr"?: boolean
    readonly "created_at": string
    readonly "updated_at"?: string
  }
}
export const UpdateGuardrail200 = Schema.Struct({
  "data": Schema.Struct({
    "id": Schema.String.annotate({ "description": "Unique identifier for the guardrail", "format": "uuid" }),
    "name": Schema.String.annotate({ "description": "Name of the guardrail" }),
    "description": Schema.optionalKey(Schema.String.annotate({ "description": "Description of the guardrail" })),
    "limit_usd": Schema.optionalKey(
      Schema.Number.annotate({ "description": "Spending limit in USD" }).check(Schema.isFinite()).check(
        Schema.isGreaterThanOrEqualTo(0)
      )
    ),
    "reset_interval": Schema.optionalKey(
      Schema.Literals(["daily", "weekly", "monthly"]).annotate({
        "description": "Interval at which the limit resets (daily, weekly, monthly)"
      })
    ),
    "allowed_providers": Schema.optionalKey(
      Schema.Array(Schema.String).annotate({ "description": "List of allowed provider IDs" })
    ),
    "allowed_models": Schema.optionalKey(
      Schema.Array(Schema.String).annotate({ "description": "Array of model canonical_slugs (immutable identifiers)" })
    ),
    "enforce_zdr": Schema.optionalKey(
      Schema.Boolean.annotate({ "description": "Whether to enforce zero data retention" })
    ),
    "created_at": Schema.String.annotate({ "description": "ISO 8601 timestamp of when the guardrail was created" }),
    "updated_at": Schema.optionalKey(
      Schema.String.annotate({ "description": "ISO 8601 timestamp of when the guardrail was last updated" })
    )
  }).annotate({ "description": "The updated guardrail" })
})
export type UpdateGuardrail400 = BadRequestResponse
export const UpdateGuardrail400 = BadRequestResponse
export type UpdateGuardrail401 = UnauthorizedResponse
export const UpdateGuardrail401 = UnauthorizedResponse
export type UpdateGuardrail404 = NotFoundResponse
export const UpdateGuardrail404 = NotFoundResponse
export type UpdateGuardrail500 = InternalServerResponse
export const UpdateGuardrail500 = InternalServerResponse
export type ListKeyAssignmentsParams = { readonly "offset"?: string; readonly "limit"?: string }
export const ListKeyAssignmentsParams = Schema.Struct({
  "offset": Schema.optionalKey(Schema.String.annotate({ "description": "Number of records to skip for pagination" })),
  "limit": Schema.optionalKey(
    Schema.String.annotate({ "description": "Maximum number of records to return (max 100)" })
  )
})
export type ListKeyAssignments200 = {
  readonly "data": ReadonlyArray<
    {
      readonly "id": string
      readonly "key_hash": string
      readonly "guardrail_id": string
      readonly "key_name": string
      readonly "key_label": string
      readonly "assigned_by": string
      readonly "created_at": string
    }
  >
  readonly "total_count": number
}
export const ListKeyAssignments200 = Schema.Struct({
  "data": Schema.Array(Schema.Struct({
    "id": Schema.String.annotate({ "description": "Unique identifier for the assignment", "format": "uuid" }),
    "key_hash": Schema.String.annotate({ "description": "Hash of the assigned API key" }),
    "guardrail_id": Schema.String.annotate({ "description": "ID of the guardrail", "format": "uuid" }),
    "key_name": Schema.String.annotate({ "description": "Name of the API key" }),
    "key_label": Schema.String.annotate({ "description": "Label of the API key" }),
    "assigned_by": Schema.String.annotate({ "description": "User ID of who made the assignment" }),
    "created_at": Schema.String.annotate({ "description": "ISO 8601 timestamp of when the assignment was created" })
  })).annotate({ "description": "List of key assignments" }),
  "total_count": Schema.Number.annotate({ "description": "Total number of key assignments for this guardrail" }).check(
    Schema.isFinite()
  )
})
export type ListKeyAssignments401 = UnauthorizedResponse
export const ListKeyAssignments401 = UnauthorizedResponse
export type ListKeyAssignments500 = InternalServerResponse
export const ListKeyAssignments500 = InternalServerResponse
export type ListMemberAssignmentsParams = { readonly "offset"?: string; readonly "limit"?: string }
export const ListMemberAssignmentsParams = Schema.Struct({
  "offset": Schema.optionalKey(Schema.String.annotate({ "description": "Number of records to skip for pagination" })),
  "limit": Schema.optionalKey(
    Schema.String.annotate({ "description": "Maximum number of records to return (max 100)" })
  )
})
export type ListMemberAssignments200 = {
  readonly "data": ReadonlyArray<
    {
      readonly "id": string
      readonly "user_id": string
      readonly "organization_id": string
      readonly "guardrail_id": string
      readonly "assigned_by": string
      readonly "created_at": string
    }
  >
  readonly "total_count": number
}
export const ListMemberAssignments200 = Schema.Struct({
  "data": Schema.Array(Schema.Struct({
    "id": Schema.String.annotate({ "description": "Unique identifier for the assignment", "format": "uuid" }),
    "user_id": Schema.String.annotate({ "description": "Clerk user ID of the assigned member" }),
    "organization_id": Schema.String.annotate({ "description": "Organization ID" }),
    "guardrail_id": Schema.String.annotate({ "description": "ID of the guardrail", "format": "uuid" }),
    "assigned_by": Schema.String.annotate({ "description": "User ID of who made the assignment" }),
    "created_at": Schema.String.annotate({ "description": "ISO 8601 timestamp of when the assignment was created" })
  })).annotate({ "description": "List of member assignments" }),
  "total_count": Schema.Number.annotate({ "description": "Total number of member assignments" }).check(
    Schema.isFinite()
  )
})
export type ListMemberAssignments401 = UnauthorizedResponse
export const ListMemberAssignments401 = UnauthorizedResponse
export type ListMemberAssignments500 = InternalServerResponse
export const ListMemberAssignments500 = InternalServerResponse
export type ListGuardrailKeyAssignmentsParams = { readonly "offset"?: string; readonly "limit"?: string }
export const ListGuardrailKeyAssignmentsParams = Schema.Struct({
  "offset": Schema.optionalKey(Schema.String.annotate({ "description": "Number of records to skip for pagination" })),
  "limit": Schema.optionalKey(
    Schema.String.annotate({ "description": "Maximum number of records to return (max 100)" })
  )
})
export type ListGuardrailKeyAssignments200 = {
  readonly "data": ReadonlyArray<
    {
      readonly "id": string
      readonly "key_hash": string
      readonly "guardrail_id": string
      readonly "key_name": string
      readonly "key_label": string
      readonly "assigned_by": string
      readonly "created_at": string
    }
  >
  readonly "total_count": number
}
export const ListGuardrailKeyAssignments200 = Schema.Struct({
  "data": Schema.Array(Schema.Struct({
    "id": Schema.String.annotate({ "description": "Unique identifier for the assignment", "format": "uuid" }),
    "key_hash": Schema.String.annotate({ "description": "Hash of the assigned API key" }),
    "guardrail_id": Schema.String.annotate({ "description": "ID of the guardrail", "format": "uuid" }),
    "key_name": Schema.String.annotate({ "description": "Name of the API key" }),
    "key_label": Schema.String.annotate({ "description": "Label of the API key" }),
    "assigned_by": Schema.String.annotate({ "description": "User ID of who made the assignment" }),
    "created_at": Schema.String.annotate({ "description": "ISO 8601 timestamp of when the assignment was created" })
  })).annotate({ "description": "List of key assignments" }),
  "total_count": Schema.Number.annotate({ "description": "Total number of key assignments for this guardrail" }).check(
    Schema.isFinite()
  )
})
export type ListGuardrailKeyAssignments401 = UnauthorizedResponse
export const ListGuardrailKeyAssignments401 = UnauthorizedResponse
export type ListGuardrailKeyAssignments404 = NotFoundResponse
export const ListGuardrailKeyAssignments404 = NotFoundResponse
export type ListGuardrailKeyAssignments500 = InternalServerResponse
export const ListGuardrailKeyAssignments500 = InternalServerResponse
export type BulkAssignKeysToGuardrailRequestJson = { readonly "key_hashes": ReadonlyArray<string> }
export const BulkAssignKeysToGuardrailRequestJson = Schema.Struct({
  "key_hashes": Schema.Array(Schema.String.check(Schema.isMinLength(1))).annotate({
    "description": "Array of API key hashes to assign to the guardrail"
  }).check(Schema.isMinLength(1))
})
export type BulkAssignKeysToGuardrail200 = { readonly "assigned_count": number }
export const BulkAssignKeysToGuardrail200 = Schema.Struct({
  "assigned_count": Schema.Number.annotate({ "description": "Number of keys successfully assigned" }).check(
    Schema.isFinite()
  )
})
export type BulkAssignKeysToGuardrail400 = BadRequestResponse
export const BulkAssignKeysToGuardrail400 = BadRequestResponse
export type BulkAssignKeysToGuardrail401 = UnauthorizedResponse
export const BulkAssignKeysToGuardrail401 = UnauthorizedResponse
export type BulkAssignKeysToGuardrail404 = NotFoundResponse
export const BulkAssignKeysToGuardrail404 = NotFoundResponse
export type BulkAssignKeysToGuardrail500 = InternalServerResponse
export const BulkAssignKeysToGuardrail500 = InternalServerResponse
export type ListGuardrailMemberAssignmentsParams = { readonly "offset"?: string; readonly "limit"?: string }
export const ListGuardrailMemberAssignmentsParams = Schema.Struct({
  "offset": Schema.optionalKey(Schema.String.annotate({ "description": "Number of records to skip for pagination" })),
  "limit": Schema.optionalKey(
    Schema.String.annotate({ "description": "Maximum number of records to return (max 100)" })
  )
})
export type ListGuardrailMemberAssignments200 = {
  readonly "data": ReadonlyArray<
    {
      readonly "id": string
      readonly "user_id": string
      readonly "organization_id": string
      readonly "guardrail_id": string
      readonly "assigned_by": string
      readonly "created_at": string
    }
  >
  readonly "total_count": number
}
export const ListGuardrailMemberAssignments200 = Schema.Struct({
  "data": Schema.Array(Schema.Struct({
    "id": Schema.String.annotate({ "description": "Unique identifier for the assignment", "format": "uuid" }),
    "user_id": Schema.String.annotate({ "description": "Clerk user ID of the assigned member" }),
    "organization_id": Schema.String.annotate({ "description": "Organization ID" }),
    "guardrail_id": Schema.String.annotate({ "description": "ID of the guardrail", "format": "uuid" }),
    "assigned_by": Schema.String.annotate({ "description": "User ID of who made the assignment" }),
    "created_at": Schema.String.annotate({ "description": "ISO 8601 timestamp of when the assignment was created" })
  })).annotate({ "description": "List of member assignments" }),
  "total_count": Schema.Number.annotate({ "description": "Total number of member assignments" }).check(
    Schema.isFinite()
  )
})
export type ListGuardrailMemberAssignments401 = UnauthorizedResponse
export const ListGuardrailMemberAssignments401 = UnauthorizedResponse
export type ListGuardrailMemberAssignments404 = NotFoundResponse
export const ListGuardrailMemberAssignments404 = NotFoundResponse
export type ListGuardrailMemberAssignments500 = InternalServerResponse
export const ListGuardrailMemberAssignments500 = InternalServerResponse
export type BulkAssignMembersToGuardrailRequestJson = { readonly "member_user_ids": ReadonlyArray<string> }
export const BulkAssignMembersToGuardrailRequestJson = Schema.Struct({
  "member_user_ids": Schema.Array(Schema.String.check(Schema.isMinLength(1))).annotate({
    "description": "Array of member user IDs to assign to the guardrail"
  }).check(Schema.isMinLength(1))
})
export type BulkAssignMembersToGuardrail200 = { readonly "assigned_count": number }
export const BulkAssignMembersToGuardrail200 = Schema.Struct({
  "assigned_count": Schema.Number.annotate({ "description": "Number of members successfully assigned" }).check(
    Schema.isFinite()
  )
})
export type BulkAssignMembersToGuardrail400 = BadRequestResponse
export const BulkAssignMembersToGuardrail400 = BadRequestResponse
export type BulkAssignMembersToGuardrail401 = UnauthorizedResponse
export const BulkAssignMembersToGuardrail401 = UnauthorizedResponse
export type BulkAssignMembersToGuardrail404 = NotFoundResponse
export const BulkAssignMembersToGuardrail404 = NotFoundResponse
export type BulkAssignMembersToGuardrail500 = InternalServerResponse
export const BulkAssignMembersToGuardrail500 = InternalServerResponse
export type BulkUnassignKeysFromGuardrailRequestJson = { readonly "key_hashes": ReadonlyArray<string> }
export const BulkUnassignKeysFromGuardrailRequestJson = Schema.Struct({
  "key_hashes": Schema.Array(Schema.String.check(Schema.isMinLength(1))).annotate({
    "description": "Array of API key hashes to unassign from the guardrail"
  }).check(Schema.isMinLength(1))
})
export type BulkUnassignKeysFromGuardrail200 = { readonly "unassigned_count": number }
export const BulkUnassignKeysFromGuardrail200 = Schema.Struct({
  "unassigned_count": Schema.Number.annotate({ "description": "Number of keys successfully unassigned" }).check(
    Schema.isFinite()
  )
})
export type BulkUnassignKeysFromGuardrail400 = BadRequestResponse
export const BulkUnassignKeysFromGuardrail400 = BadRequestResponse
export type BulkUnassignKeysFromGuardrail401 = UnauthorizedResponse
export const BulkUnassignKeysFromGuardrail401 = UnauthorizedResponse
export type BulkUnassignKeysFromGuardrail404 = NotFoundResponse
export const BulkUnassignKeysFromGuardrail404 = NotFoundResponse
export type BulkUnassignKeysFromGuardrail500 = InternalServerResponse
export const BulkUnassignKeysFromGuardrail500 = InternalServerResponse
export type BulkUnassignMembersFromGuardrailRequestJson = { readonly "member_user_ids": ReadonlyArray<string> }
export const BulkUnassignMembersFromGuardrailRequestJson = Schema.Struct({
  "member_user_ids": Schema.Array(Schema.String.check(Schema.isMinLength(1))).annotate({
    "description": "Array of member user IDs to unassign from the guardrail"
  }).check(Schema.isMinLength(1))
})
export type BulkUnassignMembersFromGuardrail200 = { readonly "unassigned_count": number }
export const BulkUnassignMembersFromGuardrail200 = Schema.Struct({
  "unassigned_count": Schema.Number.annotate({ "description": "Number of members successfully unassigned" }).check(
    Schema.isFinite()
  )
})
export type BulkUnassignMembersFromGuardrail400 = BadRequestResponse
export const BulkUnassignMembersFromGuardrail400 = BadRequestResponse
export type BulkUnassignMembersFromGuardrail401 = UnauthorizedResponse
export const BulkUnassignMembersFromGuardrail401 = UnauthorizedResponse
export type BulkUnassignMembersFromGuardrail404 = NotFoundResponse
export const BulkUnassignMembersFromGuardrail404 = NotFoundResponse
export type BulkUnassignMembersFromGuardrail500 = InternalServerResponse
export const BulkUnassignMembersFromGuardrail500 = InternalServerResponse
export type GetCurrentKey200 = {
  readonly "data": {
    readonly "label": string
    readonly "limit": number
    readonly "usage": number
    readonly "usage_daily": number
    readonly "usage_weekly": number
    readonly "usage_monthly": number
    readonly "byok_usage": number
    readonly "byok_usage_daily": number
    readonly "byok_usage_weekly": number
    readonly "byok_usage_monthly": number
    readonly "is_free_tier": boolean
    readonly "is_management_key": boolean
    readonly "is_provisioning_key": boolean
    readonly "limit_remaining": number
    readonly "limit_reset": string
    readonly "include_byok_in_limit": boolean
    readonly "expires_at"?: string
    readonly "rate_limit": { readonly "requests": number; readonly "interval": string; readonly "note": string }
  }
}
export const GetCurrentKey200 = Schema.Struct({
  "data": Schema.Struct({
    "label": Schema.String.annotate({ "description": "Human-readable label for the API key" }),
    "limit": Schema.Number.annotate({ "description": "Spending limit for the API key in USD" }).check(
      Schema.isFinite()
    ),
    "usage": Schema.Number.annotate({ "description": "Total OpenRouter credit usage (in USD) for the API key" }).check(
      Schema.isFinite()
    ),
    "usage_daily": Schema.Number.annotate({ "description": "OpenRouter credit usage (in USD) for the current UTC day" })
      .check(Schema.isFinite()),
    "usage_weekly": Schema.Number.annotate({
      "description": "OpenRouter credit usage (in USD) for the current UTC week (Monday-Sunday)"
    }).check(Schema.isFinite()),
    "usage_monthly": Schema.Number.annotate({
      "description": "OpenRouter credit usage (in USD) for the current UTC month"
    }).check(Schema.isFinite()),
    "byok_usage": Schema.Number.annotate({ "description": "Total external BYOK usage (in USD) for the API key" }).check(
      Schema.isFinite()
    ),
    "byok_usage_daily": Schema.Number.annotate({
      "description": "External BYOK usage (in USD) for the current UTC day"
    }).check(Schema.isFinite()),
    "byok_usage_weekly": Schema.Number.annotate({
      "description": "External BYOK usage (in USD) for the current UTC week (Monday-Sunday)"
    }).check(Schema.isFinite()),
    "byok_usage_monthly": Schema.Number.annotate({
      "description": "External BYOK usage (in USD) for current UTC month"
    }).check(Schema.isFinite()),
    "is_free_tier": Schema.Boolean.annotate({ "description": "Whether this is a free tier API key" }),
    "is_management_key": Schema.Boolean.annotate({ "description": "Whether this is a management key" }),
    "is_provisioning_key": Schema.Boolean.annotate({ "description": "Whether this is a management key" }),
    "limit_remaining": Schema.Number.annotate({ "description": "Remaining spending limit in USD" }).check(
      Schema.isFinite()
    ),
    "limit_reset": Schema.String.annotate({ "description": "Type of limit reset for the API key" }),
    "include_byok_in_limit": Schema.Boolean.annotate({
      "description": "Whether to include external BYOK usage in the credit limit"
    }),
    "expires_at": Schema.optionalKey(
      Schema.String.annotate({
        "description": "ISO 8601 UTC timestamp when the API key expires, or null if no expiration",
        "format": "date-time"
      })
    ),
    "rate_limit": Schema.Struct({
      "requests": Schema.Number.annotate({ "description": "Number of requests allowed per interval" }).check(
        Schema.isFinite()
      ),
      "interval": Schema.String.annotate({ "description": "Rate limit interval" }),
      "note": Schema.String.annotate({ "description": "Note about the rate limit" })
    }).annotate({ "description": "Legacy rate limit information about a key. Will always return -1." })
  }).annotate({ "description": "Current API key information" })
})
export type GetCurrentKey401 = UnauthorizedResponse
export const GetCurrentKey401 = UnauthorizedResponse
export type GetCurrentKey500 = InternalServerResponse
export const GetCurrentKey500 = InternalServerResponse
export type ExchangeAuthCodeForAPIKeyRequestJson = {
  readonly "code": string
  readonly "code_verifier"?: string
  readonly "code_challenge_method"?: "S256" | "plain"
}
export const ExchangeAuthCodeForAPIKeyRequestJson = Schema.Struct({
  "code": Schema.String.annotate({ "description": "The authorization code received from the OAuth redirect" }),
  "code_verifier": Schema.optionalKey(
    Schema.String.annotate({
      "description": "The code verifier if code_challenge was used in the authorization request"
    })
  ),
  "code_challenge_method": Schema.optionalKey(
    Schema.Literals(["S256", "plain"]).annotate({ "description": "The method used to generate the code challenge" })
  )
})
export type ExchangeAuthCodeForAPIKey200 = { readonly "key": string; readonly "user_id": string }
export const ExchangeAuthCodeForAPIKey200 = Schema.Struct({
  "key": Schema.String.annotate({ "description": "The API key to use for OpenRouter requests" }),
  "user_id": Schema.String.annotate({ "description": "User ID associated with the API key" })
})
export type ExchangeAuthCodeForAPIKey400 = BadRequestResponse
export const ExchangeAuthCodeForAPIKey400 = BadRequestResponse
export type ExchangeAuthCodeForAPIKey403 = ForbiddenResponse
export const ExchangeAuthCodeForAPIKey403 = ForbiddenResponse
export type ExchangeAuthCodeForAPIKey500 = InternalServerResponse
export const ExchangeAuthCodeForAPIKey500 = InternalServerResponse
export type CreateAuthKeysCodeRequestJson = {
  readonly "callback_url": string
  readonly "code_challenge"?: string
  readonly "code_challenge_method"?: "S256" | "plain"
  readonly "limit"?: number
  readonly "expires_at"?: string
}
export const CreateAuthKeysCodeRequestJson = Schema.Struct({
  "callback_url": Schema.String.annotate({
    "description":
      "The callback URL to redirect to after authorization. Note, only https URLs on ports 443 and 3000 are allowed.",
    "format": "uri"
  }),
  "code_challenge": Schema.optionalKey(
    Schema.String.annotate({ "description": "PKCE code challenge for enhanced security" })
  ),
  "code_challenge_method": Schema.optionalKey(
    Schema.Literals(["S256", "plain"]).annotate({ "description": "The method used to generate the code challenge" })
  ),
  "limit": Schema.optionalKey(
    Schema.Number.annotate({ "description": "Credit limit for the API key to be created" }).check(Schema.isFinite())
  ),
  "expires_at": Schema.optionalKey(
    Schema.String.annotate({
      "description": "Optional expiration time for the API key to be created",
      "format": "date-time"
    })
  )
})
export type CreateAuthKeysCode200 = {
  readonly "data": { readonly "id": string; readonly "app_id": number; readonly "created_at": string }
}
export const CreateAuthKeysCode200 = Schema.Struct({
  "data": Schema.Struct({
    "id": Schema.String.annotate({ "description": "The authorization code ID to use in the exchange request" }),
    "app_id": Schema.Number.annotate({ "description": "The application ID associated with this auth code" }).check(
      Schema.isFinite()
    ),
    "created_at": Schema.String.annotate({ "description": "ISO 8601 timestamp of when the auth code was created" })
  }).annotate({ "description": "Auth code data" })
})
export type CreateAuthKeysCode400 = BadRequestResponse
export const CreateAuthKeysCode400 = BadRequestResponse
export type CreateAuthKeysCode401 = UnauthorizedResponse
export const CreateAuthKeysCode401 = UnauthorizedResponse
export type CreateAuthKeysCode500 = InternalServerResponse
export const CreateAuthKeysCode500 = InternalServerResponse
export type SendChatCompletionRequestRequestJson = ChatGenerationParams
export const SendChatCompletionRequestRequestJson = ChatGenerationParams
export type SendChatCompletionRequest200 = {
  readonly "id": string
  readonly "choices": ReadonlyArray<ChatResponseChoice>
  readonly "created": number
  readonly "model": string
  readonly "object": "chat.completion"
  readonly "system_fingerprint"?: string | null
  readonly "usage"?: ChatGenerationTokenUsage
}
export const SendChatCompletionRequest200 = Schema.Struct({
  "id": Schema.String,
  "choices": Schema.Array(ChatResponseChoice),
  "created": Schema.Number.check(Schema.isFinite()),
  "model": Schema.String,
  "object": Schema.Literal("chat.completion"),
  "system_fingerprint": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  "usage": Schema.optionalKey(ChatGenerationTokenUsage)
}).annotate({ "description": "Chat completion response" })
export type SendChatCompletionRequest200Sse = ChatStreamingResponseChunk
export const SendChatCompletionRequest200Sse = ChatStreamingResponseChunk
export type SendChatCompletionRequest400 = ChatError
export const SendChatCompletionRequest400 = ChatError
export type SendChatCompletionRequest401 = ChatError
export const SendChatCompletionRequest401 = ChatError
export type SendChatCompletionRequest429 = ChatError
export const SendChatCompletionRequest429 = ChatError
export type SendChatCompletionRequest500 = ChatError
export const SendChatCompletionRequest500 = ChatError

export interface OperationConfig {
  /**
   * Whether or not the response should be included in the value returned from
   * an operation.
   *
   * If set to `true`, a tuple of `[A, HttpClientResponse]` will be returned,
   * where `A` is the success type of the operation.
   *
   * If set to `false`, only the success type of the operation will be returned.
   */
  readonly includeResponse?: boolean | undefined
}

/**
 * A utility type which optionally includes the response in the return result
 * of an operation based upon the value of the `includeResponse` configuration
 * option.
 */
export type WithOptionalResponse<A, Config extends OperationConfig> = Config extends {
  readonly includeResponse: true
} ? [A, HttpClientResponse.HttpClientResponse] :
  A

export const make = (
  httpClient: HttpClient.HttpClient,
  options: {
    readonly transformClient?: ((client: HttpClient.HttpClient) => Effect.Effect<HttpClient.HttpClient>) | undefined
  } = {}
): OpenRouterClient => {
  const unexpectedStatus = (response: HttpClientResponse.HttpClientResponse) =>
    Effect.flatMap(
      Effect.orElseSucceed(response.json, () => "Unexpected status code"),
      (description) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.StatusCodeError({
              request: response.request,
              response,
              description: typeof description === "string" ? description : JSON.stringify(description)
            })
          })
        )
    )
  const withResponse = <Config extends OperationConfig>(config: Config | undefined) =>
  (
    f: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<any, any>
  ): (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<any, any> => {
    const withOptionalResponse = (
      config?.includeResponse
        ? (response: HttpClientResponse.HttpClientResponse) => Effect.map(f(response), (a) => [a, response])
        : (response: HttpClientResponse.HttpClientResponse) => f(response)
    ) as any
    return options?.transformClient
      ? (request) =>
        Effect.flatMap(
          Effect.flatMap(options.transformClient!(httpClient), (client) => client.execute(request)),
          withOptionalResponse
        )
      : (request) => Effect.flatMap(httpClient.execute(request), withOptionalResponse)
  }
  const sseRequest = <
    Type,
    DecodingServices
  >(
    schema: Schema.Decoder<Type, DecodingServices>
  ) =>
  (
    request: HttpClientRequest.HttpClientRequest
  ): Stream.Stream<
    { readonly event: string; readonly id: string | undefined; readonly data: Type },
    HttpClientError.HttpClientError | SchemaError | Sse.Retry,
    DecodingServices
  > =>
    HttpClient.filterStatusOk(httpClient).execute(request).pipe(
      Effect.map((response) => response.stream),
      Stream.unwrap,
      Stream.decodeText(),
      Stream.pipeThroughChannel(Sse.decodeDataSchema(schema))
    )
  const decodeSuccess =
    <Schema extends Schema.Top>(schema: Schema) => (response: HttpClientResponse.HttpClientResponse) =>
      HttpClientResponse.schemaBodyJson(schema)(response)
  const decodeError =
    <const Tag extends string, Schema extends Schema.Top>(tag: Tag, schema: Schema) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      Effect.flatMap(
        HttpClientResponse.schemaBodyJson(schema)(response),
        (cause) => Effect.fail(OpenRouterClientError(tag, cause, response))
      )
  return {
    httpClient,
    "createResponses": (options) =>
      HttpClientRequest.post(`/responses`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(CreateResponses200),
          "400": decodeError("CreateResponses400", CreateResponses400),
          "401": decodeError("CreateResponses401", CreateResponses401),
          "402": decodeError("CreateResponses402", CreateResponses402),
          "404": decodeError("CreateResponses404", CreateResponses404),
          "408": decodeError("CreateResponses408", CreateResponses408),
          "413": decodeError("CreateResponses413", CreateResponses413),
          "422": decodeError("CreateResponses422", CreateResponses422),
          "429": decodeError("CreateResponses429", CreateResponses429),
          "500": decodeError("CreateResponses500", CreateResponses500),
          "502": decodeError("CreateResponses502", CreateResponses502),
          "503": decodeError("CreateResponses503", CreateResponses503),
          "524": decodeError("CreateResponses524", CreateResponses524),
          "529": decodeError("CreateResponses529", CreateResponses529),
          orElse: unexpectedStatus
        }))
      ),
    "createResponsesSse": (options) =>
      HttpClientRequest.post(`/responses`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        sseRequest(CreateResponses200Sse)
      ),
    "createMessages": (options) =>
      HttpClientRequest.post(`/messages`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(CreateMessages200),
          "400": decodeError("CreateMessages400", CreateMessages400),
          "401": decodeError("CreateMessages401", CreateMessages401),
          "403": decodeError("CreateMessages403", CreateMessages403),
          "404": decodeError("CreateMessages404", CreateMessages404),
          "429": decodeError("CreateMessages429", CreateMessages429),
          "500": decodeError("CreateMessages500", CreateMessages500),
          "503": decodeError("CreateMessages503", CreateMessages503),
          "529": decodeError("CreateMessages529", CreateMessages529),
          orElse: unexpectedStatus
        }))
      ),
    "createMessagesSse": (options) =>
      HttpClientRequest.post(`/messages`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        sseRequest(CreateMessages200Sse)
      ),
    "getUserActivity": (options) =>
      HttpClientRequest.get(`/activity`).pipe(
        HttpClientRequest.setUrlParams({ "date": options?.params?.["date"] as any }),
        withResponse(options?.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(GetUserActivity200),
          "400": decodeError("GetUserActivity400", GetUserActivity400),
          "401": decodeError("GetUserActivity401", GetUserActivity401),
          "403": decodeError("GetUserActivity403", GetUserActivity403),
          "500": decodeError("GetUserActivity500", GetUserActivity500),
          orElse: unexpectedStatus
        }))
      ),
    "getCredits": (options) =>
      HttpClientRequest.get(`/credits`).pipe(
        withResponse(options?.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(GetCredits200),
          "401": decodeError("GetCredits401", GetCredits401),
          "403": decodeError("GetCredits403", GetCredits403),
          "500": decodeError("GetCredits500", GetCredits500),
          orElse: unexpectedStatus
        }))
      ),
    "createCoinbaseCharge": (options) =>
      HttpClientRequest.post(`/credits/coinbase`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(CreateCoinbaseCharge200),
          "400": decodeError("CreateCoinbaseCharge400", CreateCoinbaseCharge400),
          "401": decodeError("CreateCoinbaseCharge401", CreateCoinbaseCharge401),
          "429": decodeError("CreateCoinbaseCharge429", CreateCoinbaseCharge429),
          "500": decodeError("CreateCoinbaseCharge500", CreateCoinbaseCharge500),
          orElse: unexpectedStatus
        }))
      ),
    "createEmbeddings": (options) =>
      HttpClientRequest.post(`/embeddings`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(CreateEmbeddings200),
          "400": decodeError("CreateEmbeddings400", CreateEmbeddings400),
          "401": decodeError("CreateEmbeddings401", CreateEmbeddings401),
          "402": decodeError("CreateEmbeddings402", CreateEmbeddings402),
          "404": decodeError("CreateEmbeddings404", CreateEmbeddings404),
          "429": decodeError("CreateEmbeddings429", CreateEmbeddings429),
          "500": decodeError("CreateEmbeddings500", CreateEmbeddings500),
          "502": decodeError("CreateEmbeddings502", CreateEmbeddings502),
          "503": decodeError("CreateEmbeddings503", CreateEmbeddings503),
          "524": decodeError("CreateEmbeddings524", CreateEmbeddings524),
          "529": decodeError("CreateEmbeddings529", CreateEmbeddings529),
          orElse: unexpectedStatus
        }))
      ),
    "createEmbeddingsSse": (options) =>
      HttpClientRequest.post(`/embeddings`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        sseRequest(CreateEmbeddings200Sse)
      ),
    "listEmbeddingsModels": (options) =>
      HttpClientRequest.get(`/embeddings/models`).pipe(
        withResponse(options?.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(ListEmbeddingsModels200),
          "400": decodeError("ListEmbeddingsModels400", ListEmbeddingsModels400),
          "500": decodeError("ListEmbeddingsModels500", ListEmbeddingsModels500),
          orElse: unexpectedStatus
        }))
      ),
    "getGeneration": (options) =>
      HttpClientRequest.get(`/generation`).pipe(
        HttpClientRequest.setUrlParams({ "id": options.params["id"] as any }),
        withResponse(options.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(GetGeneration200),
          "401": decodeError("GetGeneration401", GetGeneration401),
          "402": decodeError("GetGeneration402", GetGeneration402),
          "404": decodeError("GetGeneration404", GetGeneration404),
          "429": decodeError("GetGeneration429", GetGeneration429),
          "500": decodeError("GetGeneration500", GetGeneration500),
          "502": decodeError("GetGeneration502", GetGeneration502),
          "524": decodeError("GetGeneration524", GetGeneration524),
          "529": decodeError("GetGeneration529", GetGeneration529),
          orElse: unexpectedStatus
        }))
      ),
    "listModelsCount": (options) =>
      HttpClientRequest.get(`/models/count`).pipe(
        withResponse(options?.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(ListModelsCount200),
          "500": decodeError("ListModelsCount500", ListModelsCount500),
          orElse: unexpectedStatus
        }))
      ),
    "getModels": (options) =>
      HttpClientRequest.get(`/models`).pipe(
        HttpClientRequest.setUrlParams({
          "category": options?.params?.["category"] as any,
          "supported_parameters": options?.params?.["supported_parameters"] as any
        }),
        withResponse(options?.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(GetModels200),
          "400": decodeError("GetModels400", GetModels400),
          "500": decodeError("GetModels500", GetModels500),
          orElse: unexpectedStatus
        }))
      ),
    "listModelsUser": (options) =>
      HttpClientRequest.get(`/models/user`).pipe(
        withResponse(options?.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(ListModelsUser200),
          "401": decodeError("ListModelsUser401", ListModelsUser401),
          "404": decodeError("ListModelsUser404", ListModelsUser404),
          "500": decodeError("ListModelsUser500", ListModelsUser500),
          orElse: unexpectedStatus
        }))
      ),
    "listEndpoints": (author, slug, options) =>
      HttpClientRequest.get(`/models/${author}/${slug}/endpoints`).pipe(
        withResponse(options?.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(ListEndpoints200),
          "404": decodeError("ListEndpoints404", ListEndpoints404),
          "500": decodeError("ListEndpoints500", ListEndpoints500),
          orElse: unexpectedStatus
        }))
      ),
    "listEndpointsZdr": (options) =>
      HttpClientRequest.get(`/endpoints/zdr`).pipe(
        withResponse(options?.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(ListEndpointsZdr200),
          "500": decodeError("ListEndpointsZdr500", ListEndpointsZdr500),
          orElse: unexpectedStatus
        }))
      ),
    "listProviders": (options) =>
      HttpClientRequest.get(`/providers`).pipe(
        withResponse(options?.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(ListProviders200),
          "500": decodeError("ListProviders500", ListProviders500),
          orElse: unexpectedStatus
        }))
      ),
    "list": (options) =>
      HttpClientRequest.get(`/keys`).pipe(
        HttpClientRequest.setUrlParams({
          "include_disabled": options?.params?.["include_disabled"] as any,
          "offset": options?.params?.["offset"] as any
        }),
        withResponse(options?.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(List200),
          "401": decodeError("List401", List401),
          "429": decodeError("List429", List429),
          "500": decodeError("List500", List500),
          orElse: unexpectedStatus
        }))
      ),
    "createKeys": (options) =>
      HttpClientRequest.post(`/keys`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(CreateKeys201),
          "400": decodeError("CreateKeys400", CreateKeys400),
          "401": decodeError("CreateKeys401", CreateKeys401),
          "429": decodeError("CreateKeys429", CreateKeys429),
          "500": decodeError("CreateKeys500", CreateKeys500),
          orElse: unexpectedStatus
        }))
      ),
    "getKey": (hash, options) =>
      HttpClientRequest.get(`/keys/${hash}`).pipe(
        withResponse(options?.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(GetKey200),
          "401": decodeError("GetKey401", GetKey401),
          "404": decodeError("GetKey404", GetKey404),
          "429": decodeError("GetKey429", GetKey429),
          "500": decodeError("GetKey500", GetKey500),
          orElse: unexpectedStatus
        }))
      ),
    "deleteKeys": (hash, options) =>
      HttpClientRequest.delete(`/keys/${hash}`).pipe(
        withResponse(options?.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(DeleteKeys200),
          "401": decodeError("DeleteKeys401", DeleteKeys401),
          "404": decodeError("DeleteKeys404", DeleteKeys404),
          "429": decodeError("DeleteKeys429", DeleteKeys429),
          "500": decodeError("DeleteKeys500", DeleteKeys500),
          orElse: unexpectedStatus
        }))
      ),
    "updateKeys": (hash, options) =>
      HttpClientRequest.patch(`/keys/${hash}`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(UpdateKeys200),
          "400": decodeError("UpdateKeys400", UpdateKeys400),
          "401": decodeError("UpdateKeys401", UpdateKeys401),
          "404": decodeError("UpdateKeys404", UpdateKeys404),
          "429": decodeError("UpdateKeys429", UpdateKeys429),
          "500": decodeError("UpdateKeys500", UpdateKeys500),
          orElse: unexpectedStatus
        }))
      ),
    "listGuardrails": (options) =>
      HttpClientRequest.get(`/guardrails`).pipe(
        HttpClientRequest.setUrlParams({
          "offset": options?.params?.["offset"] as any,
          "limit": options?.params?.["limit"] as any
        }),
        withResponse(options?.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(ListGuardrails200),
          "401": decodeError("ListGuardrails401", ListGuardrails401),
          "500": decodeError("ListGuardrails500", ListGuardrails500),
          orElse: unexpectedStatus
        }))
      ),
    "createGuardrail": (options) =>
      HttpClientRequest.post(`/guardrails`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(CreateGuardrail201),
          "400": decodeError("CreateGuardrail400", CreateGuardrail400),
          "401": decodeError("CreateGuardrail401", CreateGuardrail401),
          "500": decodeError("CreateGuardrail500", CreateGuardrail500),
          orElse: unexpectedStatus
        }))
      ),
    "getGuardrail": (id, options) =>
      HttpClientRequest.get(`/guardrails/${id}`).pipe(
        withResponse(options?.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(GetGuardrail200),
          "401": decodeError("GetGuardrail401", GetGuardrail401),
          "404": decodeError("GetGuardrail404", GetGuardrail404),
          "500": decodeError("GetGuardrail500", GetGuardrail500),
          orElse: unexpectedStatus
        }))
      ),
    "deleteGuardrail": (id, options) =>
      HttpClientRequest.delete(`/guardrails/${id}`).pipe(
        withResponse(options?.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(DeleteGuardrail200),
          "401": decodeError("DeleteGuardrail401", DeleteGuardrail401),
          "404": decodeError("DeleteGuardrail404", DeleteGuardrail404),
          "500": decodeError("DeleteGuardrail500", DeleteGuardrail500),
          orElse: unexpectedStatus
        }))
      ),
    "updateGuardrail": (id, options) =>
      HttpClientRequest.patch(`/guardrails/${id}`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(UpdateGuardrail200),
          "400": decodeError("UpdateGuardrail400", UpdateGuardrail400),
          "401": decodeError("UpdateGuardrail401", UpdateGuardrail401),
          "404": decodeError("UpdateGuardrail404", UpdateGuardrail404),
          "500": decodeError("UpdateGuardrail500", UpdateGuardrail500),
          orElse: unexpectedStatus
        }))
      ),
    "listKeyAssignments": (options) =>
      HttpClientRequest.get(`/guardrails/assignments/keys`).pipe(
        HttpClientRequest.setUrlParams({
          "offset": options?.params?.["offset"] as any,
          "limit": options?.params?.["limit"] as any
        }),
        withResponse(options?.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(ListKeyAssignments200),
          "401": decodeError("ListKeyAssignments401", ListKeyAssignments401),
          "500": decodeError("ListKeyAssignments500", ListKeyAssignments500),
          orElse: unexpectedStatus
        }))
      ),
    "listMemberAssignments": (options) =>
      HttpClientRequest.get(`/guardrails/assignments/members`).pipe(
        HttpClientRequest.setUrlParams({
          "offset": options?.params?.["offset"] as any,
          "limit": options?.params?.["limit"] as any
        }),
        withResponse(options?.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(ListMemberAssignments200),
          "401": decodeError("ListMemberAssignments401", ListMemberAssignments401),
          "500": decodeError("ListMemberAssignments500", ListMemberAssignments500),
          orElse: unexpectedStatus
        }))
      ),
    "listGuardrailKeyAssignments": (id, options) =>
      HttpClientRequest.get(`/guardrails/${id}/assignments/keys`).pipe(
        HttpClientRequest.setUrlParams({
          "offset": options?.params?.["offset"] as any,
          "limit": options?.params?.["limit"] as any
        }),
        withResponse(options?.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(ListGuardrailKeyAssignments200),
          "401": decodeError("ListGuardrailKeyAssignments401", ListGuardrailKeyAssignments401),
          "404": decodeError("ListGuardrailKeyAssignments404", ListGuardrailKeyAssignments404),
          "500": decodeError("ListGuardrailKeyAssignments500", ListGuardrailKeyAssignments500),
          orElse: unexpectedStatus
        }))
      ),
    "bulkAssignKeysToGuardrail": (id, options) =>
      HttpClientRequest.post(`/guardrails/${id}/assignments/keys`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(BulkAssignKeysToGuardrail200),
          "400": decodeError("BulkAssignKeysToGuardrail400", BulkAssignKeysToGuardrail400),
          "401": decodeError("BulkAssignKeysToGuardrail401", BulkAssignKeysToGuardrail401),
          "404": decodeError("BulkAssignKeysToGuardrail404", BulkAssignKeysToGuardrail404),
          "500": decodeError("BulkAssignKeysToGuardrail500", BulkAssignKeysToGuardrail500),
          orElse: unexpectedStatus
        }))
      ),
    "listGuardrailMemberAssignments": (id, options) =>
      HttpClientRequest.get(`/guardrails/${id}/assignments/members`).pipe(
        HttpClientRequest.setUrlParams({
          "offset": options?.params?.["offset"] as any,
          "limit": options?.params?.["limit"] as any
        }),
        withResponse(options?.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(ListGuardrailMemberAssignments200),
          "401": decodeError("ListGuardrailMemberAssignments401", ListGuardrailMemberAssignments401),
          "404": decodeError("ListGuardrailMemberAssignments404", ListGuardrailMemberAssignments404),
          "500": decodeError("ListGuardrailMemberAssignments500", ListGuardrailMemberAssignments500),
          orElse: unexpectedStatus
        }))
      ),
    "bulkAssignMembersToGuardrail": (id, options) =>
      HttpClientRequest.post(`/guardrails/${id}/assignments/members`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(BulkAssignMembersToGuardrail200),
          "400": decodeError("BulkAssignMembersToGuardrail400", BulkAssignMembersToGuardrail400),
          "401": decodeError("BulkAssignMembersToGuardrail401", BulkAssignMembersToGuardrail401),
          "404": decodeError("BulkAssignMembersToGuardrail404", BulkAssignMembersToGuardrail404),
          "500": decodeError("BulkAssignMembersToGuardrail500", BulkAssignMembersToGuardrail500),
          orElse: unexpectedStatus
        }))
      ),
    "bulkUnassignKeysFromGuardrail": (id, options) =>
      HttpClientRequest.post(`/guardrails/${id}/assignments/keys/remove`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(BulkUnassignKeysFromGuardrail200),
          "400": decodeError("BulkUnassignKeysFromGuardrail400", BulkUnassignKeysFromGuardrail400),
          "401": decodeError("BulkUnassignKeysFromGuardrail401", BulkUnassignKeysFromGuardrail401),
          "404": decodeError("BulkUnassignKeysFromGuardrail404", BulkUnassignKeysFromGuardrail404),
          "500": decodeError("BulkUnassignKeysFromGuardrail500", BulkUnassignKeysFromGuardrail500),
          orElse: unexpectedStatus
        }))
      ),
    "bulkUnassignMembersFromGuardrail": (id, options) =>
      HttpClientRequest.post(`/guardrails/${id}/assignments/members/remove`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(BulkUnassignMembersFromGuardrail200),
          "400": decodeError("BulkUnassignMembersFromGuardrail400", BulkUnassignMembersFromGuardrail400),
          "401": decodeError("BulkUnassignMembersFromGuardrail401", BulkUnassignMembersFromGuardrail401),
          "404": decodeError("BulkUnassignMembersFromGuardrail404", BulkUnassignMembersFromGuardrail404),
          "500": decodeError("BulkUnassignMembersFromGuardrail500", BulkUnassignMembersFromGuardrail500),
          orElse: unexpectedStatus
        }))
      ),
    "getCurrentKey": (options) =>
      HttpClientRequest.get(`/key`).pipe(
        withResponse(options?.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(GetCurrentKey200),
          "401": decodeError("GetCurrentKey401", GetCurrentKey401),
          "500": decodeError("GetCurrentKey500", GetCurrentKey500),
          orElse: unexpectedStatus
        }))
      ),
    "exchangeAuthCodeForAPIKey": (options) =>
      HttpClientRequest.post(`/auth/keys`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(ExchangeAuthCodeForAPIKey200),
          "400": decodeError("ExchangeAuthCodeForAPIKey400", ExchangeAuthCodeForAPIKey400),
          "403": decodeError("ExchangeAuthCodeForAPIKey403", ExchangeAuthCodeForAPIKey403),
          "500": decodeError("ExchangeAuthCodeForAPIKey500", ExchangeAuthCodeForAPIKey500),
          orElse: unexpectedStatus
        }))
      ),
    "createAuthKeysCode": (options) =>
      HttpClientRequest.post(`/auth/keys/code`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(CreateAuthKeysCode200),
          "400": decodeError("CreateAuthKeysCode400", CreateAuthKeysCode400),
          "401": decodeError("CreateAuthKeysCode401", CreateAuthKeysCode401),
          "500": decodeError("CreateAuthKeysCode500", CreateAuthKeysCode500),
          orElse: unexpectedStatus
        }))
      ),
    "sendChatCompletionRequest": (options) =>
      HttpClientRequest.post(`/chat/completions`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(HttpClientResponse.matchStatus({
          "2xx": decodeSuccess(SendChatCompletionRequest200),
          "400": decodeError("SendChatCompletionRequest400", SendChatCompletionRequest400),
          "401": decodeError("SendChatCompletionRequest401", SendChatCompletionRequest401),
          "429": decodeError("SendChatCompletionRequest429", SendChatCompletionRequest429),
          "500": decodeError("SendChatCompletionRequest500", SendChatCompletionRequest500),
          orElse: unexpectedStatus
        }))
      ),
    "sendChatCompletionRequestSse": (options) =>
      HttpClientRequest.post(`/chat/completions`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        sseRequest(SendChatCompletionRequest200Sse)
      )
  }
}

export interface OpenRouterClient {
  readonly httpClient: HttpClient.HttpClient
  /**
   * Creates a streaming or non-streaming response using OpenResponses API format
   */
  readonly "createResponses": <Config extends OperationConfig>(
    options: { readonly payload: typeof CreateResponsesRequestJson.Encoded; readonly config?: Config | undefined }
  ) => Effect.Effect<
    WithOptionalResponse<typeof CreateResponses200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"CreateResponses400", typeof CreateResponses400.Type>
    | OpenRouterClientError<"CreateResponses401", typeof CreateResponses401.Type>
    | OpenRouterClientError<"CreateResponses402", typeof CreateResponses402.Type>
    | OpenRouterClientError<"CreateResponses404", typeof CreateResponses404.Type>
    | OpenRouterClientError<"CreateResponses408", typeof CreateResponses408.Type>
    | OpenRouterClientError<"CreateResponses413", typeof CreateResponses413.Type>
    | OpenRouterClientError<"CreateResponses422", typeof CreateResponses422.Type>
    | OpenRouterClientError<"CreateResponses429", typeof CreateResponses429.Type>
    | OpenRouterClientError<"CreateResponses500", typeof CreateResponses500.Type>
    | OpenRouterClientError<"CreateResponses502", typeof CreateResponses502.Type>
    | OpenRouterClientError<"CreateResponses503", typeof CreateResponses503.Type>
    | OpenRouterClientError<"CreateResponses524", typeof CreateResponses524.Type>
    | OpenRouterClientError<"CreateResponses529", typeof CreateResponses529.Type>
  >
  /**
   * Creates a streaming or non-streaming response using OpenResponses API format
   */
  readonly "createResponsesSse": (
    options: { readonly payload: typeof CreateResponsesRequestJson.Encoded }
  ) => Stream.Stream<
    { readonly event: string; readonly id: string | undefined; readonly data: typeof CreateResponses200Sse.Type },
    HttpClientError.HttpClientError | SchemaError | Sse.Retry,
    typeof CreateResponses200Sse.DecodingServices
  >
  /**
   * Creates a message using the Anthropic Messages API format. Supports text, images, PDFs, tools, and extended thinking.
   */
  readonly "createMessages": <Config extends OperationConfig>(
    options: { readonly payload: typeof CreateMessagesRequestJson.Encoded; readonly config?: Config | undefined }
  ) => Effect.Effect<
    WithOptionalResponse<typeof CreateMessages200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"CreateMessages400", typeof CreateMessages400.Type>
    | OpenRouterClientError<"CreateMessages401", typeof CreateMessages401.Type>
    | OpenRouterClientError<"CreateMessages403", typeof CreateMessages403.Type>
    | OpenRouterClientError<"CreateMessages404", typeof CreateMessages404.Type>
    | OpenRouterClientError<"CreateMessages429", typeof CreateMessages429.Type>
    | OpenRouterClientError<"CreateMessages500", typeof CreateMessages500.Type>
    | OpenRouterClientError<"CreateMessages503", typeof CreateMessages503.Type>
    | OpenRouterClientError<"CreateMessages529", typeof CreateMessages529.Type>
  >
  /**
   * Creates a message using the Anthropic Messages API format. Supports text, images, PDFs, tools, and extended thinking.
   */
  readonly "createMessagesSse": (
    options: { readonly payload: typeof CreateMessagesRequestJson.Encoded }
  ) => Stream.Stream<
    { readonly event: string; readonly id: string | undefined; readonly data: typeof CreateMessages200Sse.Type },
    HttpClientError.HttpClientError | SchemaError | Sse.Retry,
    typeof CreateMessages200Sse.DecodingServices
  >
  /**
   * Returns user activity data grouped by endpoint for the last 30 (completed) UTC days. [Management key](/docs/guides/overview/auth/management-api-keys) required.
   */
  readonly "getUserActivity": <Config extends OperationConfig>(
    options: {
      readonly params?: typeof GetUserActivityParams.Encoded | undefined
      readonly config?: Config | undefined
    } | undefined
  ) => Effect.Effect<
    WithOptionalResponse<typeof GetUserActivity200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"GetUserActivity400", typeof GetUserActivity400.Type>
    | OpenRouterClientError<"GetUserActivity401", typeof GetUserActivity401.Type>
    | OpenRouterClientError<"GetUserActivity403", typeof GetUserActivity403.Type>
    | OpenRouterClientError<"GetUserActivity500", typeof GetUserActivity500.Type>
  >
  /**
   * Get total credits purchased and used for the authenticated user. [Management key](/docs/guides/overview/auth/management-api-keys) required.
   */
  readonly "getCredits": <Config extends OperationConfig>(
    options: { readonly config?: Config | undefined } | undefined
  ) => Effect.Effect<
    WithOptionalResponse<typeof GetCredits200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"GetCredits401", typeof GetCredits401.Type>
    | OpenRouterClientError<"GetCredits403", typeof GetCredits403.Type>
    | OpenRouterClientError<"GetCredits500", typeof GetCredits500.Type>
  >
  /**
   * Create a Coinbase charge for crypto payment
   */
  readonly "createCoinbaseCharge": <Config extends OperationConfig>(
    options: { readonly payload: typeof CreateCoinbaseChargeRequestJson.Encoded; readonly config?: Config | undefined }
  ) => Effect.Effect<
    WithOptionalResponse<typeof CreateCoinbaseCharge200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"CreateCoinbaseCharge400", typeof CreateCoinbaseCharge400.Type>
    | OpenRouterClientError<"CreateCoinbaseCharge401", typeof CreateCoinbaseCharge401.Type>
    | OpenRouterClientError<"CreateCoinbaseCharge429", typeof CreateCoinbaseCharge429.Type>
    | OpenRouterClientError<"CreateCoinbaseCharge500", typeof CreateCoinbaseCharge500.Type>
  >
  /**
   * Submits an embedding request to the embeddings router
   */
  readonly "createEmbeddings": <Config extends OperationConfig>(
    options: { readonly payload: typeof CreateEmbeddingsRequestJson.Encoded; readonly config?: Config | undefined }
  ) => Effect.Effect<
    WithOptionalResponse<typeof CreateEmbeddings200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"CreateEmbeddings400", typeof CreateEmbeddings400.Type>
    | OpenRouterClientError<"CreateEmbeddings401", typeof CreateEmbeddings401.Type>
    | OpenRouterClientError<"CreateEmbeddings402", typeof CreateEmbeddings402.Type>
    | OpenRouterClientError<"CreateEmbeddings404", typeof CreateEmbeddings404.Type>
    | OpenRouterClientError<"CreateEmbeddings429", typeof CreateEmbeddings429.Type>
    | OpenRouterClientError<"CreateEmbeddings500", typeof CreateEmbeddings500.Type>
    | OpenRouterClientError<"CreateEmbeddings502", typeof CreateEmbeddings502.Type>
    | OpenRouterClientError<"CreateEmbeddings503", typeof CreateEmbeddings503.Type>
    | OpenRouterClientError<"CreateEmbeddings524", typeof CreateEmbeddings524.Type>
    | OpenRouterClientError<"CreateEmbeddings529", typeof CreateEmbeddings529.Type>
  >
  /**
   * Submits an embedding request to the embeddings router
   */
  readonly "createEmbeddingsSse": (
    options: { readonly payload: typeof CreateEmbeddingsRequestJson.Encoded }
  ) => Stream.Stream<
    { readonly event: string; readonly id: string | undefined; readonly data: typeof CreateEmbeddings200Sse.Type },
    HttpClientError.HttpClientError | SchemaError | Sse.Retry,
    typeof CreateEmbeddings200Sse.DecodingServices
  >
  /**
   * Returns a list of all available embeddings models and their properties
   */
  readonly "listEmbeddingsModels": <Config extends OperationConfig>(
    options: { readonly config?: Config | undefined } | undefined
  ) => Effect.Effect<
    WithOptionalResponse<typeof ListEmbeddingsModels200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"ListEmbeddingsModels400", typeof ListEmbeddingsModels400.Type>
    | OpenRouterClientError<"ListEmbeddingsModels500", typeof ListEmbeddingsModels500.Type>
  >
  /**
   * Get request & usage metadata for a generation
   */
  readonly "getGeneration": <Config extends OperationConfig>(
    options: { readonly params: typeof GetGenerationParams.Encoded; readonly config?: Config | undefined }
  ) => Effect.Effect<
    WithOptionalResponse<typeof GetGeneration200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"GetGeneration401", typeof GetGeneration401.Type>
    | OpenRouterClientError<"GetGeneration402", typeof GetGeneration402.Type>
    | OpenRouterClientError<"GetGeneration404", typeof GetGeneration404.Type>
    | OpenRouterClientError<"GetGeneration429", typeof GetGeneration429.Type>
    | OpenRouterClientError<"GetGeneration500", typeof GetGeneration500.Type>
    | OpenRouterClientError<"GetGeneration502", typeof GetGeneration502.Type>
    | OpenRouterClientError<"GetGeneration524", typeof GetGeneration524.Type>
    | OpenRouterClientError<"GetGeneration529", typeof GetGeneration529.Type>
  >
  /**
   * Get total count of available models
   */
  readonly "listModelsCount": <Config extends OperationConfig>(
    options: { readonly config?: Config | undefined } | undefined
  ) => Effect.Effect<
    WithOptionalResponse<typeof ListModelsCount200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"ListModelsCount500", typeof ListModelsCount500.Type>
  >
  /**
   * List all models and their properties
   */
  readonly "getModels": <Config extends OperationConfig>(
    options:
      | { readonly params?: typeof GetModelsParams.Encoded | undefined; readonly config?: Config | undefined }
      | undefined
  ) => Effect.Effect<
    WithOptionalResponse<typeof GetModels200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"GetModels400", typeof GetModels400.Type>
    | OpenRouterClientError<"GetModels500", typeof GetModels500.Type>
  >
  /**
   * List models filtered by user provider preferences, [privacy settings](https://openrouter.ai/docs/guides/privacy/logging), and [guardrails](https://openrouter.ai/docs/guides/features/guardrails). If requesting through `eu.openrouter.ai/api/v1/...` the results will be filtered to models that satisfy [EU in-region routing](https://openrouter.ai/docs/guides/privacy/logging#enterprise-eu-in-region-routing).
   */
  readonly "listModelsUser": <Config extends OperationConfig>(
    options: { readonly config?: Config | undefined } | undefined
  ) => Effect.Effect<
    WithOptionalResponse<typeof ListModelsUser200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"ListModelsUser401", typeof ListModelsUser401.Type>
    | OpenRouterClientError<"ListModelsUser404", typeof ListModelsUser404.Type>
    | OpenRouterClientError<"ListModelsUser500", typeof ListModelsUser500.Type>
  >
  /**
   * List all endpoints for a model
   */
  readonly "listEndpoints": <Config extends OperationConfig>(
    author: string,
    slug: string,
    options: { readonly config?: Config | undefined } | undefined
  ) => Effect.Effect<
    WithOptionalResponse<typeof ListEndpoints200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"ListEndpoints404", typeof ListEndpoints404.Type>
    | OpenRouterClientError<"ListEndpoints500", typeof ListEndpoints500.Type>
  >
  /**
   * Preview the impact of ZDR on the available endpoints
   */
  readonly "listEndpointsZdr": <Config extends OperationConfig>(
    options: { readonly config?: Config | undefined } | undefined
  ) => Effect.Effect<
    WithOptionalResponse<typeof ListEndpointsZdr200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"ListEndpointsZdr500", typeof ListEndpointsZdr500.Type>
  >
  /**
   * List all providers
   */
  readonly "listProviders": <Config extends OperationConfig>(
    options: { readonly config?: Config | undefined } | undefined
  ) => Effect.Effect<
    WithOptionalResponse<typeof ListProviders200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"ListProviders500", typeof ListProviders500.Type>
  >
  /**
   * List all API keys for the authenticated user. [Management key](/docs/guides/overview/auth/management-api-keys) required.
   */
  readonly "list": <Config extends OperationConfig>(
    options:
      | { readonly params?: typeof ListParams.Encoded | undefined; readonly config?: Config | undefined }
      | undefined
  ) => Effect.Effect<
    WithOptionalResponse<typeof List200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"List401", typeof List401.Type>
    | OpenRouterClientError<"List429", typeof List429.Type>
    | OpenRouterClientError<"List500", typeof List500.Type>
  >
  /**
   * Create a new API key for the authenticated user. [Management key](/docs/guides/overview/auth/management-api-keys) required.
   */
  readonly "createKeys": <Config extends OperationConfig>(
    options: { readonly payload: typeof CreateKeysRequestJson.Encoded; readonly config?: Config | undefined }
  ) => Effect.Effect<
    WithOptionalResponse<typeof CreateKeys201.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"CreateKeys400", typeof CreateKeys400.Type>
    | OpenRouterClientError<"CreateKeys401", typeof CreateKeys401.Type>
    | OpenRouterClientError<"CreateKeys429", typeof CreateKeys429.Type>
    | OpenRouterClientError<"CreateKeys500", typeof CreateKeys500.Type>
  >
  /**
   * Get a single API key by hash. [Management key](/docs/guides/overview/auth/management-api-keys) required.
   */
  readonly "getKey": <Config extends OperationConfig>(
    hash: string,
    options: { readonly config?: Config | undefined } | undefined
  ) => Effect.Effect<
    WithOptionalResponse<typeof GetKey200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"GetKey401", typeof GetKey401.Type>
    | OpenRouterClientError<"GetKey404", typeof GetKey404.Type>
    | OpenRouterClientError<"GetKey429", typeof GetKey429.Type>
    | OpenRouterClientError<"GetKey500", typeof GetKey500.Type>
  >
  /**
   * Delete an existing API key. [Management key](/docs/guides/overview/auth/management-api-keys) required.
   */
  readonly "deleteKeys": <Config extends OperationConfig>(
    hash: string,
    options: { readonly config?: Config | undefined } | undefined
  ) => Effect.Effect<
    WithOptionalResponse<typeof DeleteKeys200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"DeleteKeys401", typeof DeleteKeys401.Type>
    | OpenRouterClientError<"DeleteKeys404", typeof DeleteKeys404.Type>
    | OpenRouterClientError<"DeleteKeys429", typeof DeleteKeys429.Type>
    | OpenRouterClientError<"DeleteKeys500", typeof DeleteKeys500.Type>
  >
  /**
   * Update an existing API key. [Management key](/docs/guides/overview/auth/management-api-keys) required.
   */
  readonly "updateKeys": <Config extends OperationConfig>(
    hash: string,
    options: { readonly payload: typeof UpdateKeysRequestJson.Encoded; readonly config?: Config | undefined }
  ) => Effect.Effect<
    WithOptionalResponse<typeof UpdateKeys200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"UpdateKeys400", typeof UpdateKeys400.Type>
    | OpenRouterClientError<"UpdateKeys401", typeof UpdateKeys401.Type>
    | OpenRouterClientError<"UpdateKeys404", typeof UpdateKeys404.Type>
    | OpenRouterClientError<"UpdateKeys429", typeof UpdateKeys429.Type>
    | OpenRouterClientError<"UpdateKeys500", typeof UpdateKeys500.Type>
  >
  /**
   * List all guardrails for the authenticated user. [Management key](/docs/guides/overview/auth/management-api-keys) required.
   */
  readonly "listGuardrails": <Config extends OperationConfig>(
    options:
      | { readonly params?: typeof ListGuardrailsParams.Encoded | undefined; readonly config?: Config | undefined }
      | undefined
  ) => Effect.Effect<
    WithOptionalResponse<typeof ListGuardrails200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"ListGuardrails401", typeof ListGuardrails401.Type>
    | OpenRouterClientError<"ListGuardrails500", typeof ListGuardrails500.Type>
  >
  /**
   * Create a new guardrail for the authenticated user. [Management key](/docs/guides/overview/auth/management-api-keys) required.
   */
  readonly "createGuardrail": <Config extends OperationConfig>(
    options: { readonly payload: typeof CreateGuardrailRequestJson.Encoded; readonly config?: Config | undefined }
  ) => Effect.Effect<
    WithOptionalResponse<typeof CreateGuardrail201.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"CreateGuardrail400", typeof CreateGuardrail400.Type>
    | OpenRouterClientError<"CreateGuardrail401", typeof CreateGuardrail401.Type>
    | OpenRouterClientError<"CreateGuardrail500", typeof CreateGuardrail500.Type>
  >
  /**
   * Get a single guardrail by ID. [Management key](/docs/guides/overview/auth/management-api-keys) required.
   */
  readonly "getGuardrail": <Config extends OperationConfig>(
    id: string,
    options: { readonly config?: Config | undefined } | undefined
  ) => Effect.Effect<
    WithOptionalResponse<typeof GetGuardrail200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"GetGuardrail401", typeof GetGuardrail401.Type>
    | OpenRouterClientError<"GetGuardrail404", typeof GetGuardrail404.Type>
    | OpenRouterClientError<"GetGuardrail500", typeof GetGuardrail500.Type>
  >
  /**
   * Delete an existing guardrail. [Management key](/docs/guides/overview/auth/management-api-keys) required.
   */
  readonly "deleteGuardrail": <Config extends OperationConfig>(
    id: string,
    options: { readonly config?: Config | undefined } | undefined
  ) => Effect.Effect<
    WithOptionalResponse<typeof DeleteGuardrail200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"DeleteGuardrail401", typeof DeleteGuardrail401.Type>
    | OpenRouterClientError<"DeleteGuardrail404", typeof DeleteGuardrail404.Type>
    | OpenRouterClientError<"DeleteGuardrail500", typeof DeleteGuardrail500.Type>
  >
  /**
   * Update an existing guardrail. [Management key](/docs/guides/overview/auth/management-api-keys) required.
   */
  readonly "updateGuardrail": <Config extends OperationConfig>(
    id: string,
    options: { readonly payload: typeof UpdateGuardrailRequestJson.Encoded; readonly config?: Config | undefined }
  ) => Effect.Effect<
    WithOptionalResponse<typeof UpdateGuardrail200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"UpdateGuardrail400", typeof UpdateGuardrail400.Type>
    | OpenRouterClientError<"UpdateGuardrail401", typeof UpdateGuardrail401.Type>
    | OpenRouterClientError<"UpdateGuardrail404", typeof UpdateGuardrail404.Type>
    | OpenRouterClientError<"UpdateGuardrail500", typeof UpdateGuardrail500.Type>
  >
  /**
   * List all API key guardrail assignments for the authenticated user. [Management key](/docs/guides/overview/auth/management-api-keys) required.
   */
  readonly "listKeyAssignments": <Config extends OperationConfig>(
    options: {
      readonly params?: typeof ListKeyAssignmentsParams.Encoded | undefined
      readonly config?: Config | undefined
    } | undefined
  ) => Effect.Effect<
    WithOptionalResponse<typeof ListKeyAssignments200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"ListKeyAssignments401", typeof ListKeyAssignments401.Type>
    | OpenRouterClientError<"ListKeyAssignments500", typeof ListKeyAssignments500.Type>
  >
  /**
   * List all organization member guardrail assignments for the authenticated user. [Management key](/docs/guides/overview/auth/management-api-keys) required.
   */
  readonly "listMemberAssignments": <Config extends OperationConfig>(
    options: {
      readonly params?: typeof ListMemberAssignmentsParams.Encoded | undefined
      readonly config?: Config | undefined
    } | undefined
  ) => Effect.Effect<
    WithOptionalResponse<typeof ListMemberAssignments200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"ListMemberAssignments401", typeof ListMemberAssignments401.Type>
    | OpenRouterClientError<"ListMemberAssignments500", typeof ListMemberAssignments500.Type>
  >
  /**
   * List all API key assignments for a specific guardrail. [Management key](/docs/guides/overview/auth/management-api-keys) required.
   */
  readonly "listGuardrailKeyAssignments": <Config extends OperationConfig>(
    id: string,
    options: {
      readonly params?: typeof ListGuardrailKeyAssignmentsParams.Encoded | undefined
      readonly config?: Config | undefined
    } | undefined
  ) => Effect.Effect<
    WithOptionalResponse<typeof ListGuardrailKeyAssignments200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"ListGuardrailKeyAssignments401", typeof ListGuardrailKeyAssignments401.Type>
    | OpenRouterClientError<"ListGuardrailKeyAssignments404", typeof ListGuardrailKeyAssignments404.Type>
    | OpenRouterClientError<"ListGuardrailKeyAssignments500", typeof ListGuardrailKeyAssignments500.Type>
  >
  /**
   * Assign multiple API keys to a specific guardrail. [Management key](/docs/guides/overview/auth/management-api-keys) required.
   */
  readonly "bulkAssignKeysToGuardrail": <Config extends OperationConfig>(
    id: string,
    options: {
      readonly payload: typeof BulkAssignKeysToGuardrailRequestJson.Encoded
      readonly config?: Config | undefined
    }
  ) => Effect.Effect<
    WithOptionalResponse<typeof BulkAssignKeysToGuardrail200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"BulkAssignKeysToGuardrail400", typeof BulkAssignKeysToGuardrail400.Type>
    | OpenRouterClientError<"BulkAssignKeysToGuardrail401", typeof BulkAssignKeysToGuardrail401.Type>
    | OpenRouterClientError<"BulkAssignKeysToGuardrail404", typeof BulkAssignKeysToGuardrail404.Type>
    | OpenRouterClientError<"BulkAssignKeysToGuardrail500", typeof BulkAssignKeysToGuardrail500.Type>
  >
  /**
   * List all organization member assignments for a specific guardrail. [Management key](/docs/guides/overview/auth/management-api-keys) required.
   */
  readonly "listGuardrailMemberAssignments": <Config extends OperationConfig>(
    id: string,
    options: {
      readonly params?: typeof ListGuardrailMemberAssignmentsParams.Encoded | undefined
      readonly config?: Config | undefined
    } | undefined
  ) => Effect.Effect<
    WithOptionalResponse<typeof ListGuardrailMemberAssignments200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"ListGuardrailMemberAssignments401", typeof ListGuardrailMemberAssignments401.Type>
    | OpenRouterClientError<"ListGuardrailMemberAssignments404", typeof ListGuardrailMemberAssignments404.Type>
    | OpenRouterClientError<"ListGuardrailMemberAssignments500", typeof ListGuardrailMemberAssignments500.Type>
  >
  /**
   * Assign multiple organization members to a specific guardrail. [Management key](/docs/guides/overview/auth/management-api-keys) required.
   */
  readonly "bulkAssignMembersToGuardrail": <Config extends OperationConfig>(
    id: string,
    options: {
      readonly payload: typeof BulkAssignMembersToGuardrailRequestJson.Encoded
      readonly config?: Config | undefined
    }
  ) => Effect.Effect<
    WithOptionalResponse<typeof BulkAssignMembersToGuardrail200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"BulkAssignMembersToGuardrail400", typeof BulkAssignMembersToGuardrail400.Type>
    | OpenRouterClientError<"BulkAssignMembersToGuardrail401", typeof BulkAssignMembersToGuardrail401.Type>
    | OpenRouterClientError<"BulkAssignMembersToGuardrail404", typeof BulkAssignMembersToGuardrail404.Type>
    | OpenRouterClientError<"BulkAssignMembersToGuardrail500", typeof BulkAssignMembersToGuardrail500.Type>
  >
  /**
   * Unassign multiple API keys from a specific guardrail. [Management key](/docs/guides/overview/auth/management-api-keys) required.
   */
  readonly "bulkUnassignKeysFromGuardrail": <Config extends OperationConfig>(
    id: string,
    options: {
      readonly payload: typeof BulkUnassignKeysFromGuardrailRequestJson.Encoded
      readonly config?: Config | undefined
    }
  ) => Effect.Effect<
    WithOptionalResponse<typeof BulkUnassignKeysFromGuardrail200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"BulkUnassignKeysFromGuardrail400", typeof BulkUnassignKeysFromGuardrail400.Type>
    | OpenRouterClientError<"BulkUnassignKeysFromGuardrail401", typeof BulkUnassignKeysFromGuardrail401.Type>
    | OpenRouterClientError<"BulkUnassignKeysFromGuardrail404", typeof BulkUnassignKeysFromGuardrail404.Type>
    | OpenRouterClientError<"BulkUnassignKeysFromGuardrail500", typeof BulkUnassignKeysFromGuardrail500.Type>
  >
  /**
   * Unassign multiple organization members from a specific guardrail. [Management key](/docs/guides/overview/auth/management-api-keys) required.
   */
  readonly "bulkUnassignMembersFromGuardrail": <Config extends OperationConfig>(
    id: string,
    options: {
      readonly payload: typeof BulkUnassignMembersFromGuardrailRequestJson.Encoded
      readonly config?: Config | undefined
    }
  ) => Effect.Effect<
    WithOptionalResponse<typeof BulkUnassignMembersFromGuardrail200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"BulkUnassignMembersFromGuardrail400", typeof BulkUnassignMembersFromGuardrail400.Type>
    | OpenRouterClientError<"BulkUnassignMembersFromGuardrail401", typeof BulkUnassignMembersFromGuardrail401.Type>
    | OpenRouterClientError<"BulkUnassignMembersFromGuardrail404", typeof BulkUnassignMembersFromGuardrail404.Type>
    | OpenRouterClientError<"BulkUnassignMembersFromGuardrail500", typeof BulkUnassignMembersFromGuardrail500.Type>
  >
  /**
   * Get information on the API key associated with the current authentication session
   */
  readonly "getCurrentKey": <Config extends OperationConfig>(
    options: { readonly config?: Config | undefined } | undefined
  ) => Effect.Effect<
    WithOptionalResponse<typeof GetCurrentKey200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"GetCurrentKey401", typeof GetCurrentKey401.Type>
    | OpenRouterClientError<"GetCurrentKey500", typeof GetCurrentKey500.Type>
  >
  /**
   * Exchange an authorization code from the PKCE flow for a user-controlled API key
   */
  readonly "exchangeAuthCodeForAPIKey": <Config extends OperationConfig>(
    options: {
      readonly payload: typeof ExchangeAuthCodeForAPIKeyRequestJson.Encoded
      readonly config?: Config | undefined
    }
  ) => Effect.Effect<
    WithOptionalResponse<typeof ExchangeAuthCodeForAPIKey200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"ExchangeAuthCodeForAPIKey400", typeof ExchangeAuthCodeForAPIKey400.Type>
    | OpenRouterClientError<"ExchangeAuthCodeForAPIKey403", typeof ExchangeAuthCodeForAPIKey403.Type>
    | OpenRouterClientError<"ExchangeAuthCodeForAPIKey500", typeof ExchangeAuthCodeForAPIKey500.Type>
  >
  /**
   * Create an authorization code for the PKCE flow to generate a user-controlled API key
   */
  readonly "createAuthKeysCode": <Config extends OperationConfig>(
    options: { readonly payload: typeof CreateAuthKeysCodeRequestJson.Encoded; readonly config?: Config | undefined }
  ) => Effect.Effect<
    WithOptionalResponse<typeof CreateAuthKeysCode200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"CreateAuthKeysCode400", typeof CreateAuthKeysCode400.Type>
    | OpenRouterClientError<"CreateAuthKeysCode401", typeof CreateAuthKeysCode401.Type>
    | OpenRouterClientError<"CreateAuthKeysCode500", typeof CreateAuthKeysCode500.Type>
  >
  /**
   * Sends a request for a model response for the given chat conversation. Supports both streaming and non-streaming modes.
   */
  readonly "sendChatCompletionRequest": <Config extends OperationConfig>(
    options: {
      readonly payload: typeof SendChatCompletionRequestRequestJson.Encoded
      readonly config?: Config | undefined
    }
  ) => Effect.Effect<
    WithOptionalResponse<typeof SendChatCompletionRequest200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | OpenRouterClientError<"SendChatCompletionRequest400", typeof SendChatCompletionRequest400.Type>
    | OpenRouterClientError<"SendChatCompletionRequest401", typeof SendChatCompletionRequest401.Type>
    | OpenRouterClientError<"SendChatCompletionRequest429", typeof SendChatCompletionRequest429.Type>
    | OpenRouterClientError<"SendChatCompletionRequest500", typeof SendChatCompletionRequest500.Type>
  >
  /**
   * Sends a request for a model response for the given chat conversation. Supports both streaming and non-streaming modes.
   */
  readonly "sendChatCompletionRequestSse": (
    options: { readonly payload: typeof SendChatCompletionRequestRequestJson.Encoded }
  ) => Stream.Stream<
    {
      readonly event: string
      readonly id: string | undefined
      readonly data: typeof SendChatCompletionRequest200Sse.Type
    },
    HttpClientError.HttpClientError | SchemaError | Sse.Retry,
    typeof SendChatCompletionRequest200Sse.DecodingServices
  >
}

export interface OpenRouterClientError<Tag extends string, E> {
  readonly _tag: Tag
  readonly request: HttpClientRequest.HttpClientRequest
  readonly response: HttpClientResponse.HttpClientResponse
  readonly cause: E
}

class OpenRouterClientErrorImpl extends Data.Error<{
  _tag: string
  cause: any
  request: HttpClientRequest.HttpClientRequest
  response: HttpClientResponse.HttpClientResponse
}> {}

export const OpenRouterClientError = <Tag extends string, E>(
  tag: Tag,
  cause: E,
  response: HttpClientResponse.HttpClientResponse
): OpenRouterClientError<Tag, E> =>
  new OpenRouterClientErrorImpl({
    _tag: tag,
    cause,
    response,
    request: response.request
  }) as any
