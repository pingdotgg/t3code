import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { SDKControlGetUsageResponse, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import {
  CLAUDE_SUBSCRIPTION_ALLOWANCE_UNAVAILABLE_MESSAGE,
  makeClaudeAllowanceReader,
  mapClaudeRateLimitEvent,
  mapClaudeUsage,
} from "./ClaudeAllowanceReader.ts";

const instanceId = ProviderInstanceId.make("claude");

const unavailableResponse = {
  session: {
    total_cost_usd: 0,
    total_api_duration_ms: 0,
    total_duration_ms: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    model_usage: {},
  },
  subscription_type: null,
  rate_limits_available: false,
  rate_limits: null,
  behaviors: null,
} satisfies SDKControlGetUsageResponse;

describe("mapClaudeUsage", () => {
  it("preserves native windows, nullable utilization, resets, and extra usage", () => {
    const allowance = mapClaudeUsage({
      instanceId,
      response: {
        ...unavailableResponse,
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 42.5, resets_at: "2026-08-11T17:00:00.000Z" },
          seven_day: { utilization: null, resets_at: null },
          seven_day_oauth_apps: null,
          seven_day_opus: { utilization: 57, resets_at: "2026-08-18T17:00:00.000Z" },
          seven_day_sonnet: { utilization: 12, resets_at: null },
          extra_usage: {
            is_enabled: true,
            monthly_limit: 50,
            used_credits: 7.5,
            utilization: 15,
            currency: "USD",
          },
        },
      },
    });

    expect(allowance).toEqual({
      provider: "claude",
      instanceId,
      status: "available",
      windows: [
        {
          scope: "five_hour",
          usedPercent: 42.5,
          resetsAt: "2026-08-11T17:00:00.000Z",
        },
        {
          scope: "seven_day",
          usedPercent: null,
          resetsAt: null,
        },
        {
          scope: "seven_day_opus",
          usedPercent: 57,
          resetsAt: "2026-08-18T17:00:00.000Z",
        },
        {
          scope: "seven_day_sonnet",
          usedPercent: 12,
          resetsAt: null,
        },
      ],
      extraUsage: {
        isEnabled: true,
        monthlyLimit: 50,
        usedCredits: 7.5,
        utilization: 15,
        currency: "USD",
      },
    });
  });

  it("uses the stable unavailable placeholder when Claude reports no limits", () => {
    expect(mapClaudeUsage({ instanceId, response: unavailableResponse })).toEqual({
      provider: "claude",
      instanceId,
      status: "unavailable",
      windows: [],
      message: CLAUDE_SUBSCRIPTION_ALLOWANCE_UNAVAILABLE_MESSAGE,
    });
  });
});

describe("mapClaudeRateLimitEvent", () => {
  it("maps the Claude SDK sparse rate-limit event", () => {
    const event = {
      type: "account.rate-limits.updated",
      eventId: EventId.make("claude-rate-limit-event"),
      provider: ProviderDriverKind.make("claude"),
      providerInstanceId: instanceId,
      threadId: ThreadId.make("thread-rate-limit"),
      createdAt: "2026-08-11T12:00:00.000Z",
      payload: {
        rateLimits: {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed",
            rateLimitType: "five_hour",
            utilization: 34,
            resetsAt: Date.parse("2026-08-11T17:00:00.000Z"),
          },
        },
      },
    } satisfies Extract<ProviderRuntimeEvent, { type: "account.rate-limits.updated" }>;

    expect(mapClaudeRateLimitEvent({ instanceId, event })).toEqual({
      provider: "claude",
      instanceId,
      status: "available",
      windows: [
        {
          scope: "five_hour",
          usedPercent: 34,
          resetsAt: "2026-08-11T17:00:00.000Z",
        },
      ],
    });
  });
});

