import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";
import { DEFAULT_MODEL, ThreadId } from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import { buildCodexDeveloperInstructions } from "../CodexDeveloperInstructions.ts";
import { codexSessionAppServerArgs } from "./codexLaunchArgs.ts";
import {
  buildTurnStartParams,
  describeMcpElicitation,
  hasConfiguredMcpServer,
  isRecoverableThreadResumeError,
  makeMemoryConsolidationNotificationFilter,
  openCodexThread,
  resolveCodexSkillInputs,
  makeCodexTurnStarter,
  toMcpElicitationResponse,
} from "./CodexSessionRuntime.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

describe("CodexSessionRuntimeIdentifierGenerationError", () => {
  it("retains identifier purpose and the random source failure", () => {
    const cause = new Error("random source unavailable");
    const error = new CodexErrors.CodexAppServerIdentifierGenerationError({
      purpose: "provider-event",
      cause,
    });

    NodeAssert.equal(error.purpose, "provider-event");
    NodeAssert.strictEqual(error.cause, cause);
    NodeAssert.equal(
      error.message,
      "Failed to generate Codex App Server identifier for provider-event.",
    );
  });
});

function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "danger-full-access" },
    thread: {
      id: threadId,
      createdAt: "2026-04-18T00:00:00.000Z",
      source: { session: "cli" },
      turns: [],
      status: {
        state: "idle",
        activeFlags: [],
      },
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

describe("buildTurnStartParams", () => {
  it("keeps invalid turn values only in the schema cause", () => {
    const secret = "codex-turn-input-secret-sentinel";
    const error = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        attachments: [
          {
            type: "image",
            url: { secret } as unknown as string,
          },
        ],
      }).pipe(Effect.flip),
    );
    const { cause, ...directDiagnostics } = error;

    NodeAssert.equal(error.operation, "decode-request-payload");
    NodeAssert.equal(error.method, "turn/start");
    NodeAssert.ok((error.issueCount ?? 0) > 0);
    NodeAssert.ok(error.issueKinds?.includes("Pointer"));
    NodeAssert.ok((error.maximumPathDepth ?? 0) > 0);
    NodeAssert.ok(Schema.isSchemaError(cause));
    NodeAssert.doesNotMatch(error.message, new RegExp(secret));
    NodeAssert.doesNotMatch(JSON.stringify(directDiagnostics), new RegExp(secret));
  });

  it("includes plan collaboration mode when requested", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Make a plan",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "plan",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
      input: [
        {
          type: "text",
          text: "Make a plan",
        },
      ],
      model: "gpt-5.3-codex",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("plan", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("includes default collaboration mode and image attachments", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("default", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("reports the same fallback model and effort in settings and instructions", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Go",
        interactionMode: "default",
      }),
    );

    const settings = params.collaborationMode?.settings;
    NodeAssert.equal(settings?.model, DEFAULT_MODEL);
    NodeAssert.equal(settings?.reasoning_effort, "medium");
    NodeAssert.ok(settings?.developer_instructions?.includes(`as ${DEFAULT_MODEL} with medium`));
  });

  it.effect("routes approvals to the auto reviewer in auto mode", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto",
        prompt: "Ship it",
      });

      NodeAssert.deepStrictEqual(params, {
        threadId: "provider-thread-1",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
        input: [
          {
            type: "text",
            text: "Ship it",
          },
        ],
      });
    }),
  );

  it("omits collaboration mode when interaction mode is absent", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
      },
      input: [
        {
          type: "text",
          text: "Review",
        },
      ],
    });
  });
});

const codexSkill = (
  name: string,
  path: string,
  enabled = true,
): EffectCodexSchema.V2SkillsListResponse__SkillMetadata => ({
  name,
  path,
  enabled,
  description: `${name} description`,
  scope: path.includes("/project/") ? "repo" : "user",
});

