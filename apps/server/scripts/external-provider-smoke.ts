#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
/**
 * E2E smoke for the external-agent adapters against the real CLIs.
 *
 * Usage:
 *   node apps/server/scripts/external-provider-smoke.ts devin [binaryPath]
 *   node apps/server/scripts/external-provider-smoke.ts muse  [binaryPath]
 *
 * Each run spawns the provider through its adapter path (devin -> ACP,
 * muse -> MSP), starts a session in a scratch directory, switches model
 * in-session (devin exercises the set_config_option fallback), sends one
 * trivial turn, prints every canonical runtime event, then stops cleanly.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { layerTest as serverConfigLayerTest } from "../src/config.ts";
import { makeExternalAcpAdapter } from "../src/provider/Layers/ExternalAcpAdapter.ts";
import { makeExternalMspAdapter } from "../src/provider/Layers/ExternalMspAdapter.ts";
import type { EventNdjsonLogger } from "../src/provider/Layers/EventNdjsonLogger.ts";
import { buildDevinAcpSpawnInput } from "../src/provider/acp/DevinAcpSupport.ts";
import { buildMuseMspSpawnInput } from "../src/provider/msp/MuseMspSupport.ts";

const providerArg = process.argv[2];
const binaryArg = process.argv[3];

const DEFAULT_BINARIES: Record<"devin" | "muse", string> = {
  devin: `${NodeOS.homedir()}/.local/bin/devin`,
  muse: `${NodeOS.homedir()}/.local/bin/muse`,
};
const DEFAULT_MODELS: Record<"devin" | "muse", string> = {
  devin: "swe-2-high",
  muse: "muse-spark-1.3-contributor",
};

if (providerArg !== "devin" && providerArg !== "muse") {
  process.stderr.write(`usage: external-provider-smoke.ts <devin|muse> [binaryPath]\n`);
  process.exit(2);
}
const binaryPath = binaryArg ?? DEFAULT_BINARIES[providerArg];
const model = DEFAULT_MODELS[providerArg];
const provider = ProviderDriverKind.make(providerArg);
const instanceId = ProviderInstanceId.make(providerArg);
const threadId = ThreadId.make(`smoke-${providerArg}`);
const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `t3-${providerArg}-smoke-`));

const layer = serverConfigLayerTest(cwd, { prefix: "t3-smoke-config-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const inspect = (value: unknown) => NodeUtil.inspect(value, { depth: 3, breakLength: 200 });
const nativeLogPath = NodePath.join(cwd, "native-events.log");
const nativeEventLogger: EventNdjsonLogger = {
  filePath: nativeLogPath,
  write: (event, threadId) =>
    Effect.sync(() => NodeFS.appendFileSync(nativeLogPath, `${inspect({ threadId, event })}\n`)),
  close: () => Effect.void,
};
const log = (message: string, data?: unknown) =>
  Effect.sync(() =>
    process.stdout.write(`${message}${data !== undefined ? ` ${inspect(data)}` : ""}\n`),
  );

const program = Effect.gen(function* () {
  const adapter =
    providerArg === "devin"
      ? yield* makeExternalAcpAdapter({
          provider,
          instanceId,
          authMethodId: "devin-browser",
          defaultModel: model,
          nativeEventLogger,
          spawn: (cwd) => buildDevinAcpSpawnInput({ binaryPath }, cwd),
        })
      : yield* makeExternalMspAdapter({
          provider,
          instanceId,
          defaultModel: model,
          nativeEventLogger,
          spawn: (cwd) => buildMuseMspSpawnInput({ binaryPath }, cwd),
        });

  const events: Array<ProviderRuntimeEvent> = [];
  const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
    Effect.sync(() => {
      events.push(event);
      process.stdout.write(`[event] ${event.type} ${inspect(event.payload ?? {})}\n`);
    }),
  ).pipe(Effect.forkChild);

  yield* log(`[smoke] startSession provider=${providerArg} binary=${binaryPath} cwd=${cwd}`);
  const session = yield* adapter.startSession({
    threadId,
    provider,
    providerInstanceId: instanceId,
    cwd,
    runtimeMode: "full-access",
    title: `smoke ${providerArg}`,
  });
  yield* log(`[smoke] session started`, { status: session.status, model: session.model });

  yield* log(`[smoke] sendTurn model=${model}`);
  const turn = yield* adapter
    .sendTurn({
      threadId,
      input: "Reply with exactly the single word: ok",
      modelSelection: { instanceId, model },
    })
    .pipe(Effect.timeout("240 seconds"));
  yield* log(`[smoke] turn finished`, { turnId: turn.turnId });

  const snapshot = yield* adapter.readThread(threadId);
  yield* log(`[smoke] thread turns=${snapshot.turns.length}`);
  yield* adapter.stopSession(threadId);
  yield* Fiber.interrupt(eventFiber);

  const counts = new Map<string, number>();
  for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  yield* log(`[smoke] event counts`, Object.fromEntries(counts));
  const sawTurnComplete = events.some((event) => event.type === "turn.completed");
  yield* log(sawTurnComplete ? "[smoke] PASS" : "[smoke] FAIL: no turn.completed event");
  if (!sawTurnComplete) return yield* Effect.die("missing turn.completed");
});

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(layer)));
