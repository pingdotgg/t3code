// @effect-diagnostics nodeBuiltinImport:off -- fixtures and tests use Node builtins
import {
  extractCopilotSubagentUpdate,
  makeCopilotSubagentRouting,
  normalizeDevinSessionUpdate,
  normalizeDevinToolCall,
  extractDevinSubagentUpdate,
  makeAcpRegistryAdapterV2,
} from "@t3tools/provider-acp-registry/testing";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import { AcpRegistryCatalog } from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import { decodeAcpReplayTranscript, makeAcpReplayRuntime } from "./AcpAdapterV2.testkit.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DocumentText from "../../provider/DocumentText.ts";
import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  EnvironmentId,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
  type ProviderOptionDescriptor,
  type ProviderUserInputAnswers,
} from "@t3tools/contracts";
import { GrokSettings } from "@t3tools/provider-grok/settings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { deriveBlockedOnThreadWait } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpProtocol from "effect-acp/protocol";
import type * as EffectAcpSchema from "effect-acp/compat";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  ACP_EMPTY_OPTION_VALUE,
  ACP_SESSION_MODE_OPTION_ID,
  acpProviderOptionDescriptors,
} from "@t3tools/provider-acp/server/sessionConfig";
import {
  extractXAiAcpSubagentUpdate,
  makeGrokAdapterV2,
  makeXAiPromptCompletionRuntime,
  normalizeXAiAcpToolCallState,
  registerXAiBackgroundTaskTracking,
} from "@t3tools/provider-grok/testing";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  AcpProviderCapabilitiesV2,
  acpPerTurnPromptUsage,
  acpScopedNativeId,
  acpPostSettleContinuationOfferEvidence,
  acpPostSettleWakeEvidence,
  acpToolCallDiffPatch,
  acpToolCallSnippetEdit,
  makeAcpAdapterV2,
  type AcpAdapterV2ExtensionContext,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
  type AcpAdapterV2SubagentUpdate,
} from "@t3tools/provider-acp/server/adapter";
import { appendUserInputAttachmentPaths } from "../../provider/userInputAttachments.ts";
import { makeGrokAcpAdapterFlavor } from "@t3tools/provider-grok/testing";
import {
  acpRegistryPromptFailure,
  registerMistralVibeAcpExtensions,
} from "@t3tools/provider-acp-registry/testing";