describe("resolveCodexSkillInputs", () => {
  const wayfinderProject = codexSkill("wayfinder", "/project/.agents/skills/wayfinder/SKILL.md");

  it("resolves multiple skills in textual order and deduplicates repeated tokens", () => {
    NodeAssert.deepStrictEqual(
      resolveCodexSkillInputs("Use $two then $one and $two again", [
        codexSkill("one", "/project/.agents/skills/one/SKILL.md"),
        codexSkill("two", "/project/.agents/skills/two/SKILL.md"),
      ]),
      [
        { name: "two", path: "/project/.agents/skills/two/SKILL.md" },
        { name: "one", path: "/project/.agents/skills/one/SKILL.md" },
      ],
    );
  });

  it("uses the first enabled catalog entry for duplicate names", () => {
    NodeAssert.deepStrictEqual(
      resolveCodexSkillInputs("$wayfinder 687", [
        wayfinderProject,
        codexSkill("wayfinder", "/Users/me/.agents/skills/wayfinder/SKILL.md"),
      ]),
      [{ name: "wayfinder", path: "/project/.agents/skills/wayfinder/SKILL.md" }],
    );
  });

  it("ignores unknown and disabled skills", () => {
    NodeAssert.deepStrictEqual(
      resolveCodexSkillInputs("$not-installed and $disabled ", [
        codexSkill("disabled", "/project/.agents/skills/disabled/SKILL.md", false),
      ]),
      [],
    );
  });

  it("recognizes a skill token at the end of the prompt", () => {
    NodeAssert.deepStrictEqual(
      resolveCodexSkillInputs("Please use $wayfinder", [wayfinderProject]),
      [{ name: "wayfinder", path: "/project/.agents/skills/wayfinder/SKILL.md" }],
    );
  });

  it("matches skill names exactly and ignores punctuation-adjacent text", () => {
    NodeAssert.deepStrictEqual(
      resolveCodexSkillInputs("Skip $Wayfinder and $wayfinder, then use $wayfinder", [
        wayfinderProject,
      ]),
      [{ name: "wayfinder", path: "/project/.agents/skills/wayfinder/SKILL.md" }],
    );
  });
});

