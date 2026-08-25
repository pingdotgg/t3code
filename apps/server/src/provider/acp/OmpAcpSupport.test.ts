import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  applyOmpAcpModelSelection,
  applyOmpRequestedSessionConfiguration,
  buildOmpAcpSpawnInput,
  buildOmpTextGenerationAcpSpawnInput,
  resolveEmptyOmpElicitationResponse,
  resolveOmpAcpConfigUpdates,
  shouldAutoApproveOmpPermission,
} from "./OmpAcpSupport.ts";

describe("buildOmpAcpSpawnInput", () => {
  it("starts the ACP subcommand before configured launch arguments", () => {
    expect(
      buildOmpAcpSpawnInput(
        { binaryPath: "/usr/local/bin/omp", launchArgs: '--profile "work profile"' },
        "/tmp/project",
        { OMP_TEST: "1" },
      ),
    ).toEqual({
      command: "/usr/local/bin/omp",
      args: ["acp", "--profile", "work profile"],
      cwd: "/tmp/project",
      env: { OMP_TEST: "1" },
    });
  });

  it.each([
    ["approval-required", "always-ask"],
    ["auto", "always-ask"],
    ["auto-accept-edits", "write"],
    ["full-access", "yolo"],
  ] as const)("enforces the %s runtime mode", (runtimeMode, approvalMode) => {
    expect(
      buildOmpAcpSpawnInput(
        {
          binaryPath: "omp",
          launchArgs:
            "--profile work --yolo --auto-approve --approval-mode=write --approval-mode always-ask",
        },
        "/tmp/project",
        undefined,
        runtimeMode,
      ).args,
    ).toEqual(["acp", "--profile", "work", "--approval-mode", approvalMode]);
  });
});

describe("buildOmpTextGenerationAcpSpawnInput", () => {
  it("keeps one unambiguous profile and ignores other launch arguments", () => {
    expect(
      buildOmpTextGenerationAcpSpawnInput(
        {
          binaryPath: "/usr/local/bin/omp",
          launchArgs:
            '--profile "text generation" --tools bash --yolo -e /tmp/unsafe.ts --extension /tmp/unsafe-two.ts',
        },
        "/tmp/project",
        "/tmp/omp-session",
      ),
    ).toEqual({
      command: "/usr/local/bin/omp",
      args: [
        "acp",
        "--profile",
        "text generation",
        "--session-dir",
        "/tmp/omp-session",
        "--no-tools",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-rules",
        "--approval-mode",
        "always-ask",
      ],
      cwd: "/tmp/project",
    });
  });

  it("drops ambiguous profile arguments", () => {
    const expectedArgs = [
      "acp",
      "--session-dir",
      "/tmp/omp-session",
      "--no-tools",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-rules",
      "--approval-mode",
      "always-ask",
    ];

    for (const launchArgs of ["--profile safe --profile unsafe", '--profile "unterminated']) {
      expect(
        buildOmpTextGenerationAcpSpawnInput(
          { binaryPath: "omp", launchArgs },
          "/tmp/project",
          "/tmp/omp-session",
        ).args,
      ).toEqual(expectedArgs);
    }
  });
});

describe("shouldAutoApproveOmpPermission", () => {
  const editRequest = {
    kind: "unknown",
    toolCall: {
      toolCallId: "edit-1",
      status: "pending",
      data: { locations: [{ path: "/tmp/file.ts" }] },
    },
  } as const;
  const commandRequest = {
    kind: "execute",
    toolCall: {
      toolCallId: "bash-1",
      status: "pending",
      command: "npm test",
      data: {},
    },
  } as const;

  it("auto-approves OMP edit gates only in edit-accepting modes", () => {
    expect(shouldAutoApproveOmpPermission("auto-accept-edits", editRequest)).toBe(true);
    expect(shouldAutoApproveOmpPermission("approval-required", editRequest)).toBe(false);
    expect(shouldAutoApproveOmpPermission("auto", editRequest)).toBe(false);
    expect(
      shouldAutoApproveOmpPermission("auto-accept-edits", {
        kind: "unknown",
        toolCall: { toolCallId: "unknown-1", status: "pending", data: {} },
      }),
    ).toBe(false);
  });

  it("keeps commands gated unless the session has full access", () => {
    expect(shouldAutoApproveOmpPermission("auto-accept-edits", commandRequest)).toBe(false);
    expect(shouldAutoApproveOmpPermission("full-access", commandRequest)).toBe(true);
  });
});

