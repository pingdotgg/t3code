import * as Duration from "effect/Duration";

/** Fixed per-invocation timeout. Effect timeout cannot preempt sync CPU blocking. */
export const PLUGIN_TOOL_TIMEOUT = Duration.seconds(60);

/** If UTF-8 serialized CallToolResult exceeds this, return a small host-owned isError. */
export const PLUGIN_TOOL_RESULT_MAX_UTF8_BYTES = 1024 * 1024;

export const PLUGIN_TOOL_MAX_PER_PLUGIN = 32;
export const PLUGIN_TOOL_MAX_CONCURRENT_PER_TOOL = 4;
export const PLUGIN_TOOL_MAX_DESCRIPTION_LENGTH = 1024;
export const PLUGIN_TOOL_MAX_TITLE_LENGTH = 128;
export const PLUGIN_TOOL_MAX_SCHEMA_JSON_BYTES = 64 * 1024;
export const PLUGIN_TOOL_MAX_SCHEMA_DEPTH = 12;
export const PLUGIN_TOOL_MAX_CONTENT_ITEMS = 32;
export const PLUGIN_TOOL_MAX_TEXT_CHARS = 256 * 1024;
