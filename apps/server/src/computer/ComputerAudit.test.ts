import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ComputerApprovalBinding } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ComputerAudit from "./ComputerAudit.ts";

const binding = (text: string): ComputerApprovalBinding => ({
  hostId: "mac_1",
  taskId: "cu_1",
  step: 3,
  app: "Messages",
  title: "Dana",
  url: "https://example.com/messages",
  action: { kind: "type", ref: "r7", role: "textbox", label: "Message", text },
  why: "typing into a field that is not a search or address box",
  goal: "reply to Dana",
  requester: "agent: opencode",
});

const makeAudit = () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-computer-audit-" });
    return yield* ComputerAudit.make(paths.join(directory, "computer", "audit.jsonl"));
  });

it.effect("records one JSON object a line and tails the newest, oldest first", () =>
  Effect.gen(function* () {
    const audit = yield* makeAudit();
    yield* audit.record("task.start", { taskId: "task-1", step: 1 });
    yield* audit.record("grant", { taskId: "task-1", step: 1, judged: false });
    yield* audit.record("task.end", { taskId: "task-1", status: "done" });

    const lines = yield* audit.tail(2);
    assert.deepStrictEqual(
      lines.map((line) => line.event),
      ["grant", "task.end"],
    );
    assert.strictEqual(lines[1]?.taskId, "task-1");
    assert.strictEqual(typeof lines[1]?.ts, "number");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a skipped approval carries an approval's action fields and never the typed text", () =>
  Effect.gen(function* () {
    const audit = yield* makeAudit();
    const approved = binding("on my way to the bank");
    yield* audit.record(
      ComputerAudit.APPROVAL_REQUEST_AUDIT_EVENT,
      ComputerAudit.approvalAuditFields(approved),
    );
    yield* audit.record(
      ComputerAudit.APPROVAL_SKIPPED_AUDIT_EVENT,
      ComputerAudit.approvalAuditFields(approved),
    );

    const [requested, skipped] = yield* audit.tail(2);
    assert.strictEqual(skipped?.event, "approval_skipped");
    assert.strictEqual(skipped?.taskId, "cu_1");
    assert.strictEqual(skipped?.step, 3);
    assert.deepStrictEqual(skipped?.action, requested?.action);

    const action = skipped!.action as {
      readonly text?: { readonly len?: number; readonly sha256?: string };
    };
    const pinned = { len: 21, sha256: "5bb2379cfbf5" };
    assert.deepStrictEqual(ComputerAudit.textDigest("on my way to the bank"), pinned);
    assert.deepStrictEqual(action.text, pinned);

    const line = JSON.stringify(skipped);
    assert.notInclude(line, "on my way");
    assert.notInclude(line, "bank");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("clip keeps whole characters inside 80 bytes", () => {
  assert.strictEqual(ComputerAudit.clip("short"), "short");
  const long = `${"é".repeat(50)}tail`;
  const clipped = ComputerAudit.clip(long);
  assert.isAtMost(new TextEncoder().encode(clipped).byteLength, 80);
  assert.isTrue(long.startsWith(clipped));
  assert.notInclude(clipped, "�");
});

it.effect("rotates past 8 MiB, keeping its newest half by whole lines", () =>
  Effect.gen(function* () {
    const audit = yield* makeAudit();
    // Equal-length lines: the ninth takes the file past 8 MiB, so the tenth rotates it.
    for (let index = 1; index <= 9; index += 1)
      yield* audit.record(`step-0${index}`, { held: "x".repeat(1_000_000) });
    yield* audit.record("step-10");

    const events = (yield* audit.tail(100)).map((line) => line.event);
    assert.deepStrictEqual(events, ["step-06", "step-07", "step-08", "step-09", "step-10"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("loses a line rather than failing when it cannot write", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-computer-audit-" });
    const blocker = paths.join(directory, "not-a-directory");
    yield* fileSystem.writeFileString(blocker, "");
    const audit = yield* ComputerAudit.make(paths.join(blocker, "audit.jsonl"));

    yield* audit.record("task.start", { taskId: "task-1" });
    assert.deepStrictEqual(yield* audit.tail(10), []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("writes under the environment's userdata directory", () =>
  Effect.gen(function* () {
    const audit = yield* ComputerAudit.ComputerAudit;
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;

    yield* audit.record("task.start", { taskId: "task-1" });
    assert.isTrue(yield* fileSystem.exists(paths.join(config.stateDir, "computer", "audit.jsonl")));
  }).pipe(
    Effect.provide(
      ComputerAudit.layer.pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-computer-audit-path-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
