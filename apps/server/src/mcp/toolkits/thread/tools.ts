import {
  GetThreadMetadataInput,
  McpCapabilityUnavailableError,
  SetThreadNameInput,
  SetThreadNameResult,
  ThreadMetadata,
  ThreadMetadataNotFoundError,
  ThreadMetadataReadError,
  ThreadMetadataRenameError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const failure = Schema.Union([
  McpCapabilityUnavailableError,
  ThreadMetadataNotFoundError,
  ThreadMetadataReadError,
  ThreadMetadataRenameError,
]);
const dependencies = [McpInvocationContext.McpInvocationContext];

const GetThreadMetadataTool = Tool.make("get_thread_metadata", {
  description:
    "Read this T3 Code thread's name, model, service tier, reasoning effort, Daybreak access, provider, workspace and host environment. Use fields to request only what you need. Saved selections may differ from the latest request sent to the provider; neither confirms the model or tier actually used. Null means unknown. Daybreak access describes the requested model's cached catalog, not an active entitlement check.",
  parameters: GetThreadMetadataInput,
  success: ThreadMetadata,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Get current thread metadata")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SetThreadNameTool = Tool.make("set_thread_name", {
  description:
    "Rename this T3 Code thread. The name is trimmed and must not be empty. This changes only the thread name, and prevents a pending automatic title from replacing it.",
  parameters: SetThreadNameInput,
  success: SetThreadNameResult,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Set current thread name")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ThreadToolkit = Toolkit.make(GetThreadMetadataTool, SetThreadNameTool);
