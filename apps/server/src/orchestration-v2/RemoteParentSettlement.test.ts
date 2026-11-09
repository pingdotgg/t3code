import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as McpGatewayBrokerModule from "../mcp/McpGatewayBroker.ts";
import { McpGatewayBroker } from "../mcp/McpGatewayBroker.ts";
import { manualSettledAt } from "./RemoteParentSettlement.ts";

const pc = EnvironmentId.make("environment-pc");
const laptop = EnvironmentId.make("environment-laptop");
const settledAt = "2026-10-22T09:00:00.000Z";

const thread = (id: string, fields: Record<string, unknown>) => ({
  id,
  projectId: "project",
  title: id,
  modelSelection: { instanceId: "codex", model: "gpt-5.1-codex" },
  runs: [],
  messages: [],
  ...fields,
});

/** Threads as each machine's relaying app reports them from getThread. */
const threads: Record<string, Record<string, unknown>> = Object.fromEntries(
  Object.entries({
    [`${pc}:manual-card`]: { settledAt, settlementSource: "manual", parentThreadId: null },
    // Aged out under a card settled by hand on yet another machine.
    [`${pc}:aged-child`]: {
      settledAt: "2026-10-21T00:00:00.000Z",
      settlementSource: "inactivity",
      parentThreadId: "laptop-card",
      parentEnvironmentId: laptop,
    },
    [`${laptop}:laptop-card`]: { settledAt, settlementSource: "manual", parentThreadId: null },
    [`${pc}:aged-card`]: { settledAt, settlementSource: "inactivity", parentThreadId: null },
    [`${pc}:active-card`]: { settledAt: null, parentThreadId: null },
    // An environment or app from before settlementSource was reported.
    [`${pc}:old-card`]: { settledAt, parentThreadId: null },
  }).map(([key, fields]) => [key, thread(key.split(":").at(-1)!, fields)]),
);

const layer = Layer.effect(
  McpGatewayBroker,
  Effect.gen(function* () {
    const broker = yield* McpGatewayBrokerModule.make;
    yield* broker.connect("desktop", { [pc]: ["read"], [laptop]: ["read"] }).pipe(
      Stream.runForEach((event) =>
        broker.respond("desktop", {
          connectionId: event.connectionId,
          invocationId: event.invocationId,
          result: threads[`${String(event.args[0])}:${String(event.args[1])}`] ?? null,
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    return broker;
  }),
).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

it.effect("reads how a parent on another machine settled, past ancestors that aged out", () =>
  Effect.gen(function* () {
    const read = (environmentId: EnvironmentId, threadId: string) =>
      manualSettledAt(environmentId, ThreadId.make(threadId)).pipe(
        Effect.map((at) => (at === null ? null : DateTime.formatIso(at))),
      );
    expect(yield* read(pc, "manual-card")).toBe(settledAt);
    expect(yield* read(pc, "aged-child")).toBe(settledAt);
    expect(yield* read(pc, "aged-card")).toBeNull();
    expect(yield* read(pc, "active-card")).toBeNull();
    expect(yield* read(pc, "old-card")).toBeNull();
    // No connected app grants this machine.
    expect(yield* read(EnvironmentId.make("environment-unknown"), "manual-card")).toBeNull();
  }).pipe(Effect.provide(layer)),
);