describe("acpPerTurnPromptUsage", () => {
  it("maps a per-turn sample straight onto TurnTokenUsage", () => {
    assert.deepEqual(
      acpPerTurnPromptUsage(
        {
          inputTokens: 2453,
          outputTokens: 4,
          totalTokens: 2457,
          cachedReadTokens: 512,
          cachedWriteTokens: 32,
          thoughtTokens: 3,
        },
        false,
        "completed",
      ),
      {
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: false,
        inputTokens: 2453,
        outputTokens: 4,
        cachedInputTokens: 512,
        cacheCreationTokens: 32,
        reasoningTokens: 3,
      },
    );
    // Antigravity 1.4.5: its harness reports prompt tokens without the 24 cached ones.
    assert.deepEqual(
      acpPerTurnPromptUsage(
        {
          inputTokens: 42,
          outputTokens: 3,
          totalTokens: 54,
          cachedReadTokens: 24,
          cachedWriteTokens: 0,
          thoughtTokens: 9,
        },
        false,
        "completed",
        true,
      ),
      {
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: false,
        inputTokens: 66,
        outputTokens: 12,
        cachedInputTokens: 24,
        cacheCreationTokens: 0,
        reasoningTokens: 9,
      },
    );
  });

  it("clamps subsets that exceed their parents and drops unset counters", () => {
    assert.deepEqual(
      acpPerTurnPromptUsage(
        {
          inputTokens: 100,
          outputTokens: 10,
          totalTokens: 110,
          cachedReadTokens: 150,
          cachedWriteTokens: 120,
          thoughtTokens: 30,
        },
        false,
        "completed",
      ),
      {
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: false,
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 100,
        cacheCreationTokens: 0,
        reasoningTokens: 10,
      },
    );
    assert.deepEqual(
      acpPerTurnPromptUsage(
        { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
        false,
        "completed",
      ),
      {
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: false,
        inputTokens: 100,
        outputTokens: 10,
      },
    );
  });

  it("caps cache writes at the input left over after cache reads", () => {
    // Each counter fits under input alone, but together they exceed it.
    assert.deepEqual(
      acpPerTurnPromptUsage(
        {
          inputTokens: 100,
          outputTokens: 10,
          totalTokens: 110,
          cachedReadTokens: 80,
          cachedWriteTokens: 80,
        },
        false,
        "completed",
      ),
      {
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: false,
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 80,
        cacheCreationTokens: 20,
      },
    );
  });

  it("marks present usage partial on a non-completed terminal and missing usage unavailable", () => {
    assert.deepEqual(
      acpPerTurnPromptUsage(
        { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
        true,
        "interrupted",
      ),
      {
        usageScope: "main_agent",
        usageStatus: "partial",
        hasSubagents: true,
        inputTokens: 100,
        outputTokens: 10,
      },
    );
    assert.deepEqual(acpPerTurnPromptUsage(undefined, false, "completed"), {
      usageScope: "main_agent",
      usageStatus: "unavailable",
      hasSubagents: false,
    });
  });
});
describe("acpToolCallDiffPatch", () => {
  it("keeps an unplaced snippet as recorded text instead of numbering it from line 1", () => {
    const content = [
      {
        type: "diff",
        path: "/repo/a.ts",
        oldText: "const target = 10;",
        newText: "const target = 100;",
        patch: { format: "snippet", text: "@@ -1,1 +1,1 @@ snippet, line unknown\n" },
      },
    ];
    assert.isUndefined(acpToolCallDiffPatch(content));
    // An omitted preview is not re-diffed from the bare snippets either.
    assert.isUndefined(acpToolCallDiffPatch([{ ...content[0], patch: { format: "omitted" } }]));
    // A status block beside the snippet must not hide it.
    for (const blocks of [
      content,
      [{ type: "content", content: { type: "text", text: "Edited." } }, ...content],
    ]) {
      assert.isUndefined(acpToolCallDiffPatch(blocks));
      assert.deepEqual(acpToolCallSnippetEdit(blocks), {
        oldStr: "const target = 10;",
        newStr: "const target = 100;",
      });
    }
    // Beside another diff, the snippet is neither a patch nor a placed edit.
    const twoDiffs = [
      ...content,
      {
        type: "diff",
        path: "/repo/b.ts",
        oldText: "b\n",
        newText: "B\n",
        patch: { text: "@@ -1 +1 @@\n-b\n+B\n" },
      },
    ];
    assert.isUndefined(acpToolCallDiffPatch(twoDiffs));
    assert.isUndefined(acpToolCallSnippetEdit(twoDiffs));
  });

  it("builds per-file patches from ACP hunks and recorded old/new text", () => {
    for (const operation of ["add", "delete"]) {
      const text = operation === "add" ? "@@ -0,0 +1 @@\n+content\n" : "@@ -1 +0,0 @@\n-content\n";
      assert.equal(
        acpToolCallDiffPatch([
          {
            type: "diff",
            changes: [{ operation, path: "/repo/a.ts" }],
            patch: { format: "git_patch", text },
          },
        ]),
        [
          'diff --git "a//repo/a.ts" "b//repo/a.ts"',
          operation === "add" ? "--- /dev/null" : '--- "a//repo/a.ts"',
          operation === "delete" ? "+++ /dev/null" : '+++ "b//repo/a.ts"',
          text,
        ].join("\n"),
      );
    }
    assert.equal(
      acpToolCallDiffPatch([
        { type: "diff", path: "/repo/new.txt", oldText: null, newText: "hello\n" },
        { type: "diff", path: "/repo/a.ts", oldText: "a\nb\nc\n", newText: "a\nB\nc\n" },
        { type: "diff", path: "/repo/same.ts", oldText: "x\n", newText: "x\n" },
      ]),
      [
        "--- /dev/null",
        "+++ /repo/new.txt",
        "@@ -0,0 +1,1 @@",
        "+hello",
        "",
        "--- /repo/a.ts",
        "+++ /repo/a.ts",
        "@@ -1,3 +1,3 @@",
        " a",
        "-b",
        "+B",
        " c",
        "",
      ].join("\n"),
    );
    assert.equal(
      acpToolCallDiffPatch([
        {
          type: "diff",
          changes: [{ operation: "modify", path: "/repo/a.ts" }],
          patch: {
            format: "git_patch",
            text: "diff --git a/repo/a.ts b/repo/a.ts\n@@ -1 +1 @@\n-a\n+A\n",
          },
        },
        {
          type: "diff",
          changes: [{ operation: "modify", path: "/repo/b.ts" }],
          patch: {
            format: "git_patch",
            text: "diff --git a/repo/b.ts b/repo/b.ts\n@@ -1 +1 @@\n-b\n+B\n",
          },
        },
        { type: "diff", path: "/repo/c.ts", oldText: "c\n", newText: "C\n" },
      ]),
      [
        "diff --git a/repo/a.ts b/repo/a.ts",
        "@@ -1 +1 @@",
        "-a",
        "+A",
        "",
        "diff --git a/repo/b.ts b/repo/b.ts",
        "@@ -1 +1 @@",
        "-b",
        "+B",
        "",
        'diff --git "a//repo/c.ts" "b//repo/c.ts"',
        "--- /repo/c.ts",
        "+++ /repo/c.ts",
        "@@ -1,1 +1,1 @@",
        "-c",
        "+C",
        "",
      ].join("\n"),
    );
    assert.equal(
      acpToolCallDiffPatch([
        { type: "diff", path: "/repo/new.txt", oldText: null, newText: "hello\n" },
        {
          type: "diff",
          changes: [{ operation: "modify", path: "/repo/a.ts" }],
          patch: { format: "git_patch", text: "@@ -1 +1 @@\n-a\n+A\n" },
        },
      ]),
      [
        'diff --git "a//repo/new.txt" "b//repo/new.txt"',
        "--- /dev/null",
        "+++ /repo/new.txt",
        "@@ -0,0 +1,1 @@",
        "+hello",
        "",
        'diff --git "a//repo/a.ts" "b//repo/a.ts"',
        '--- "a//repo/a.ts"',
        '+++ "b//repo/a.ts"',
        "@@ -1 +1 @@",
        "-a",
        "+A",
        "",
      ].join("\n"),
    );
  });
});
