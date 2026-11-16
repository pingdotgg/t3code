import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as DashboardTools from "./DashboardTools.ts";
import * as ThreadDashboard from "./ThreadDashboard.ts";

/** A Normal thread with its Dashboard on, and a Chat thread with it off: the switch decides, not the mode. */
const dashboardThread = ThreadId.make("thread:dashboard-tools");
const dashboardOffThread = ThreadId.make("thread:dashboard-tools:chat-off");

const scopeFor = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("dashboard-tools-environment"),
  requestNamespace: "dashboard-tools-session",
  thread: {
    threadId,
    providerSessionId: "dashboard-tools-session",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(),
});
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "dashboard-tools", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "dashboard-tools", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const layer = McpHttpServer.toolkitRegistration(
  DashboardTools.DashboardToolkit,
  DashboardTools.layerHandlers,
).pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(ThreadDashboard.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
  Layer.provide(
    ServerSettings.layerTest({
      threadDisplayModes: { [dashboardOffThread]: "chat-replies" },
      threadDashboards: { [dashboardThread]: true },
    }),
  ),
);

const call = (
  name: "dashboard_set" | "dashboard_get",
  args: Record<string, unknown>,
  threadId = dashboardThread,
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scopeFor(threadId)),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

const errorText = (result: McpSchema.CallToolResult) => JSON.stringify(result.content);

it.effect("writes a slot and reads it back with its title and age", () =>
  Effect.gen(function* () {
    const written = yield* call("dashboard_set", {
      slot: "working",
      old_text: "",
      new_text: "**Port** the 中文 tests",
    });
    expect(written.structuredContent).toEqual({
      ok: true,
      message: "Written: working 18/1000 visible units",
    });
    const read = yield* call("dashboard_get", {});
    expect(read.structuredContent).toMatchObject({
      slots: [
        { slot: "decide", title: "Needs your decision", text: "", updatedAt: null, age: null },
        { slot: "waiting", title: "Waiting", text: "" },
        {
          slot: "working",
          title: "Working",
          text: "**Port** the 中文 tests",
          updatedAt: "1970-01-01T00:00:00.000Z",
          age: "just now",
        },
        { slot: "autoreview", title: "Auto review" },
        { slot: "humanreview", title: "Human review" },
        { slot: "merged", title: "Recently merged" },
      ],
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("clears a slot with empty text", () =>
  Effect.gen(function* () {
    yield* call("dashboard_set", { slot: "merged", old_text: "", new_text: "PR 12" });
    const cleared = yield* call("dashboard_set", {
      slot: "merged",
      old_text: "PR 12",
      new_text: "",
    });
    expect(cleared.structuredContent).toEqual({
      ok: true,
      message: "Written: merged 0/1000 visible units",
    });
    const read = yield* call("dashboard_get", {});
    expect(read.structuredContent).toMatchObject({ slots: { 5: { slot: "merged", text: "" } } });
  }).pipe(Effect.provide(layer)),
);

it.effect("takes 1000 visible units and refuses 1002 without writing", () =>
  Effect.gen(function* () {
    const atLimit = yield* call("dashboard_set", {
      slot: "decide",
      old_text: "",
      new_text: "a".repeat(1000),
    });
    expect(atLimit.isError).not.toBe(true);
    const over = yield* call("dashboard_set", {
      slot: "decide",
      old_text: "a".repeat(1000),
      new_text: "中".repeat(334),
    });
    expect(over.isError).toBe(true);
    expect(errorText(over)).toContain("Refused: decide has 1002 visible units, limit 1000");
    const read = yield* call("dashboard_get", {});
    expect(read.structuredContent).toMatchObject({ slots: { 0: { text: "a".repeat(1000) } } });
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses text over 6,000 bytes once JSON-escaped", () =>
  Effect.gen(function* () {
    const result = yield* call("dashboard_set", {
      slot: "decide",
      old_text: "",
      new_text: "\\".repeat(3_001),
    }).pipe(Effect.exit);
    expect(Exit.isFailure(result)).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses an old_text that no longer matches and shows the current text", () =>
  Effect.gen(function* () {
    yield* call("dashboard_set", { slot: "waiting", old_text: "", new_text: "PR 12 waits on CI" });
    const stale = yield* call("dashboard_set", {
      slot: "waiting",
      old_text: "Merged yesterday",
      new_text: "Nothing",
    });
    expect(stale.isError).toBe(true);
    expect(errorText(stale)).toContain(
      JSON.stringify(
        "Refused: old_text does not match the current waiting text (18% alike, at least 70% needed). Current text:\nPR 12 waits on CI",
      ).slice(1, -1),
    );
    const edited = yield* call("dashboard_set", {
      slot: "waiting",
      old_text: "PR 12 waits on the CI",
      new_text: "PR 12 is green",
    });
    expect(edited.isError).not.toBe(true);
    const empty = yield* call("dashboard_set", { slot: "merged", old_text: "PR 1", new_text: "x" });
    expect(errorText(empty)).toContain(JSON.stringify("Current text:\n(empty)").slice(1, -1));
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["dashboard_set", "dashboard_get"] as const)(
  "refuses %s in a thread whose Dashboard is off",
  (name) =>
    Effect.gen(function* () {
      const args =
        name === "dashboard_set" ? { slot: "working", old_text: "", new_text: "Hi" } : {};
      const result = yield* call(name, args, dashboardOffThread);
      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain(
        "This thread's Dashboard is off. The user can turn it on with Enable Dashboard in the thread menu.",
      );
    }).pipe(Effect.provide(layer)),
);
