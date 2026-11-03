import {
  COMPUTER_SEND_MESSAGE_MAX_CHARS,
  ComputerListResult,
  ComputerTaskError,
  ComputerTaskSendResult,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { EmptyToolInput } from "../emptyToolInput.ts";
import * as ComputerTaskBroker from "../../ComputerTaskBroker.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { resolveAppDisplayName } from "../../../appDisplayName.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ComputerTaskBroker.ComputerTaskBroker,
  ServerEnvironment.ServerEnvironment,
  ThreadManagementService.ThreadManagementService,
  ProjectStore.ProjectStoreV2,
  SecureRandom.SecureRandom,
];

/** What computer_send fails with, including the access gate's refusal. */
const ComputerSendFailure = Schema.Union([ComputerTaskError, OrchestratorMcpFailure]);

export const ComputerSendInput = Schema.Struct({
  computer: TrimmedNonEmptyString.annotate({
    description:
      "Target computer: environment id, label, SSH host (user@host), or 'this' for the machine this chat is already on.",
  }),
  message: TrimmedNonEmptyString.check(
    Schema.isMaxLength(COMPUTER_SEND_MESSAGE_MAX_CHARS),
  ).annotate({
    description:
      "Full task for the agent on the target computer. Include all context it needs; this chat's transcript is not shared.",
  }),
  project: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Optional project title or folder name on the target computer. Omit to match this thread's project name.",
    }),
  ),
  title: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Optional title for the new thread on the target computer.",
    }),
  ),
});

export const ComputerListTool = Tool.make("computer_list", {
  description: `List computers this ${resolveAppDisplayName()} client can run work on: this machine, SSH hosts, T3 Connect machines, and other paired environments. Call this before computer_send when the task belongs on another OS, desktop, GPU, or filesystem. Returns ids, labels, OS, connection kind, and whether each computer is reachable.`,
  parameters: EmptyToolInput,
  success: ComputerListResult,
  failure: ComputerTaskError,
  dependencies,
})
  .annotate(Tool.Title, "List computers")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ComputerSendTool = Tool.make("computer_send", {
  description:
    "Start a new T3 thread on another connected computer (or this one) with the given task. The receiving agent runs on that machine, so it has that computer's files, terminal, and Computer Use desktop. Use computer_list to discover ids and labels. This does not move this chat or share its transcript; include everything the recipient needs.",
  parameters: ComputerSendInput,
  success: ComputerTaskSendResult,
  failure: ComputerSendFailure,
  dependencies,
})
  .annotate(Tool.Title, "Send task to computer")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false);

export const ComputerToolkit = Toolkit.make(ComputerListTool, ComputerSendTool);
