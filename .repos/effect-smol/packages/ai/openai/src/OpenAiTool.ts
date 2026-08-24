/**
 * The `OpenAiTool` module defines OpenAI provider tools for Effect AI language
 * model requests. It exposes typed descriptors for tools such as Apply Patch,
 * Code Interpreter, File Search, Image Generation, MCP, Web Search, and
 * shell-like local tools, including their provider names, configuration
 * arguments, call parameters, success schemas, and handler requirements.
 *
 * @since 4.0.0
 */
import * as Schema from "effect/Schema"
import * as Tool from "effect/unstable/ai/Tool"
import * as Generated from "./Generated.ts"

/**
 * Union of all OpenAI provider-defined tools.
 *
 * @category models
 * @since 4.0.0
 */
export type OpenAiTool =
  | ReturnType<typeof ApplyPatch>
  | ReturnType<typeof CodeInterpreter>
  | ReturnType<typeof FileSearch>
  | ReturnType<typeof Shell>
  | ReturnType<typeof ImageGeneration>
  | ReturnType<typeof LocalShell>
  | ReturnType<typeof Mcp>
  | ReturnType<typeof WebSearch>
  | ReturnType<typeof WebSearchPreview>

/**
 * Defines the OpenAI Apply Patch tool that allows the model to apply diffs by creating,
 * deleting, or updating files. This local tool runs in your environment and
 * requires a handler to execute file operations.
 *
 * **When to use**
 *
 * Use when you want an OpenAI model to request structured file edits as create,
 * delete, or update operations that your application executes through a local
 * handler.
 *
 * @category tools
 * @since 4.0.0
 */
export const ApplyPatch = Tool.providerDefined({
  id: "openai.apply_patch",
  customName: "OpenAiApplyPatch",
  providerName: "apply_patch",
  requiresHandler: true,
  parameters: Schema.Struct({
    call_id: Generated.ApplyPatchToolCall.fields.call_id,
    operation: Generated.ApplyPatchToolCall.fields.operation
  }),
  success: Schema.Struct({
    status: Generated.ApplyPatchToolCallOutput.fields.status,
    output: Generated.ApplyPatchToolCallOutput.fields.output
  })
})

/**
 * Defines the OpenAI Code Interpreter tool that allows the model to execute Python code in
 * a sandboxed environment.
 *
 * **When to use**
 *
 * Use to enable OpenAI-hosted Python execution for a model response.
 *
 * **Details**
 *
 * The tool is configured with a `container` argument. Successful tool calls
 * expose `outputs`, which may contain logs or generated images, or `null` when
 * no outputs are available.
 *
 * @category tools
 * @since 4.0.0
 */
export const CodeInterpreter = Tool.providerDefined({
  id: "openai.code_interpreter",
  customName: "OpenAiCodeInterpreter",
  providerName: "code_interpreter",
  args: Schema.Struct({
    container: Generated.CodeInterpreterTool.fields.container
  }),
  parameters: Schema.Struct({
    code: Generated.CodeInterpreterToolCall.fields.code,
    container_id: Generated.CodeInterpreterToolCall.fields.container_id
  }),
  success: Schema.Struct({
    outputs: Generated.CodeInterpreterToolCall.fields.outputs
  })
})

/**
 * Defines the OpenAI File Search tool that enables the model to search through uploaded
 * files and vector stores.
 *
 * **When to use**
 *
 * Use to let an OpenAI model search uploaded files through one or more vector
 * stores.
 *
 * **Details**
 *
 * The tool requires `vector_store_ids` and accepts optional `filters`,
 * `max_num_results`, and `ranking_options`. Successful tool calls expose the
 * search `status`, generated `queries`, and optional `results`.
 *
 * @category tools
 * @since 4.0.0
 */
export const FileSearch = Tool.providerDefined({
  id: "openai.file_search",
  customName: "OpenAiFileSearch",
  providerName: "file_search",
  args: Schema.Struct({
    filters: Generated.FileSearchTool.fields.filters,
    max_num_results: Generated.FileSearchTool.fields.max_num_results,
    ranking_options: Generated.FileSearchTool.fields.ranking_options,
    vector_store_ids: Generated.FileSearchTool.fields.vector_store_ids
  }),
  success: Schema.Struct({
    status: Generated.FileSearchToolCall.fields.status,
    queries: Generated.FileSearchToolCall.fields.queries,
    results: Generated.FileSearchToolCall.fields.results
  })
})

/**
 * Defines the OpenAI Image Generation tool that enables the model to generate images using
 * the GPT image models.
 *
 * **When to use**
 *
 * Use to enable OpenAI provider-defined image generation through a language
 * model response.
 *
 * **Details**
 *
 * The tool configures the `image_generation` provider tool, including model,
 * size, quality, output format, moderation, background, input-image options,
 * and partial image settings. Successful tool calls expose `result` as base64
 * image data or `null`.
 *
 * @category tools
 * @since 4.0.0
 */
export const ImageGeneration = Tool.providerDefined({
  id: "openai.image_generation",
  customName: "OpenAiImageGeneration",
  providerName: "image_generation",
  args: Schema.Struct({
    background: Generated.ImageGenTool.fields.background,
    input_fidelity: Generated.ImageGenTool.fields.input_fidelity,
    input_image_mask: Generated.ImageGenTool.fields.input_image_mask,
    model: Generated.ImageGenTool.fields.model,
    moderation: Generated.ImageGenTool.fields.moderation,
    output_compression: Generated.ImageGenTool.fields.output_compression,
    output_format: Generated.ImageGenTool.fields.output_format,
    partial_images: Generated.ImageGenTool.fields.partial_images,
    quality: Generated.ImageGenTool.fields.quality,
    size: Generated.ImageGenTool.fields.size
  }),
  success: Schema.Struct({
    result: Generated.ImageGenToolCall.fields.result
  })
})

