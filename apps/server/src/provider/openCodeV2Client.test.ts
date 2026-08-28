import * as NodeAssert from "node:assert/strict";

import type {
  AgentInfo,
  ModelInfo,
  ProviderInfo,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageUser,
} from "@opencode-ai/client";
import { describe, it } from "vite-plus/test";

import { createOpenCodeV2Client } from "./openCodeV2Client.ts";

interface CapturedRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
  readonly signal: AbortSignal | null;
}

interface EventFixture {
  readonly id: string;
  readonly type: string;
  readonly created?: number;
  readonly location?: { readonly directory: string };
  readonly data: Record<string, unknown>;
}

const DIRECTORY = "/workspace/project";
const LOCATION = {
  directory: DIRECTORY,
  project: { id: "project", directory: DIRECTORY, canonical: DIRECTORY },
};

function makeFetch(handler: (request: CapturedRequest) => Response | Promise<Response>): {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: Array<CapturedRequest>;
} {
  const requests: Array<CapturedRequest> = [];
  const fetch = Object.assign(
    async (
      resource: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      const url = new URL(
        typeof resource === "string"
          ? resource
          : resource instanceof URL
            ? resource.href
            : resource.url,
      );
      const request: CapturedRequest = {
        url,
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
        signal: init?.signal ?? null,
      };
      requests.push(request);
      return handler(request);
    },
    { preconnect: (_url: string | URL): void => {} },
  );
  return { fetch, requests };
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function eventStream(events: ReadonlyArray<EventFixture>): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function event(
  type: string,
  data: Record<string, unknown>,
  created: number,
  id = `event-${created}`,
): EventFixture {
  return { id, type, created, location: { directory: DIRECTORY }, data };
}

function session(
  id: string,
  directory = DIRECTORY,
  overrides: Partial<SessionInfo> = {},
): SessionInfo {
  return {
    id,
    projectID: "project",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 100, updated: 100 },
    title: "Session",
    location: { directory },
    ...overrides,
  };
}

function model(id: string, providerID: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    modelID: `upstream/${id}`,
    providerID,
    name: `Model ${id}`,
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    variants: [],
    time: { released: 1_735_689_600_000 },
    cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }],
    status: "active",
    enabled: true,
    limit: { context: 128_000, output: 16_000 },
    ...overrides,
  };
}

function provider(id: string, overrides: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id,
    name: `${id} provider`,
    activation: "enabled",
    package: `@provider/${id}`,
    ...overrides,
  };
}

function agent(id: string, overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id,
    name: `Display ${id}`,
    request: { settings: {}, headers: {}, body: {} },
    mode: "primary",
    hidden: false,
    permissions: [{ action: "shell", resource: "*", effect: "ask" }],
    ...overrides,
  };
}

function assistant(
  id: string,
  overrides: Partial<SessionMessageAssistant> = {},
): SessionMessageAssistant {
  return {
    id,
    type: "assistant",
    time: { created: 200, completed: 250 },
    agent: "build",
    model: { id: "gpt-test", providerID: "openai" },
    content: [{ type: "text", text: "Assistant response" }],
    ...overrides,
  };
}

function user(id: string, text: string): SessionMessageUser {
  return { id, type: "user", time: { created: 150 }, text };
}

function inbox(sessionID: string, id = "message-user") {
  return {
    id,
    sessionID,
    type: "user",
    timeCreated: 150,
    payload: { text: "Prompt" },
    delivery: "steer",
  };
}