describe("startCodexTurn", () => {
  const startCodexTurn = (
    input: Parameters<ReturnType<typeof makeCodexTurnStarter>>[0] & {
      client: Parameters<typeof makeCodexTurnStarter>[0];
    },
  ) => makeCodexTurnStarter(input.client)(input);
  const turnResponse = {
    turn: {
      id: "turn-1",
      items: [],
      status: "inProgress",
    },
  } satisfies EffectCodexSchema.V2TurnStartResponse;
  const skillCatalog = (
    skills: ReadonlyArray<EffectCodexSchema.V2SkillsListResponse__SkillMetadata>,
  ): EffectCodexSchema.V2SkillsListResponse => ({
    data: [{ cwd: "/project", errors: [], skills }],
  });
  const makeClient = (
    requests: Array<{ readonly method: string; readonly payload: unknown }>,
    catalog: Effect.Effect<EffectCodexSchema.V2SkillsListResponse, CodexErrors.CodexAppServerError>,
  ) => ({
    request: (method: "skills/list", payload: EffectCodexSchema.V2SkillsListParams) => {
      requests.push({ method, payload });
      return catalog;
    },
    raw: {
      request: (method: "turn/start", payload: unknown) => {
        requests.push({ method, payload });
        return Effect.succeed(turnResponse);
      },
    },
  });

  it.effect("keeps follow-ups behind a pending skill lookup", () =>
    Effect.gen(function* () {
      const requests: Array<{ readonly method: string; readonly payload: unknown }> = [];
      const lookupStarted = yield* Deferred.make<void>();
      const catalog = yield* Deferred.make<EffectCodexSchema.V2SkillsListResponse>();
      const startTurn = makeCodexTurnStarter(
        makeClient(
          requests,
          Deferred.succeed(lookupStarted, undefined).pipe(Effect.andThen(Deferred.await(catalog))),
        ),
      );
      const first = yield* startTurn({
        cwd: "/project",
        turn: {
          threadId: "provider-thread-1",
          runtimeMode: "full-access",
          prompt: "$wayfinder first",
        },
      }).pipe(Effect.forkChild);
      yield* Deferred.await(lookupStarted);
      const second = yield* startTurn({
        cwd: "/project",
        turn: {
          threadId: "provider-thread-1",
          runtimeMode: "full-access",
          prompt: "follow-up",
        },
      }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      NodeAssert.deepStrictEqual(
        requests.map((request) => request.method),
        ["skills/list"],
      );
      yield* Deferred.succeed(
        catalog,
        skillCatalog([codexSkill("wayfinder", "/project/.agents/skills/wayfinder/SKILL.md")]),
      );
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      NodeAssert.deepStrictEqual(
        requests
          .filter((request) => request.method === "turn/start")
          .map(
            (request) =>
              (request.payload as { input: ReadonlyArray<{ text?: string }> }).input[0]?.text,
          ),
        ["$wayfinder first", "follow-up"],
      );
    }),
  );

  it.effect("sends an explicit skill as structured turn input", () =>
    Effect.gen(function* () {
      const requests: Array<{ readonly method: string; readonly payload: unknown }> = [];
      const catalog = skillCatalog([
        codexSkill("wayfinder", "/project/.agents/skills/wayfinder/SKILL.md"),
      ]);

      yield* startCodexTurn({
        client: makeClient(requests, Effect.succeed(catalog)),
        cwd: "/project",
        turn: {
          threadId: "provider-thread-1",
          runtimeMode: "full-access",
          prompt: "$wayfinder 687",
        },
      });

      NodeAssert.deepStrictEqual(requests[0], {
        method: "skills/list",
        payload: { cwds: ["/project"] },
      });
      const turnStart = requests[1]?.payload as
        | { readonly input: ReadonlyArray<unknown> }
        | undefined;
      NodeAssert.ok(turnStart);
      NodeAssert.deepStrictEqual(turnStart.input, [
        { type: "text", text: "$wayfinder 687" },
        {
          type: "skill",
          name: "wayfinder",
          path: "/project/.agents/skills/wayfinder/SKILL.md",
        },
      ]);
    }),
  );

  it.effect("uses the returned catalog when App Server normalizes the cwd", () =>
    Effect.gen(function* () {
      const requests: Array<{ readonly method: string; readonly payload: unknown }> = [];
      const catalog = {
        data: [
          {
            cwd: "/private/project",
            errors: [],
            skills: [codexSkill("wayfinder", "/project/.agents/skills/wayfinder/SKILL.md")],
          },
        ],
      } satisfies EffectCodexSchema.V2SkillsListResponse;

      yield* startCodexTurn({
        client: makeClient(requests, Effect.succeed(catalog)),
        cwd: "/project",
        turn: {
          threadId: "provider-thread-1",
          runtimeMode: "full-access",
          prompt: "$wayfinder 687",
        },
      });

      const turnStart = requests[1]?.payload as
        | { readonly input: ReadonlyArray<unknown> }
        | undefined;
      NodeAssert.ok(turnStart);
      NodeAssert.deepStrictEqual(turnStart.input[1], {
        type: "skill",
        name: "wayfinder",
        path: "/project/.agents/skills/wayfinder/SKILL.md",
      });
    }),
  );

  it.effect("sends structured skills between the original text and image inputs", () =>
    Effect.gen(function* () {
      const requests: Array<{ readonly method: string; readonly payload: unknown }> = [];
      const catalog = skillCatalog([
        codexSkill("wayfinder", "/project/.agents/skills/wayfinder/SKILL.md"),
      ]);

      yield* startCodexTurn({
        client: makeClient(requests, Effect.succeed(catalog)),
        cwd: "/project",
        turn: {
          threadId: "provider-thread-1",
          runtimeMode: "full-access",
          prompt: "$wayfinder 687",
          attachments: [{ type: "image", url: "data:image/png;base64,abc" }],
        },
      });

      NodeAssert.deepStrictEqual(requests[0], {
        method: "skills/list",
        payload: { cwds: ["/project"] },
      });
      const turnStartRequest = requests[1];
      NodeAssert.ok(turnStartRequest);
      NodeAssert.deepStrictEqual(
        (turnStartRequest.payload as { input: ReadonlyArray<unknown> }).input,
        [
          { type: "text", text: "$wayfinder 687" },
          {
            type: "skill",
            name: "wayfinder",
            path: "/project/.agents/skills/wayfinder/SKILL.md",
          },
          { type: "image", url: "data:image/png;base64,abc" },
        ],
      );
    }),
  );

  it.effect("does not list skills for an ordinary prompt", () =>
    Effect.gen(function* () {
      const requests: Array<{ readonly method: string; readonly payload: unknown }> = [];

      yield* startCodexTurn({
        client: makeClient(requests, Effect.die("skills/list should not be called")),
        cwd: "/project",
        turn: {
          threadId: "provider-thread-1",
          runtimeMode: "full-access",
          prompt: "ordinary prompt",
        },
      });

      NodeAssert.deepStrictEqual(requests, [
        {
          method: "turn/start",
          payload: {
            threadId: "provider-thread-1",
            approvalPolicy: "never",
            approvalsReviewer: "user",
            sandboxPolicy: { type: "dangerFullAccess" },
            input: [{ type: "text", text: "ordinary prompt" }],
          },
        },
      ]);
    }),
  );

  it.effect("falls back to the original turn when skill discovery fails", () => {
    const messages: string[] = [];
    const logger = Logger.make(({ message }) => messages.push(String(message)));
    const requests: Array<{ readonly method: string; readonly payload: unknown }> = [];
    const catalogFailure = Effect.fail(
      new CodexErrors.CodexAppServerRequestError({
        code: -32603,
        errorMessage: "catalog unavailable",
      }),
    );

    return Effect.gen(function* () {
      yield* startCodexTurn({
        client: makeClient(requests, catalogFailure),
        cwd: "/project",
        turn: {
          threadId: "provider-thread-1",
          runtimeMode: "full-access",
          prompt: "$wayfinder 687",
          attachments: [{ type: "image", url: "data:image/png;base64,abc" }],
        },
      });

      NodeAssert.deepStrictEqual(requests[0], {
        method: "skills/list",
        payload: { cwds: ["/project"] },
      });
      const turnStartRequest = requests[1];
      NodeAssert.ok(turnStartRequest);
      NodeAssert.deepStrictEqual(
        (turnStartRequest.payload as { input: ReadonlyArray<unknown> }).input,
        [
          { type: "text", text: "$wayfinder 687" },
          { type: "image", url: "data:image/png;base64,abc" },
        ],
      );
      NodeAssert.ok(
        messages.some((message) =>
          message.includes("Unable to resolve explicit Codex skills before turn."),
        ),
      );
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });

  it.effect("falls back after five seconds when skill discovery stalls", () =>
    Effect.gen(function* () {
      const requests: Array<{ readonly method: string; readonly payload: unknown }> = [];
      const turn = yield* startCodexTurn({
        client: makeClient(requests, Effect.never),
        cwd: "/project",
        turn: {
          threadId: "provider-thread-1",
          runtimeMode: "full-access",
          prompt: "$wayfinder 687",
        },
      }).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      NodeAssert.deepStrictEqual(
        [...requests],
        [{ method: "skills/list", payload: { cwds: ["/project"] } }],
      );

      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(turn);

      const turnStartRequest = requests[1];
      NodeAssert.ok(turnStartRequest);
      NodeAssert.deepStrictEqual(
        (turnStartRequest.payload as { input: ReadonlyArray<unknown> }).input,
        [{ type: "text", text: "$wayfinder 687" }],
      );
    }),
  );
});

describe("Codex MCP elicitation approvals", () => {
  const request = {
    mode: "form",
    message: "Allow ChatGPT to use Safari?",
    serverName: "computer-use",
    threadId: "provider-thread-1",
    turnId: "turn-1",
    _meta: {
      app_name: "Safari",
      persist: ["session", "always"],
    },
    requestedSchema: {
      type: "object",
      properties: {
        approval: {
          type: "string",
          oneOf: [
            { const: "once", title: "Allow once" },
            { const: "session", title: "Allow for this session" },
            { const: "always", title: "Always allow Safari" },
          ],
        },
      },
      required: ["approval"],
    },
  } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

  it("preserves the app name and advertised persistence choices", () => {
    NodeAssert.deepStrictEqual(describeMcpElicitation(request), {
      appName: "Safari",
      options: [
        { decision: "cancel", label: "Cancel" },
        { decision: "decline", label: "Decline" },
        { decision: "acceptForSession", label: "Allow for this session" },
        { decision: "acceptAlways", label: "Always allow Safari" },
        { decision: "accept", label: "Approve" },
      ],
    });
  });

  it("extracts the app name from a Computer Use request without metadata", () => {
    const { _meta, ...requestWithoutMetadata } = request;

    NodeAssert.equal(describeMcpElicitation(requestWithoutMetadata).appName, "Safari");
  });

  it("returns the accepted form option to Codex", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "accept"), {
      action: "accept",
      content: { approval: "once" },
    });
  });

  it("returns session-scoped approval in the MCP response", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "acceptForSession"), {
      action: "accept",
      _meta: { persist: "session" },
      content: { approval: "session" },
    });
  });

  it("returns persistent approval in the MCP response", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { approval: "always" },
    });
  });

  it("returns rejection without form content", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "decline"), {
      action: "decline",
    });
  });

  it("returns cancellation without form content", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "cancel"), {
      action: "cancel",
    });
  });

  it("supports boolean permanent-approval fields", () => {
    const booleanRequest = {
      ...request,
      _meta: { app_name: "Safari" },
      requestedSchema: {
        type: "object",
        properties: {
          always: { type: "boolean", title: "Always allow Safari" },
        },
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.ok(
      describeMcpElicitation(booleanRequest).options.some(
        (option) => option.decision === "acceptAlways",
      ),
    );
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(booleanRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { always: true },
    });
  });

  it("preserves valid nullable MCP form fields and persistence choices", () => {
    const nullableRequest = {
      ...request,
      _meta: {
        app_name: null,
        appName: "Safari",
        connector_name: null,
        persist: null,
        target: null,
        tool_params: null,
      },
      requestedSchema: {
        type: "object",
        properties: {
          approval: {
            type: "string",
            title: null,
            description: null,
            default: null,
            enum: ["once", "always"],
            enumNames: null,
          },
        },
        required: ["approval"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.equal(describeMcpElicitation(nullableRequest).appName, "Safari");
    NodeAssert.ok(
      describeMcpElicitation(nullableRequest).options.some(
        (option) => option.decision === "acceptAlways",
      ),
    );
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(nullableRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { approval: "always" },
    });
  });

  it("declines required form fields that an approval prompt cannot collect", () => {
    const inputRequest = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
        },
        required: ["email"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(inputRequest, "accept"), {
      action: "decline",
    });
  });

  it("does not approve URL elicitations without opening their requested URL", () => {
    const urlRequest = {
      mode: "url",
      message: "Finish signing in to continue.",
      serverName: "computer-use",
      threadId: "provider-thread-1",
      turnId: "turn-1",
      elicitationId: "sign-in-1",
      url: "https://example.com/authorize",
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(urlRequest, "accept"), {
      action: "decline",
    });
  });

  it("omits persistence choices that cannot satisfy required form fields", () => {
    const onceOnlyRequest = {
      ...request,
      _meta: { app_name: "Safari", persist: ["session", "always"] },
      requestedSchema: {
        type: "object",
        properties: {
          approval: {
            type: "string",
            enum: ["once"],
          },
        },
        required: ["approval"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(describeMcpElicitation(onceOnlyRequest).options, [
      { decision: "cancel", label: "Cancel" },
      { decision: "decline", label: "Decline" },
      { decision: "accept", label: "Approve" },
    ]);
  });
});

describe("buildCodexDeveloperInstructions", () => {
  it("appends runtime info after the mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });

    NodeAssert.match(instructions, /^<collaboration_mode># Collaboration Mode: Default/);
    NodeAssert.match(instructions, /T3 Code/);
    NodeAssert.match(instructions, /Codex harness/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with high reasoning effort/);
  });

  it("describes Markdown media support in the runtime context in both modes", () => {
    for (const mode of ["default", "plan"] as const) {
      const instructions = buildCodexDeveloperInstructions(mode, {
        model: "gpt-5.3-codex",
        reasoningEffort: "high",
      });
      NodeAssert.match(
        instructions,
        /<runtime_info>.*embed images and videos.*Markdown.*<\/runtime_info>/,
      );
    }
  });

  it("includes runtime info alongside plan mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("plan", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });

    NodeAssert.match(instructions, /^<collaboration_mode># Plan Mode/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with medium reasoning effort/);
  });

  it("varies with the model and effort of each turn", () => {
    const first = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });
    const second = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.4",
      reasoningEffort: "high",
    });

    NodeAssert.notEqual(first, second);
  });

  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

describe("T3 browser developer instructions", () => {
  const runtime = { model: "gpt-5.3-codex", reasoningEffort: "high" };

  it("prefers the product-native preview tools in both collaboration modes", () => {
    for (const mode of ["default", "plan"] as const) {
      const instructions = buildCodexDeveloperInstructions(mode, runtime, true);
      NodeAssert.match(instructions, /t3-code/);
      NodeAssert.match(instructions, /preview_status/);
      NodeAssert.match(instructions, /preview_open/);
      NodeAssert.match(instructions, /Do not switch to global browser skills/);
    }
  });

  it("omits the browser block entirely when the preview tools are not attached", () => {
    for (const mode of ["default", "plan"] as const) {
      const instructions = buildCodexDeveloperInstructions(mode, runtime, false);
      NodeAssert.doesNotMatch(instructions, /preview_status/);
      NodeAssert.doesNotMatch(instructions, /preview_open/);
      NodeAssert.doesNotMatch(instructions, /T3 Code collaborative browser/);
      // Steering away from other browser automation must go with the tools;
      // keeping it would leave the model talked out of its only option.
      NodeAssert.doesNotMatch(instructions, /Do not switch to global browser skills/);
      // The rest of the collaboration mode is untouched.
      NodeAssert.match(instructions, /<collaboration_mode>/);
      NodeAssert.match(instructions, /<\/collaboration_mode>/);
    }
  });

  it("tracks the turn's MCP configuration rather than defaulting to on", () => {
    NodeAssert.match(buildCodexDeveloperInstructions("default", runtime, true), /preview_open/);
    NodeAssert.doesNotMatch(
      buildCodexDeveloperInstructions("default", runtime, false),
      /preview_open/,
    );
  });
});

describe("hasConfiguredMcpServer", () => {
  it("detects inline Codex MCP configuration arguments", () => {
    NodeAssert.equal(hasConfiguredMcpServer(undefined), false);
    NodeAssert.equal(hasConfiguredMcpServer(["--model", "gpt-5.4"]), false);
    NodeAssert.equal(
      hasConfiguredMcpServer(["-c", 'mcp_servers.t3-code.url="http://127.0.0.1/mcp"']),
      true,
    );
  });
});

function makeThreadStartedNotification(
  threadId: string,
  source: EffectCodexSchema.V2ThreadStartedNotification["thread"]["source"],
  threadSource?: string,
) {
  return {
    method: "thread/started" as const,
    params: {
      thread: {
        cliVersion: "0.0.0",
        createdAt: 0,
        cwd: "/tmp/project",
        ephemeral: true,
        id: threadId,
        modelProvider: "openai",
        preview: "",
        sessionId: threadId,
        source,
        status: { type: "idle" as const },
        ...(threadSource ? { threadSource } : {}),
        turns: [],
        updatedAt: 0,
      },
    },
  };
}

describe("makeMemoryConsolidationNotificationFilter", () => {
  it("suppresses memory consolidation without hiding other Codex subagents", () => {
    const shouldSuppress = makeMemoryConsolidationNotificationFilter();

    NodeAssert.equal(
      shouldSuppress(
        makeThreadStartedNotification("memory-thread", "unknown", "memory_consolidation"),
      ),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "item/agentMessage/delta",
        params: {
          delta: "internal memory update",
          itemId: "memory-message",
          threadId: "memory-thread",
          turnId: "memory-turn",
        },
      }),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "serverRequest/resolved",
        params: {
          requestId: "memory-approval",
          threadId: "memory-thread",
        },
      }),
      false,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "warning",
        params: {
          message: "internal warning",
          threadId: "memory-thread",
        },
      }),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "item/agentMessage/delta",
        params: {
          delta: "normal reply",
          itemId: "root-message",
          threadId: "root-thread",
          turnId: "root-turn",
        },
      }),
      false,
    );

    NodeAssert.equal(
      shouldSuppress(
        makeThreadStartedNotification("legacy-memory-thread", {
          subAgent: "memory_consolidation",
        }),
      ),
      true,
    );

    for (const source of [
      { subAgent: "review" as const },
      { subAgent: "compact" as const },
      {
        subAgent: {
          thread_spawn: {
            depth: 1,
            parent_thread_id: "root-thread",
          },
        },
      },
    ]) {
      NodeAssert.equal(
        shouldSuppress(makeThreadStartedNotification("visible-subagent", source)),
        false,
      );
    }
  });

  it("forgets memory consolidation threads after they close", () => {
    const shouldSuppress = makeMemoryConsolidationNotificationFilter();
    shouldSuppress(
      makeThreadStartedNotification("memory-thread", "unknown", "memory_consolidation"),
    );

    NodeAssert.equal(
      shouldSuppress({
        method: "thread/closed",
        params: { threadId: "memory-thread" },
      }),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "item/agentMessage/delta",
        params: {
          delta: "later message",
          itemId: "later-message",
          threadId: "memory-thread",
          turnId: "later-turn",
        },
      }),
      false,
    );
  });
});