/**
 * Defines the OpenAI Local Shell tool that enables the model to run a command with a local
 * shell. This local tool runs in your environment and requires a handler to
 * execute commands.
 *
 * **When to use**
 *
 * Use to let an OpenAI model request local shell commands that your application
 * executes through a handler.
 *
 * **Details**
 *
 * The tool exposes a provider-defined `local_shell` call. It is marked as
 * handler-required, so applications must provide the command execution policy
 * and implementation.
 *
 * @category tools
 * @since 4.0.0
 */
export const LocalShell = Tool.providerDefined({
  id: "openai.local_shell",
  customName: "OpenAiLocalShell",
  providerName: "local_shell",
  requiresHandler: true,
  parameters: Schema.Struct({
    action: Generated.LocalShellToolCall.fields.action
  }),
  success: Schema.Struct({
    output: Generated.LocalShellToolCallOutput.fields.output
  })
})

/**
 * Defines the OpenAI MCP tool that gives the model access to additional tools via remote
 * Model Context Protocol (MCP) servers.
 *
 * **When to use**
 *
 * Use to let an OpenAI model call tools exposed by a remote MCP server.
 *
 * **Details**
 *
 * The tool accepts MCP server configuration such as allowed tools,
 * authorization, connector id, approval requirements, server metadata, and
 * server URL. Tool call results include the called tool name, arguments, output,
 * error, and server label.
 *
 * **Gotchas**
 *
 * This schema leaves both `server_url` and `connector_id` optional, but OpenAI
 * may require a server URL or connector id for a usable MCP tool configuration.
 *
 * @category tools
 * @since 4.0.0
 */
export const Mcp = Tool.providerDefined({
  id: "openai.mcp",
  customName: "OpenAiMcp",
  providerName: "mcp",
  args: Schema.Struct({
    allowed_tools: Generated.MCPTool.fields.allowed_tools,
    authorization: Generated.MCPTool.fields.authorization,
    connector_id: Generated.MCPTool.fields.connector_id,
    require_approval: Generated.MCPTool.fields.require_approval,
    server_description: Generated.MCPTool.fields.server_description,
    server_label: Generated.MCPTool.fields.server_label,
    server_url: Generated.MCPTool.fields.server_url
  }),
  parameters: Schema.Unknown,
  success: Schema.Struct({
    type: Generated.MCPToolCall.fields.type,
    name: Generated.MCPToolCall.fields.name,
    arguments: Generated.MCPToolCall.fields.arguments,
    output: Generated.MCPToolCall.fields.output,
    error: Generated.MCPToolCall.fields.error,
    server_label: Generated.MCPToolCall.fields.server_label
  })
})

/**
 * Defines the OpenAI shell tool for model-requested command execution.
 *
 * **When to use**
 *
 * Use to let an OpenAI model request shell commands that your application
 * executes through a handler.
 *
 * **Details**
 *
 * The tool exposes a provider-defined `shell` call. It is marked as
 * handler-required, so applications must provide the command execution policy
 * and implementation.
 *
 * @category tools
 * @since 4.0.0
 */
export const Shell = Tool.providerDefined({
  id: "openai.shell",
  customName: "OpenAiShell",
  providerName: "shell",
  requiresHandler: true,
  parameters: Schema.Struct({
    action: Generated.FunctionShellCall.fields.action
  }),
  success: Schema.Struct({
    output: Generated.FunctionShellCallOutput.fields.output
  })
})

/**
 * Defines the OpenAI Web Search tool that enables the model to search the web for
 * information.
 *
 * **When to use**
 *
 * Use to enable OpenAI provider-defined web search for a model response.
 *
 * **Details**
 *
 * The tool accepts optional filters, user location, and search context size.
 * Successful calls expose the performed search action and status.
 *
 * @see {@link WebSearchPreview} for the preview web search provider tool
 *
 * @category tools
 * @since 4.0.0
 */
export const WebSearch = Tool.providerDefined({
  id: "openai.web_search",
  customName: "OpenAiWebSearch",
  providerName: "web_search",
  args: Schema.Struct({
    filters: Generated.WebSearchTool.fields.filters,
    user_location: Generated.WebSearchTool.fields.user_location,
    search_context_size: Generated.WebSearchTool.fields.search_context_size
  }),
  parameters: Schema.Struct({
    action: Generated.WebSearchToolCall.fields.action
  }),
  success: Schema.Struct({
    action: Generated.WebSearchToolCall.fields.action,
    status: Generated.WebSearchToolCall.fields.status
  })
})

/**
 * Defines the OpenAI preview Web Search tool for model responses.
 *
 * **When to use**
 *
 * Use to enable the preview OpenAI web search provider tool.
 *
 * **Details**
 *
 * The preview tool accepts optional user location and search context size, then
 * exposes the performed search action and status in successful calls.
 *
 * @see {@link WebSearch} for the stable web search provider tool
 *
 * @category tools
 * @since 4.0.0
 */
export const WebSearchPreview = Tool.providerDefined({
  id: "openai.web_search_preview",
  customName: "OpenAiWebSearchPreview",
  providerName: "web_search_preview",
  args: Schema.Struct({
    user_location: Generated.WebSearchPreviewTool.fields.user_location,
    search_context_size: Generated.WebSearchPreviewTool.fields.search_context_size
  }),
  success: Schema.Struct({
    action: Generated.WebSearchToolCall.fields.action,
    status: Generated.WebSearchToolCall.fields.status
  })
})