describe("resolveEmptyOmpElicitationResponse", () => {
  it("accepts optional-only forms and cancels unrenderable required forms", () => {
    const optionalForm = {
      mode: "form",
      sessionId: "session-1",
      message: "Optional context",
      requestedSchema: {
        type: "object",
        properties: { context: { type: "string", title: "Context" } },
        required: [],
      },
    } as const;

    expect(resolveEmptyOmpElicitationResponse(optionalForm)).toEqual({
      action: { action: "accept", content: {} },
    });
    expect(
      resolveEmptyOmpElicitationResponse({
        ...optionalForm,
        requestedSchema: { ...optionalForm.requestedSchema, required: ["missing"] },
      }),
    ).toEqual({ action: { action: "cancel" } });
  });
});

describe("applyOmpRequestedSessionConfiguration", () => {
  it.effect("does not substring-match plan or implementation aliases", () =>
    Effect.gen(function* () {
      const modeCalls: string[] = [];
      yield* applyOmpRequestedSessionConfiguration({
        runtime: {
          getConfigOptions: Effect.succeed([]),
          getModeState: Effect.succeed({
            currentModeId: "explain",
            availableModes: [
              { id: "explain", name: "Explain", description: "Explain the current code" },
              {
                id: "review",
                name: "Review",
                description: "Implementation planning details",
              },
            ],
          }),
          setConfigOption: () => Effect.succeed({ configOptions: [] }),
          setModel: () => Effect.void,
          setMode: (modeId) =>
            Effect.sync(() => {
              modeCalls.push(modeId);
              return {};
            }),
        },
        modelSelection: undefined,
        mapError: (context) => context.cause,
      });

      expect(modeCalls).toEqual(["explain"]);
    }),
  );
});

describe("applyOmpAcpModelSelection", () => {
  it.effect("keeps the OMP default model and applies thinking selection", () =>
    Effect.gen(function* () {
      const modelCalls: string[] = [];
      const configCalls: Array<[string, string | boolean]> = [];
      const result = yield* applyOmpAcpModelSelection({
        runtime: {
          getConfigOptions: Effect.succeed([
            {
              id: "thinking",
              name: "Thinking",
              category: "thought_level",
              type: "select",
              currentValue: "off",
              options: [
                { value: "off", name: "Off" },
                { value: "high", name: "High" },
              ],
            },
          ]),
          setConfigOption: (id, value) =>
            Effect.sync(() => {
              configCalls.push([id, value]);
            }),
          setModel: (model) => Effect.sync(() => void modelCalls.push(model)),
        },
        model: "default",
        selections: [{ id: "thinking", value: "high" }],
        mapError: (context) => context.step,
      });

      expect(result).toBeUndefined();
      expect(modelCalls).toEqual([]);
      expect(configCalls).toEqual([["thinking", "high"]]);
    }),
  );

  it.effect("restores the session's configured model from the default sentinel", () =>
    Effect.gen(function* () {
      const modelCalls: string[] = [];
      yield* applyOmpAcpModelSelection({
        runtime: {
          getConfigOptions: Effect.succeed([]),
          setConfigOption: () => Effect.void,
          setModel: (model) => Effect.sync(() => void modelCalls.push(model)),
        },
        model: "default",
        defaultModel: "openai-codex/gpt-5.4",
        selections: [],
        mapError: (context) => context.step,
      });

      expect(modelCalls).toEqual(["openai-codex/gpt-5.4"]);
    }),
  );
});

describe("resolveOmpAcpConfigUpdates", () => {
  it("matches configured values case-insensitively", () => {
    expect(
      resolveOmpAcpConfigUpdates(
        [
          {
            id: "thinking",
            name: "Thinking",
            category: "thought_level",
            type: "select",
            currentValue: "off",
            options: [
              { value: "off", name: "Off" },
              { value: "high", name: "High" },
            ],
          },
        ],
        [{ id: "thinking", value: "HIGH" }],
      ),
    ).toEqual([{ configId: "thinking", value: "high" }]);
  });
});