describe("createOpenCodeV2Client", () => {
  it("joins location-scoped providers and models while preserving agent IDs, variants, skills, and Basic auth", async () => {
    const fixtures = makeFetch((request) => {
      switch (request.url.pathname) {
        case "/api/model":
          return Response.json({
            location: LOCATION,
            data: [
              model("gpt-test", "openai", {
                variants: [
                  { id: "low", settings: { effort: "low" } },
                  { id: "high", body: { reasoning: "high" } },
                ],
              }),
              model("disabled-model", "openai", { enabled: false }),
              model("hidden-provider-model", "disabled"),
            ],
          });
        case "/api/provider":
          return Response.json({
            location: LOCATION,
            data: [
              provider("openai", { settings: { baseURL: "https://api.example.test" } }),
              provider("disabled", { activation: "disabled" }),
            ],
          });
        case "/api/agent":
          return Response.json({
            location: LOCATION,
            data: [
              agent("build", { name: "Builder", description: "Build things" }),
              agent("hidden", { mode: "subagent", hidden: true }),
            ],
          });
        case "/api/skill":
          return Response.json({
            location: LOCATION,
            data: [
              {
                id: "review",
                name: "review",
                description: "Review changes",
                location: "/skills/review/SKILL.md",
                content: "Instructions",
              },
            ],
          });
        default:
          throw new Error(`Unexpected request: ${request.method} ${request.url.pathname}`);
      }
    });
    const client = createOpenCodeV2Client({
      baseUrl: "https://opencode.example.test",
      directory: DIRECTORY,
      serverPassword: "secret",
      fetch: fixtures.fetch,
    });

    const [providers, agents, skills] = await Promise.all([
      client.provider.list(),
      client.app.agents(),
      client.app.skills(),
    ]);

    NodeAssert.deepEqual(providers.data?.connected, ["openai"]);
    NodeAssert.deepEqual(providers.data?.default, { openai: "gpt-test" });
    const openai = providers.data?.all.find((entry) => entry.id === "openai");
    NodeAssert.ok(openai);
    NodeAssert.deepEqual(Object.keys(openai.models), ["gpt-test"]);
    NodeAssert.deepEqual(openai.models["gpt-test"]?.variants, {
      low: { effort: "low" },
      high: { body: { reasoning: "high" } },
    });
    NodeAssert.equal(openai.models["gpt-test"]?.api.url, "https://api.example.test");
    NodeAssert.equal(openai.models["gpt-test"]?.capabilities.attachment, true);
    NodeAssert.equal(agents.data?.[0]?.name, "build");
    NodeAssert.equal(agents.data?.[0]?.permission[0]?.permission, "bash");
    NodeAssert.equal(agents.data?.[1]?.hidden, true);
    NodeAssert.equal(skills.data?.[0]?.location, "/skills/review/SKILL.md");

    const expectedAuthorization = `Basic ${Buffer.from("opencode:secret").toString("base64")}`;
    for (const request of fixtures.requests) {
      NodeAssert.equal(request.url.searchParams.get("location[directory]"), DIRECTORY);
      NodeAssert.equal(request.headers.get("authorization"), expectedAuthorization);
    }
  });

  it("creates located sessions, switches model and agent before prompts, and converts attachments", async () => {
    let promptCount = 0;
    const fixtures = makeFetch((request) => {
      switch (request.url.pathname) {
        case "/api/session":
          return Response.json({ data: session("ses_prompt") });
        case "/api/session/ses_prompt/model":
        case "/api/session/ses_prompt/agent":
          return noContent();
        case "/api/session/ses_prompt/prompt":
          promptCount += 1;
          return Response.json({ data: inbox("ses_prompt", `message-${promptCount}`) });
        default:
          throw new Error(`Unexpected request: ${request.method} ${request.url.pathname}`);
      }
    });
    const client = createOpenCodeV2Client({
      baseUrl: "https://opencode.example.test",
      directory: DIRECTORY,
      fetch: fixtures.fetch,
    });

    const created = await client.session.create({
      title: "Prompt session",
      permission: [{ permission: "*", pattern: "*", action: "ask" }],
    });
    NodeAssert.equal(created.data?.directory, DIRECTORY);
    NodeAssert.deepEqual(created.data?.permission, [
      { permission: "*", pattern: "*", action: "ask" },
    ]);

    const parameters = {
      sessionID: "ses_prompt",
      model: { providerID: "openai", modelID: "gpt-test" },
      variant: "high",
      agent: "plan",
      parts: [
        { type: "text" as const, text: "Review this" },
        {
          type: "file" as const,
          mime: "image/png",
          filename: "screenshot.png",
          url: "file:///workspace/screenshot.png",
        },
      ],
    };
    await client.session.promptAsync(parameters);
    await client.session.promptAsync(parameters);

    NodeAssert.deepEqual(
      fixtures.requests.map((request) => `${request.method} ${request.url.pathname}`),
      [
        "POST /api/session",
        "POST /api/session/ses_prompt/model",
        "POST /api/session/ses_prompt/agent",
        "POST /api/session/ses_prompt/prompt",
        "POST /api/session/ses_prompt/prompt",
      ],
    );
    NodeAssert.deepEqual(fixtures.requests[0]?.body, {
      location: { directory: DIRECTORY },
      title: "Prompt session",
    });
    NodeAssert.deepEqual(fixtures.requests[1]?.body, {
      model: { id: "gpt-test", providerID: "openai", variant: "high" },
    });
    NodeAssert.deepEqual(fixtures.requests[2]?.body, { agent: "plan" });
    NodeAssert.deepEqual(fixtures.requests[3]?.body, {
      text: "Review this",
      files: [{ uri: "file:///workspace/screenshot.png", name: "screenshot.png" }],
      delivery: "steer",
    });
  });

  it("waits for synchronous prompts and reads paginated assistant responses", async () => {
    const fixtures = makeFetch((request) => {
      switch (request.url.pathname) {
        case "/api/session":
          return Response.json({
            data: session("ses_sync", DIRECTORY, {
              agent: "build",
              model: { id: "gpt-test", providerID: "openai" },
            }),
          });
        case "/api/session/ses_sync/prompt":
          return Response.json({ data: inbox("ses_sync", "message-prompt") });
        case "/api/session/ses_sync/wait":
          return noContent();
        case "/api/session/ses_sync/message":
          return request.url.searchParams.get("cursor") === "older"
            ? Response.json({
                data: [
                  assistant("message-assistant", {
                    content: [
                      { type: "reasoning", text: "Thinking" },
                      { type: "text", text: "Final output" },
                    ],
                    error: { type: "provider.auth", message: "Credentials expired" },
                  }),
                ],
                cursor: {},
              })
            : Response.json({
                data: [user("message-prompt", "Prompt")],
                cursor: { next: "older" },
              });
        default:
          throw new Error(`Unexpected request: ${request.method} ${request.url.pathname}`);
      }
    });
    const client = createOpenCodeV2Client({
      baseUrl: "https://opencode.example.test",
      directory: DIRECTORY,
      fetch: fixtures.fetch,
    });
    await client.session.create({
      agent: "build",
      model: { id: "gpt-test", providerID: "openai" },
    });

    const result = await client.session.prompt({
      sessionID: "ses_sync",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-test" },
      parts: [{ type: "text", text: "Prompt" }],
    });

    NodeAssert.equal(result.data?.info.role, "assistant");
    NodeAssert.equal(result.data?.info.parentID, "message-prompt");
    NodeAssert.deepEqual(result.data?.info.error, {
      name: "ProviderAuthError",
      data: { providerID: "openai", message: "Credentials expired" },
    });
    NodeAssert.deepEqual(
      result.data?.parts.map((part) => ({
        type: part.type,
        text: "text" in part ? part.text : "",
      })),
      [
        { type: "reasoning", text: "Thinking" },
        { type: "text", text: "Final output" },
      ],
    );
    NodeAssert.deepEqual(
      fixtures.requests
        .filter((request) => request.url.pathname.endsWith("/message"))
        .map((request) => request.url.searchParams.get("order")),
      ["desc", "desc"],
    );
  });

  it("moves and waits for cross-directory forks, paginates history, updates titles, interrupts, and commits reverts", async () => {
    const destination = "/workspace/worktree";
    let moved = false;
    let reverted = false;
    const fixtures = makeFetch((request) => {
      switch (request.url.pathname) {
        case "/api/session/ses_parent":
          return Response.json({ data: session("ses_parent") });
        case "/api/session/ses_parent/fork":
          return Response.json({ data: session("ses_child") });
        case "/api/session/ses_child/move":
          moved = true;
          return noContent();
        case "/api/session/ses_child/wait":
          return noContent();
        case "/api/session/ses_child":
          return Response.json({
            data: session("ses_child", moved ? destination : DIRECTORY, {
              title: reverted ? "Reverted" : "Child",
            }),
          });
        case "/api/session/ses_child/message":
          return request.url.searchParams.get("cursor") === "next-page"
            ? Response.json({
                data: [assistant("message-assistant")],
                cursor: {},
              })
            : Response.json({
                data: [
                  {
                    id: "message-agent",
                    type: "agent-switched",
                    time: { created: 120 },
                    agent: "build",
                  },
                  user("message-user", "Hello"),
                ],
                cursor: { next: "next-page" },
              });
        case "/api/session/ses_child/rename":
          return noContent();
        case "/api/session/ses_child/interrupt":
          return Response.json({ interrupted: true });
        case "/api/session/ses_child/revert/stage":
          return Response.json({ data: { messageID: "message-assistant" } });
        case "/api/session/ses_child/revert/commit":
          reverted = true;
          return noContent();
        default:
          throw new Error(`Unexpected request: ${request.method} ${request.url.pathname}`);
      }
    });
    const client = createOpenCodeV2Client({
      baseUrl: "https://opencode.example.test",
      directory: DIRECTORY,
      fetch: fixtures.fetch,
    });
    await client.session.get({ sessionID: "ses_parent" });

    const forked = await client.session.fork({
      sessionID: "ses_parent",
      directory: destination,
    });
    NodeAssert.equal(forked.data?.directory, destination);
    NodeAssert.deepEqual(
      fixtures.requests.find((request) => request.url.pathname.endsWith("/fork"))?.body,
      { boundary: { type: "through" } },
    );

    const messages = await client.session.messages({ sessionID: "ses_child" });
    NodeAssert.deepEqual(
      messages.data?.map((entry) => entry.info.role),
      ["user", "assistant"],
    );
    NodeAssert.equal(messages.data?.[1]?.info.role, "assistant");
    if (messages.data?.[1]?.info.role === "assistant") {
      NodeAssert.equal(messages.data[1].info.parentID, "message-user");
    }

    const countBeforePermissionUpdate = fixtures.requests.length;
    const updated = await client.session.update({
      sessionID: "ses_child",
      permission: [{ permission: "edit", pattern: "*", action: "allow" }],
    });
    NodeAssert.equal(fixtures.requests.length, countBeforePermissionUpdate);
    NodeAssert.equal(updated.data?.permission?.[0]?.permission, "edit");
    await client.session.update({ sessionID: "ses_child", title: "Renamed" });
    NodeAssert.deepEqual(
      fixtures.requests.find((request) => request.url.pathname.endsWith("/rename"))?.body,
      { title: "Renamed" },
    );

    const aborted = await client.session.abort({ sessionID: "ses_child" });
    NodeAssert.equal(aborted.data, true);
    const revertedSession = await client.session.revert({
      sessionID: "ses_child",
      messageID: "message-user",
    });
    NodeAssert.equal(revertedSession.data?.title, "Reverted");
    NodeAssert.deepEqual(
      fixtures.requests.find((request) => request.url.pathname.endsWith("/revert/stage"))?.body,
      { messageID: "message-assistant", files: false },
    );
  });

  it("preserves the requested rollback boundary without restoring files twice", async () => {
    const history = [
      user("message-user-1", "First"),
      assistant("message-assistant-1"),
      user("message-user-2", "Second"),
      assistant("message-assistant-2"),
    ];
    const fixtures = makeFetch((request) => {
      if (request.url.pathname === "/api/session/ses_revert/message") {
        return Response.json({ data: history, cursor: {} });
      }
      if (request.url.pathname === "/api/session/ses_revert/revert/stage") {
        const body = request.body as { messageID: string };
        return Response.json({ data: { messageID: body.messageID } });
      }
      if (request.url.pathname === "/api/session/ses_revert/revert/commit") {
        return noContent();
      }
      if (request.url.pathname === "/api/session/ses_revert") {
        return Response.json({ data: session("ses_revert") });
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url.pathname}`);
    });
    const client = createOpenCodeV2Client({
      baseUrl: "https://opencode.example.test",
      directory: DIRECTORY,
      fetch: fixtures.fetch,
    });

    await client.session.revert({
      sessionID: "ses_revert",
      messageID: "message-assistant-1",
    });
    await client.session.revert({ sessionID: "ses_revert" });
    await client.session.revert({
      sessionID: "ses_revert",
      messageID: "message-assistant-2",
    });

    NodeAssert.deepEqual(
      fixtures.requests
        .filter((request) => request.url.pathname.endsWith("/revert/stage"))
        .map((request) => request.body),
      [
        { messageID: "message-user-2", files: false },
        { messageID: "message-user-1", files: false },
      ],
    );
    await NodeAssert.rejects(
      client.session.revert({ sessionID: "ses_revert", messageID: "message-missing" }),
      /rollback target 'message-missing' was not found/,
    );
  });

  it("auto-approves only permissions allowed by cached session rules and preserves supervised shell prompts", async () => {
    const ids = ["ses_edits", "ses_full", "ses_denied", "ses_supervised"];
    let createIndex = 0;
    const events = [
      event(
        "permission.asked",
        {
          id: "permission-edit",
          sessionID: "ses_edits",
          action: "edit",
          resources: ["src/file.ts"],
        },
        200,
      ),
      event(
        "permission.replied",
        { sessionID: "ses_edits", requestID: "permission-edit", reply: "once" },
        201,
      ),
      event(
        "permission.asked",
        {
          id: "permission-full",
          sessionID: "ses_full",
          action: "shell",
          resources: ["git status"],
        },
        202,
      ),
      event(
        "permission.replied",
        { sessionID: "ses_full", requestID: "permission-full", reply: "once" },
        203,
      ),
      event(
        "permission.asked",
        {
          id: "permission-denied",
          sessionID: "ses_denied",
          action: "edit",
          resources: ["secret/token"],
          metadata: { reason: "Explicit upstream deny" },
        },
        204,
      ),
      event(
        "permission.asked",
        {
          id: "permission-shell",
          sessionID: "ses_supervised",
          action: "shell",
          resources: ["rm generated.txt"],
          save: ["rm *"],
          metadata: { command: "rm generated.txt" },
          source: { type: "tool", messageID: "message-assistant", id: "tool-shell" },
        },
        205,
      ),
    ];
    const fixtures = makeFetch((request) => {
      if (request.url.pathname === "/api/session") {
        const id = ids[createIndex];
        createIndex += 1;
        NodeAssert.ok(id);
        return Response.json({ data: session(id) });
      }
      if (request.url.pathname === "/api/event") {
        return eventStream(events);
      }
      if (request.url.pathname.endsWith("/reply")) {
        return noContent();
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url.pathname}`);
    });
    const client = createOpenCodeV2Client({
      baseUrl: "https://opencode.example.test",
      directory: DIRECTORY,
      fetch: fixtures.fetch,
    });
    await client.session.create({
      permission: [
        { permission: "*", pattern: "*", action: "ask" },
        { permission: "edit", pattern: "*", action: "allow" },
      ],
    });
    await client.session.create({
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    });
    await client.session.create({
      permission: [
        { permission: "*", pattern: "*", action: "allow" },
        { permission: "edit", pattern: "secret/*", action: "deny" },
      ],
    });
    await client.session.create({
      permission: [{ permission: "*", pattern: "*", action: "ask" }],
    });

    const subscription = await client.event.subscribe();
    const translated = [];
    for await (const received of subscription.stream) {
      translated.push(received);
    }

    NodeAssert.deepEqual(
      translated.map((received) => received.type),
      ["permission.asked", "permission.asked"],
    );
    const denied = translated[0];
    NodeAssert.equal(denied?.type, "permission.asked");
    if (denied?.type === "permission.asked") {
      NodeAssert.equal(denied.properties.id, "permission-denied");
    }
    const shell = translated[1];
    NodeAssert.equal(shell?.type, "permission.asked");
    if (shell?.type === "permission.asked") {
      NodeAssert.equal(shell.properties.permission, "bash");
      NodeAssert.deepEqual(shell.properties.patterns, ["rm generated.txt"]);
      NodeAssert.deepEqual(shell.properties.always, ["rm *"]);
      NodeAssert.deepEqual(shell.properties.tool, {
        messageID: "message-assistant",
        callID: "tool-shell",
      });
    }

    await client.permission.reply({ requestID: "permission-shell", reply: "always" });
    await client.permission.reply({ requestID: "permission-denied", reply: "reject" });
    NodeAssert.deepEqual(
      fixtures.requests
        .filter((request) => request.url.pathname.endsWith("/reply"))
        .map((request) => ({ path: request.url.pathname, body: request.body })),
      [
        {
          path: "/api/session/ses_edits/permission/permission-edit/reply",
          body: { reply: "once" },
        },
        {
          path: "/api/session/ses_full/permission/permission-full/reply",
          body: { reply: "once" },
        },
        {
          path: "/api/session/ses_supervised/permission/permission-shell/reply",
          body: { reply: "always" },
        },
        {
          path: "/api/session/ses_denied/permission/permission-denied/reply",
          body: { reply: "reject" },
        },
      ],
    );
  });

  it("translates forms into questions and converts option labels and typed answers back into form replies", async () => {
    const questionForm = {
      id: "form-question",
      sessionID: "ses_form",
      title: "Questions",
      metadata: {
        kind: "question",
        tool: { messageID: "message-assistant", id: "tool-question" },
      },
      fields: [
        {
          key: "q0",
          type: "string",
          title: "Color",
          description: "Choose a color",
          options: [{ value: "blue-id", label: "Blue", description: "Ocean blue" }],
          custom: true,
        },
        {
          key: "q1",
          type: "multiselect",
          title: "Features",
          options: [
            { value: "alpha-id", label: "Alpha" },
            { value: "beta-id", label: "Beta" },
          ],
        },
        { key: "q2", type: "boolean", title: "Enabled" },
        { key: "q3", type: "integer", title: "Count" },
        { key: "q4", type: "external", title: "Terms", url: "https://example.test/terms" },
      ],
    };
    const events = [
      event("form.created", { form: questionForm }, 200),
      event(
        "form.replied",
        {
          id: "form-question",
          sessionID: "ses_form",
          answer: {
            q0: "blue-id",
            q1: ["alpha-id", "beta-id"],
            q2: true,
            q3: 3,
            q4: true,
          },
        },
        201,
      ),
      event(
        "form.created",
        {
          form: {
            id: "form-cancelled",
            sessionID: "ses_form",
            title: "Cancelled",
            fields: [{ key: "q0", type: "string", title: "Why?" }],
          },
        },
        202,
      ),
      event("form.cancelled", { id: "form-cancelled", sessionID: "ses_form" }, 203),
    ];
    const fixtures = makeFetch((request) => {
      if (request.url.pathname === "/api/event") {
        return eventStream(events);
      }
      if (request.url.pathname === "/api/session/ses_form/form/form-question/reply") {
        return noContent();
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url.pathname}`);
    });
    const client = createOpenCodeV2Client({
      baseUrl: "https://opencode.example.test",
      directory: DIRECTORY,
      fetch: fixtures.fetch,
    });
    const iterator = (await client.event.subscribe()).stream[Symbol.asyncIterator]();

    const asked = await iterator.next();
    NodeAssert.equal(asked.done, false);
    if (asked.done || asked.value.type !== "question.asked") {
      throw new Error("Expected a translated question request.");
    }
    NodeAssert.deepEqual(asked.value.properties.questions[0], {
      header: "Color",
      question: "Choose a color",
      options: [{ label: "Blue", description: "Ocean blue" }],
      custom: true,
    });
    NodeAssert.equal(asked.value.properties.questions[1]?.multiple, true);
    NodeAssert.deepEqual(asked.value.properties.tool, {
      messageID: "message-assistant",
      callID: "tool-question",
    });

    await client.question.reply({
      requestID: "form-question",
      answers: [["Blue"], ["Alpha", "Beta"], ["Yes"], ["3"], ["Acknowledge"]],
    });
    NodeAssert.deepEqual(fixtures.requests[1]?.body, {
      answer: {
        q0: "blue-id",
        q1: ["alpha-id", "beta-id"],
        q2: true,
        q3: 3,
        q4: true,
      },
    });

    const replied = await iterator.next();
    NodeAssert.equal(replied.done, false);
    if (!replied.done && replied.value.type === "question.replied") {
      NodeAssert.deepEqual(replied.value.properties.answers, [
        ["Blue"],
        ["Alpha", "Beta"],
        ["true"],
        ["3"],
        ["true"],
      ]);
    } else {
      throw new Error("Expected a translated question reply.");
    }

    const secondAsked = await iterator.next();
    NodeAssert.equal(secondAsked.value?.type, "question.asked");
    const rejected = await iterator.next();
    NodeAssert.equal(rejected.value?.type, "question.rejected");
    if (rejected.value?.type === "question.rejected") {
      NodeAssert.equal(rejected.value.properties.requestID, "form-cancelled");
    }
  });

  it("projects text, reasoning, tool lifecycles, session titles, retry status, errors, and abort signals", async () => {
    const events = [
      event("session.renamed", { sessionID: "ses_stream", title: "Useful title" }, 200),
      event("session.execution.started", { sessionID: "ses_stream" }, 201),
      event(
        "session.inbox.enqueued",
        {
          sessionID: "ses_stream",
          inboxID: "message-user",
          item: { type: "user", payload: { text: "Prompt" }, delivery: "steer" },
        },
        202,
      ),
      event("session.inbox.delivered", { sessionID: "ses_stream", inboxID: "message-user" }, 203),
      event(
        "session.step.started",
        {
          sessionID: "ses_stream",
          assistantMessageID: "message-assistant",
          agent: "build",
          model: { providerID: "openai", id: "gpt-test" },
        },
        204,
      ),
      event(
        "session.text.started",
        { sessionID: "ses_stream", assistantMessageID: "message-assistant", ordinal: 0 },
        205,
      ),
      event(
        "session.text.delta",
        {
          sessionID: "ses_stream",
          assistantMessageID: "message-assistant",
          ordinal: 0,
          delta: "Hello ",
        },
        206,
      ),
      event(
        "session.text.delta",
        {
          sessionID: "ses_stream",
          assistantMessageID: "message-assistant",
          ordinal: 0,
          delta: "world",
        },
        207,
      ),
      event(
        "session.text.ended",
        {
          sessionID: "ses_stream",
          assistantMessageID: "message-assistant",
          ordinal: 0,
          text: "Hello world",
        },
        208,
      ),
      event(
        "session.reasoning.delta",
        {
          sessionID: "ses_stream",
          assistantMessageID: "message-assistant",
          ordinal: 1,
          delta: "Think",
        },
        209,
      ),
      event(
        "session.reasoning.ended",
        {
          sessionID: "ses_stream",
          assistantMessageID: "message-assistant",
          ordinal: 1,
          text: "Thinking",
        },
        210,
      ),
      event(
        "session.tool.input.started",
        {
          sessionID: "ses_stream",
          assistantMessageID: "message-assistant",
          id: "tool-shell",
          name: "shell",
        },
        211,
      ),
      event(
        "session.tool.input.delta",
        {
          sessionID: "ses_stream",
          assistantMessageID: "message-assistant",
          id: "tool-shell",
          delta: '{"command":',
        },
        212,
      ),
      event(
        "session.tool.input.ended",
        {
          sessionID: "ses_stream",
          assistantMessageID: "message-assistant",
          id: "tool-shell",
          text: '{"command":"pwd"}',
        },
        213,
      ),
      event(
        "session.tool.called",
        {
          sessionID: "ses_stream",
          assistantMessageID: "message-assistant",
          id: "tool-shell",
          input: { command: "pwd" },
          executed: true,
        },
        214,
      ),
      event(
        "session.tool.progress",
        {
          sessionID: "ses_stream",
          assistantMessageID: "message-assistant",
          id: "tool-shell",
          metadata: { title: "Printing directory" },
        },
        215,
      ),
      event(
        "session.tool.success",
        {
          sessionID: "ses_stream",
          assistantMessageID: "message-assistant",
          id: "tool-shell",
          content: [
            { type: "text", text: DIRECTORY },
            {
              type: "file",
              uri: "file:///workspace/output.txt",
              mime: "text/plain",
              name: "output.txt",
            },
          ],
          metadata: { exitCode: 0 },
          executed: true,
        },
        216,
      ),
      event(
        "session.tool.input.started",
        {
          sessionID: "ses_stream",
          assistantMessageID: "message-assistant",
          id: "tool-edit",
          name: "edit",
        },
        217,
      ),
      event(
        "session.tool.failed",
        {
          sessionID: "ses_stream",
          assistantMessageID: "message-assistant",
          id: "tool-edit",
          error: { type: "tool.failure", message: "File is read-only" },
          executed: true,
        },
        218,
      ),
      event(
        "session.retry.scheduled",
        {
          sessionID: "ses_stream",
          assistantMessageID: "message-assistant",
          attempt: 2,
          at: 300,
          error: { type: "provider.rate-limit", message: "Try again" },
        },
        219,
      ),
      event(
        "session.step.ended",
        {
          sessionID: "ses_stream",
          assistantMessageID: "message-assistant",
          finish: "stop",
          cost: 0.25,
          tokens: { input: 5, output: 7, reasoning: 2, cache: { read: 1, write: 0 } },
        },
        220,
      ),
      event("session.execution.succeeded", { sessionID: "ses_stream" }, 221),
      event(
        "session.execution.failed",
        {
          sessionID: "ses_stream",
          error: { type: "provider.failure", message: "Provider failed", status: 503 },
        },
        222,
      ),
    ];
    const fixtures = makeFetch((request) => {
      if (request.url.pathname === "/api/session") {
        return Response.json({ data: session("ses_stream") });
      }
      if (request.url.pathname === "/api/event") {
        return eventStream(events);
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url.pathname}`);
    });
    const client = createOpenCodeV2Client({
      baseUrl: "https://opencode.example.test",
      directory: DIRECTORY,
      fetch: fixtures.fetch,
    });
    await client.session.create();
    const controller = new AbortController();
    const subscription = await client.event.subscribe(undefined, { signal: controller.signal });
    const translated = [];
    for await (const received of subscription.stream) {
      translated.push(received);
    }

    const title = translated.find((received) => received.type === "session.updated");
    NodeAssert.equal(title?.type, "session.updated");
    if (title?.type === "session.updated") {
      NodeAssert.equal(title.properties.info.title, "Useful title");
    }

    const messages = translated.filter((received) => received.type === "message.updated");
    NodeAssert.equal(messages[0]?.properties.info.role, "user");
    NodeAssert.equal(messages[1]?.properties.info.role, "assistant");

    const deltas = translated.filter((received) => received.type === "message.part.delta");
    NodeAssert.deepEqual(
      deltas.map((received) => ({
        partID: received.properties.partID,
        delta: received.properties.delta,
      })),
      [
        { partID: "message-assistant:text:0", delta: "Hello " },
        { partID: "message-assistant:text:0", delta: "world" },
        { partID: "message-assistant:reasoning:1", delta: "Think" },
      ],
    );

    const textCompleted = translated.find(
      (received) =>
        received.type === "message.part.updated" &&
        received.properties.part.type === "text" &&
        received.properties.part.time?.end !== undefined,
    );
    if (
      textCompleted?.type === "message.part.updated" &&
      textCompleted.properties.part.type === "text"
    ) {
      NodeAssert.equal(textCompleted.properties.part.text, "Hello world");
    } else {
      throw new Error("Expected a completed assistant text part.");
    }

    const tools = translated.flatMap((received) =>
      received.type === "message.part.updated" && received.properties.part.type === "tool"
        ? [received.properties.part]
        : [],
    );
    NodeAssert.deepEqual(
      tools.map((tool) => ({ tool: tool.tool, status: tool.state.status })),
      [
        { tool: "bash", status: "pending" },
        { tool: "bash", status: "running" },
        { tool: "bash", status: "running" },
        { tool: "bash", status: "completed" },
        { tool: "edit", status: "pending" },
        { tool: "edit", status: "error" },
      ],
    );
    const completedTool = tools.find((tool) => tool.state.status === "completed");
    if (completedTool?.state.status === "completed") {
      NodeAssert.equal(completedTool.state.attachments?.[0]?.filename, "output.txt");
      NodeAssert.equal(completedTool.state.metadata.exitCode, 0);
    } else {
      throw new Error("Expected a completed shell tool.");
    }

    const statuses = translated.flatMap((received) =>
      received.type === "session.status" ? [received.properties.status] : [],
    );
    NodeAssert.deepEqual(
      statuses.map((status) => status.type),
      ["busy", "retry", "idle"],
    );
    const failure = translated.find((received) => received.type === "session.error");
    if (failure?.type === "session.error") {
      NodeAssert.deepEqual(failure.properties.error, {
        name: "APIError",
        data: { message: "Provider failed", statusCode: 503, isRetryable: false },
      });
    } else {
      throw new Error("Expected a translated provider failure.");
    }
    NodeAssert.equal(
      fixtures.requests.find((request) => request.url.pathname === "/api/event")?.signal,
      controller.signal,
    );
  });

  it("registers location-scoped MCP servers using the V2 config shape", async () => {
    const fixtures = makeFetch((request) => {
      NodeAssert.equal(request.url.pathname, "/api/mcp/t3-code");
      NodeAssert.equal(request.method, "PUT");
      return noContent();
    });
    const client = createOpenCodeV2Client({
      baseUrl: "https://opencode.example.test",
      directory: DIRECTORY,
      fetch: fixtures.fetch,
    });

    const result = await client.mcp.add({
      name: "t3-code",
      config: {
        type: "remote",
        url: "https://mcp.example.test",
        headers: { Authorization: "Bearer token" },
        oauth: false,
        timeout: 5_000,
      },
    });

    NodeAssert.deepEqual(result.data, { "t3-code": { status: "connected" } });
    NodeAssert.equal(fixtures.requests[0]?.url.searchParams.get("location[directory]"), DIRECTORY);
    NodeAssert.deepEqual(fixtures.requests[0]?.body, {
      config: {
        type: "remote",
        url: "https://mcp.example.test",
        headers: { Authorization: "Bearer token" },
        oauth: false,
        timeout: { startup: 5_000, catalog: 5_000, execution: 5_000 },
      },
    });
  });

  it("preserves structured session-not-found errors for safe resume handling", async () => {
    const fixtures = makeFetch(() =>
      Response.json(
        {
          _tag: "SessionNotFoundError",
          sessionID: "ses_missing",
          message: "Session does not exist",
        },
        { status: 404 },
      ),
    );
    const client = createOpenCodeV2Client({
      baseUrl: "https://opencode.example.test",
      directory: DIRECTORY,
      fetch: fixtures.fetch,
    });

    await NodeAssert.rejects(client.session.get({ sessionID: "ses_missing" }), {
      _tag: "SessionNotFoundError",
      sessionID: "ses_missing",
    });
  });
});
