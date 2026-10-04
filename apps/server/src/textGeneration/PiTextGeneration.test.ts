import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { PiSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import * as PiRpc from "../orchestration-v2/Adapters/PiRpc.ts";
import { makePiTextGeneration } from "./PiTextGeneration.ts";

const decodePiSettings = Schema.decodeEffect(PiSettings);

it.effect("generates work-item matches through Pi with tools disabled", () =>
  Effect.gen(function* () {
    const launches: PiRpc.PiRpcSpawnOptions[] = [];
    const requests: PiRpc.PiRpcRecord[] = [];
    const connect = vi.spyOn(PiRpc, "makePiRpcConnection").mockImplementation((launch) =>
      Effect.gen(function* () {
        launches.push(launch);
        const events = yield* Queue.unbounded<PiRpc.PiRpcRecord, PiRpc.PiRpcError>();
        return {
          events,
          request: (record) =>
            Effect.gen(function* () {
              requests.push(record);
              if (record.type === "prompt") yield* Queue.offer(events, { type: "agent_settled" });
              return {
                text: '{"matches":[{"candidate":1,"confidence":"high","reason":"Same issue"}]}',
              };
            }),
          send: () => Effect.void,
          exited: Effect.never,
          terminate: Effect.void,
        };
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => connect.mockRestore()));
    const text = yield* makePiTextGeneration(yield* decodePiSettings({}));
    const source = {
      kind: "issue" as const,
      provider: "github",
      repository: "t3tools/t3code",
      number: 7,
      title: "Fix the issue",
      url: "https://github.com/t3tools/t3code/issues/7",
      body: "The app fails to open.",
    };
    const modelSelection = { instanceId: ProviderInstanceId.make("pi"), model: "openai/test" };
    expect(
      yield* text.findWorkItemMatches({
        cwd: "/workspace",
        relationship: "related",
        source,
        candidates: [{ ...source, number: 8 }],
        modelSelection,
      }),
    ).toEqual({ matches: [{ candidate: 1, confidence: "high", reason: "Same issue" }] });
    expect(launches).toHaveLength(1);
    for (const launch of launches) {
      expect(launch.args).toEqual(
        expect.arrayContaining(["--no-session", "--no-extensions", "--no-tools"]),
      );
    }
    expect(requests.filter((request) => request.type === "set_model")).toEqual([
      { type: "set_model", provider: "openai", modelId: "test" },
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