describe("makeClaudeAllowanceReader", () => {
  it.layer(NodeServices.layer)("Claude allowance reader", (it) => {
    it.effect("initializes before usage, never yields a user message, and closes the query", () =>
      Effect.gen(function* () {
        const order: string[] = [];
        let promptResult: Promise<IteratorResult<SDKUserMessage>> | undefined;
        let options: { readonly settingSources?: ReadonlyArray<string> } | undefined;

        const reader = yield* makeClaudeAllowanceReader({
          instanceId,
          binaryPath: "/usr/bin/claude",
          homePath: "",
          environment: { ENABLE_CLAUDEAI_MCP_SERVERS: "true" },
          cwd: "/workspace",
          createQuery: (input) => {
            order.push("query");
            options = input.options;
            promptResult = input.prompt[Symbol.asyncIterator]().next();
            return {
              initializationResult: async () => {
                order.push("initialize");
                return {};
              },
              usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
                order.push("usage");
                return {
                  ...unavailableResponse,
                  rate_limits_available: true,
                  rate_limits: {
                    five_hour: { utilization: 10, resets_at: null },
                  },
                } satisfies SDKControlGetUsageResponse;
              },
              close: () => order.push("close"),
            };
          },
        });

        const allowance = yield* reader.read;
        const endedPrompt = yield* Effect.promise(() => promptResult!);

        expect(allowance.status).toBe("available");
        expect(order).toEqual(["query", "initialize", "usage", "close"]);
        expect(endedPrompt).toEqual({ done: true, value: undefined });
        expect(options?.settingSources).toEqual(["user", "project", "local"]);
      }),
    );

    it.effect("reports an unavailable allowance when the SDK method is missing", () =>
      Effect.gen(function* () {
        let closed = false;
        const reader = yield* makeClaudeAllowanceReader({
          instanceId,
          binaryPath: "/usr/bin/claude",
          homePath: "",
          createQuery: () => ({
            initializationResult: async () => ({}),
            close: () => {
              closed = true;
            },
          }),
        });

        expect(yield* reader.read).toEqual({
          provider: "claude",
          instanceId,
          status: "unavailable",
          windows: [],
          message: CLAUDE_SUBSCRIPTION_ALLOWANCE_UNAVAILABLE_MESSAGE,
        });
        expect(closed).toBe(true);
      }),
    );

    it.effect("closes the query when usage acquisition fails", () =>
      Effect.gen(function* () {
        let closed = false;
        const reader = yield* makeClaudeAllowanceReader({
          instanceId,
          binaryPath: "/usr/bin/claude",
          homePath: "",
          createQuery: () => ({
            initializationResult: async () => ({}),
            usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
              throw new Error("provider rejected request");
            },
            close: () => {
              closed = true;
            },
          }),
        });

        const error = yield* Effect.flip(reader.read);

        expect(error).toMatchObject({
          provider: "claude",
          instanceId,
          operation: "read",
        });
        expect(error.message).toContain(`instance '${instanceId}'`);
        expect(closed).toBe(true);
      }),
    );

    it.effect("bounds a hanging usage request and closes the query", () =>
      Effect.gen(function* () {
        let closed = false;
        const reader = yield* makeClaudeAllowanceReader({
          instanceId,
          binaryPath: "/usr/bin/claude",
          homePath: "",
          timeout: "10 millis",
          createQuery: () => ({
            initializationResult: async () => ({}),
            usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () =>
              new Promise<SDKControlGetUsageResponse>(() => {}),
            close: () => {
              closed = true;
            },
          }),
        });

        const error = yield* Effect.flip(reader.read);

        expect(error).toMatchObject({
          provider: "claude",
          instanceId,
          operation: "timeout",
        });
        expect(closed).toBe(true);
      }),
    );

    it.effect("uses the no-turn control wire with a fake Claude CLI", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-allowance-reader-",
        });
        const executablePath = path.join(tempDir, "fake-claude.mjs");
        const invocationPath = path.join(tempDir, "invocation.json");

        yield* fileSystem.writeFileString(
          executablePath,
          [
            "#!/usr/bin/env node",
            'import { writeFileSync } from "node:fs";',
            'import { createInterface } from "node:readline";',
            "const messages = [];",
            "const writeInvocation = () => writeFileSync(process.env.T3_INVOCATION_PATH, JSON.stringify({ messages }));",
            "const lines = createInterface({ input: process.stdin });",
            'lines.on("line", (line) => {',
            "  const message = JSON.parse(line);",
            "  messages.push(message);",
            '  if (message.type !== "control_request") return;',
            '  if (message.request?.subtype === "initialize") {',
            "    process.stdout.write(JSON.stringify({",
            '      type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {',
            '        commands: [], agents: [], output_style: "default", available_output_styles: ["default"], models: [], account: {},',
            "      } },",
            '    }) + "\\n");',
            "    return;",
            "  }",
            '  if (message.request?.subtype === "get_usage") {',
            "    writeInvocation();",
            "    process.stdout.write(JSON.stringify({",
            '      type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {',
            "        session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },",
            '        subscription_type: "max", rate_limits_available: true,',
            "        rate_limits: { five_hour: { utilization: 25, resets_at: null } }, behaviors: null,",
            "      } },",
            '    }) + "\\n");',
            "  }",
            "});",
            "setInterval(() => {}, 1_000);",
            "",
          ].join("\n"),
        );
        yield* fileSystem.chmod(executablePath, 0o755);

        const reader = yield* makeClaudeAllowanceReader({
          instanceId,
          binaryPath: executablePath,
          homePath: "",
          environment: { ...process.env, T3_INVOCATION_PATH: invocationPath },
          cwd: tempDir,
        });

        expect(yield* reader.read).toMatchObject({
          provider: "claude",
          instanceId,
          status: "available",
          windows: [{ scope: "five_hour", usedPercent: 25, resetsAt: null }],
        });

        // @effect-diagnostics-next-line preferSchemaOverJson:off
        const invocation = JSON.parse(yield* fileSystem.readFileString(invocationPath)) as {
          readonly messages: ReadonlyArray<{
            readonly type?: string;
            readonly request?: { readonly subtype?: string };
          }>;
        };
        expect(
          invocation.messages
            .filter((message) => message.type === "control_request")
            .map((message) => message.request?.subtype),
        ).toEqual(["initialize", "get_usage"]);
        expect(invocation.messages.some((message) => message.type === "user")).toBe(false);
      }).pipe(Effect.scoped),
    );
  });
});
