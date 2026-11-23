import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as CuaDriver from "./cuaDriver.ts";
import * as CuHandlers from "./handlers.ts";
import { CuToolkit } from "./tools.ts";

const invocationScope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("env-1"),
  requestNamespace: "session-1",
  thread: {
    threadId: ThreadId.make("thread-1"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: "session-1",
  },
  client: undefined,
  capabilities: new Set(["preview", "device"] as const),
  issuedAt: 1,
};

const runTool = <Name extends "cu_call" | "cu_request_fill">(
  name: Name,
  input: Record<string, unknown>,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly onCall?: (
      tool: string,
      args: Readonly<Record<string, unknown>>,
      opts?: CuaDriver.CuaCallOptions,
    ) => Effect.Effect<CuaDriver.CuaCallResult, OrchestratorMcpFailure>;
    readonly secretAnswer?:
      | { readonly status: "saved"; readonly value: Redacted.Redacted<string> }
      | { readonly status: "declined" | "cancelled" | "timed_out"; readonly note: string };
  } = {},
) => {
  const calls: Array<{
    tool: string;
    args: Readonly<Record<string, unknown>>;
    opts?: CuaDriver.CuaCallOptions;
  }> = [];
  const asked: Array<unknown> = [];
  return Effect.gen(function* () {
    const toolkit = yield* CuToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(CuHandlers.layer)),
    );
    const results = yield* toolkit
      .handle(name as never, input as never)
      .pipe(Stream.unwrap, Stream.runCollect);
    return { result: results.at(-1)?.result, calls, asked };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        liveThreadsLayer,
        Layer.succeed(McpInvocationContext.McpInvocationContext, invocationScope),
        Layer.succeed(
          CuaDriver.CuaDriver,
          CuaDriver.CuaDriver.of({
            platform: options.platform ?? "darwin",
            call: (tool, args, opts) => {
              calls.push({ tool, args, ...(opts === undefined ? {} : { opts }) });
              if (options.onCall) return options.onCall(tool, args, opts);
              return Effect.succeed({ result: { ok: true } });
            },
          }),
        ),
        Layer.succeed(
          OrchestratorMcpService.OrchestratorMcpService,
          OrchestratorMcpService.OrchestratorMcpService.of({
            requestBrowserValue: (_scope: unknown, req: unknown) =>
              Effect.sync(() => {
                asked.push(req);
                return (
                  options.secretAnswer ?? {
                    status: "saved",
                    value: Redacted.make("super-secret-value"),
                  }
                );
              }),
          } as unknown as OrchestratorMcpService.OrchestratorMcpServiceShape),
        ),
      ),
    ),
  );
};

it.effect(
  "cu_call forwards args and enables screenshot saving when include_screenshot is true",
  () =>
    Effect.gen(function* () {
      const { result, calls } = yield* runTool(
        "cu_call",
        {
          tool: "get_window_state",
          args: { pid: 123, window_id: 456, include_screenshot: true, session: "s1" },
        },
        {
          onCall: () =>
            Effect.succeed({
              result: { snapshot_id: "s00000001" },
              screenshotPath: "/tmp/cu-shot.png",
            }),
        },
      );
      expect(result).toEqual({
        result: { snapshot_id: "s00000001" },
        screenshotPath: "/tmp/cu-shot.png",
      });
      expect(calls).toEqual([
        {
          tool: "get_window_state",
          args: { pid: 123, window_id: 456, include_screenshot: true, session: "s1" },
          opts: { timeoutMs: undefined, saveScreenshot: true },
        },
      ]);
    }),
);

it.effect("cu_call rejects non-macOS hosts", () =>
  Effect.gen(function* () {
    const failure = yield* runTool("cu_call", { tool: "list_apps" }, { platform: "linux" }).pipe(
      Effect.flip,
    );
    expect(failure).toBeInstanceOf(OrchestratorMcpFailure);
    expect(failure.message).toContain("only on macOS");
  }),
);

it("isBlockedBrowserTool blocks Chrome browser_* and get_browser_state tools", () => {
  expect(CuaDriver.isBlockedBrowserTool("browser_click")).toBe(true);
  expect(CuaDriver.isBlockedBrowserTool("get_browser_state")).toBe(true);
  expect(CuaDriver.isBlockedBrowserTool("get_window_state")).toBe(false);
  expect(CuaDriver.isBlockedBrowserTool("type_text")).toBe(false);
});

it.effect("cu_request_fill validates target before opening a secret card", () =>
  Effect.gen(function* () {
    const failure = yield* runTool("cu_request_fill", {
      label: "App password",
      reason: "Sign in",
      pid: 123,
    }).pipe(Effect.flip);
    expect(failure).toBeInstanceOf(OrchestratorMcpFailure);
    expect(failure.message).toContain("element_token");
  }),
);

it.effect(
  "cu_request_fill asks via secret card and pipes value to type_text without returning it",
  () =>
    Effect.gen(function* () {
      const { result, calls, asked } = yield* runTool("cu_request_fill", {
        label: "Vault password",
        reason: "Unlock vault",
        appName: "Bitwarden",
        pid: 123,
        element_token: "s00000001:5",
        session: "bw-1",
      });
      expect(result).toEqual({ status: "filled" });
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatchObject({
        label: "Vault password",
        reason: "Bitwarden: Unlock vault",
        toolName: "cu_request_fill",
      });
      expect(calls).toEqual([
        {
          tool: "type_text",
          args: {
            pid: 123,
            element_token: "s00000001:5",
            session: "bw-1",
            text: "super-secret-value",
          },
        },
      ]);
    }),
);

it.effect("cu_request_fill supports set_value and never leaks the secret on fill failure", () =>
  Effect.gen(function* () {
    const { result, calls } = yield* runTool(
      "cu_request_fill",
      {
        label: "Token",
        reason: "Enter token",
        mode: "set_value",
        pid: 123,
        element_token: "s00000001:9",
      },
      {
        onCall: () =>
          Effect.fail(
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "failed with super-secret-value",
            }),
          ),
      },
    );
    expect(calls[0]?.tool).toBe("set_value");
    expect(calls[0]?.args).toMatchObject({ value: "super-secret-value" });
    expect(result).toMatchObject({ status: "fill_failed" });
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
  }),
);

it.effect("cu_request_fill skips cua-driver when user declines the card", () =>
  Effect.gen(function* () {
    const { result, calls } = yield* runTool(
      "cu_request_fill",
      {
        label: "Password",
        reason: "Unlock",
        pid: 123,
        element_token: "s00000001:5",
      },
      {
        secretAnswer: { status: "declined", note: "User declined." },
      },
    );
    expect(result).toEqual({ status: "declined", note: "User declined." });
    expect(calls).toHaveLength(0);
  }),
);
