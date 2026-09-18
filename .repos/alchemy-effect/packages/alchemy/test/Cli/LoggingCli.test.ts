import { LoggingCli, formatPlanLines } from "@/Cli/LoggingCli.ts";
import { Cli } from "@/Report.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import * as Layer from "effect/Layer";
import { describe, expect, it, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import {
  createNode,
  deleteNode,
  planWith,
  replaceNode,
  updateNode,
} from "./PlanTestNodes.ts";

describe("formatPlanLines", () => {
  test("keeps compact output unchanged by default", () => {
    expect(
      formatPlanLines(
        planWith([
          updateNode({ value: "old" }, { value: "new" }, "First"),
          replaceNode({ engine: "v1" }, { engine: "v2" }, "Second"),
        ]),
      ),
    ).toEqual([
      "Plan: 1 to update, 1 to replace",
      "[First] update",
      "[Second] replace",
    ]);
  });

  test("renders detailed creates and updates as YAML", () => {
    const output = formatPlanLines(
      planWith([
        createNode({ region: "iad", ports: [80, 443] }, "Api"),
        updateNode({ retries: 2 }, { retries: 3 }, "Worker"),
      ]),
      { detailed: true },
    ).join("\n");
    expect(output).toContain("  properties:\n    ports:\n      - 80");
    expect(output).toContain("  properties:\n  -   retries: 2");
    expect(output).toContain("  +   retries: 3");
  });

  test("keeps deletes compact and reports non-property replacements", () => {
    const output = formatPlanLines(
      planWith(
        [replaceNode({ name: "same" }, { name: "same" })],
        [deleteNode({ secret: "old" }, "OldWorker")],
      ),
      { detailed: true },
    ).join("\n");
    expect(output).toContain("no declared property changes");
    expect(output).not.toContain("secret:");
  });
});

it.effect("emits plain progress through the Effect logger", () => {
  const messages: unknown[] = [];
  const logger = Logger.make<unknown, void>((options) => {
    messages.push(options.message);
  });
  return Effect.gen(function* () {
    const cli = yield* Cli;

    yield* cli.displayPlan(planWith([createNode({}, "Worker")]));

    expect(messages).toEqual([["Plan: 1 to create"], ["[Worker] create"]]);
  }).pipe(
    Effect.provide(Layer.provide(LoggingCli, PlatformServices)),
    Effect.provide(Logger.layer([logger])),
  );
});

it.effect("prints dev stack outputs with the plain apply renderer", () => {
  const messages: unknown[] = [];
  return Effect.gen(function* () {
    const cli = yield* Cli;
    const session = yield* cli.startApplySession(planWith([]), { dev: true });
    expect(session.setOutput).toBeDefined();
    yield* session.setOutput!({ api: "http://localhost:1337/" });
    expect(messages).toContainEqual(["{ api: 'http://localhost:1337/' }"]);
  }).pipe(
    Effect.provide(Layer.provide(LoggingCli, PlatformServices)),
    Effect.provide(
      Logger.layer([
        Logger.make<unknown, void>((options) => {
          messages.push(options.message);
        }),
      ]),
    ),
  );
});

it.effect("streams apply notes as they arrive", () => {
  const messages: string[] = [];
  const logger = Logger.make<unknown, void>((options) => {
    messages.push(String((options.message as unknown[])[0]));
  });
  return Effect.gen(function* () {
    const cli = yield* Cli;
    const session = yield* cli.startApplySession(
      planWith([updateNode({ v: 1 }, { v: 2 }, "Website")]),
    );

    const note = (message: string, kind?: "status" | "output") =>
      session.emit({
        _tag: "apply.resource.note",
        fqn: "Website",
        id: "Website",
        message,
        kind,
      });
    const status = (status: "updating" | "updated") =>
      session.emit({
        _tag: "apply.resource.status",
        fqn: "Website",
        id: "Website",
        type: "Cloudflare::Worker",
        status,
      });

    yield* status("updating");
    yield* note("Uploading worker (1.2 MB) ...", "status");
    yield* note("build output line", "output");
    yield* note("Uploaded 0 of 5195 assets...");
    yield* note("Uploaded 490 of 5195 assets...");
    // spinner-style refresh of the same message is deduped
    yield* note("Uploaded 490 of 5195 assets...");
    yield* note("Reconciling custom domains (1) ...", "status");
    yield* status("updated");

    const progress = messages.slice(3); // skip plan preview + blank line
    expect(progress).toEqual([
      "[Website] updating",
      "[Website] build output line",
      "[Website] Uploaded 0 of 5195 assets...",
      "[Website] Uploaded 490 of 5195 assets...",
      "[Website] updated — Reconciling custom domains (1) ... (0ms)",
    ]);
  }).pipe(
    Effect.provide(Layer.provide(LoggingCli, PlatformServices)),
    Effect.provide(Logger.layer([logger])),
  );
});