describe("codexSessionAppServerArgs", () => {
  it("keeps the app-server subcommand when explicit args are provided", () => {
    NodeAssert.deepStrictEqual(codexSessionAppServerArgs(["-c", "model=gpt-5"], undefined), [
      "app-server",
      "-c",
      "model=gpt-5",
    ]);
  });

  it("keeps launch args when explicit app-server args are provided", () => {
    NodeAssert.deepStrictEqual(
      codexSessionAppServerArgs(
        ["-c", "mcp_servers.t3-code.url=http://127.0.0.1/mcp"],
        "--strict-config --enable foo",
      ),
      [
        "app-server",
        "--strict-config",
        "--enable",
        "foo",
        "-c",
        "mcp_servers.t3-code.url=http://127.0.0.1/mcp",
      ],
    );
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches missing thread errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Thread does not exist",
        }),
      ),
      true,
    );
  });

  it("matches a missing rollout for a known thread id", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "no rollout found for thread id 019fdf74-aaa9-7950-b252-7cc7a8650470",
        }),
      ),
      true,
    );
  });

  it("ignores non-recoverable resume errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Permission denied",
        }),
      ),
      false,
    );
  });

  it("ignores unrelated missing-resource errors that do not mention threads", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Config file not found",
        }),
      ),
      false,
    );
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Model does not exist",
        }),
      ),
      false,
    );
  });
});

describe("openCodexThread", () => {
  it.effect("falls back to thread/start when resume fails recoverably", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
      const started = makeThreadOpenResponse("fresh-thread");
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push({ method, payload });
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "thread not found",
              }),
            );
          }
          return Effect.succeed(started as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };

      const opened = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      });

      NodeAssert.equal(opened.thread.id, "fresh-thread");
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["thread/resume", "thread/start"],
      );
    }),
  );

  it.effect("propagates non-recoverable resume failures", () =>
    Effect.gen(function* () {
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          _payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "timed out waiting for server",
              }),
            );
          }
          return Effect.succeed(
            makeThreadOpenResponse("fresh-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
          );
        },
      };

      const error = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      }).pipe(Effect.flip);

      NodeAssert.ok(isCodexAppServerRequestError(error));
      NodeAssert.equal(error.errorMessage, "timed out waiting for server");
    }),
  );
});
