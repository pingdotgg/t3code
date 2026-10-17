import { assert, it } from "@effect/vitest";
import { CivilizationDefaultConfig, ProjectId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as TestClock from "effect/testing/TestClock";

import { makeCivilizationDiagnostics } from "./Diagnostics.ts";

type CapturedLog = {
  readonly message: unknown;
  readonly annotations: Record<string, unknown>;
};

const projectId = ProjectId.make("project:civilization:diagnostics");

const configWithDiagnostics = (diagnostics: "off" | "errors" | "normal") => ({
  config: {
    ...CivilizationDefaultConfig,
    operations: { ...CivilizationDefaultConfig.operations, diagnostics },
  },
});

it.effect(
  "honors diagnostics mode, rate-limits repeats and emits only bounded operational fields",
  () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make(({ fiber, message }) => {
      logs.push({ message, annotations: fiber.getRef(References.CurrentLogAnnotations) });
    });
    let mode: "off" | "errors" | "normal" = "normal";

    return Effect.gen(function* () {
      const diagnostics = yield* makeCivilizationDiagnostics(() =>
        Effect.succeed(configWithDiagnostics(mode)),
      );

      yield* diagnostics.emit({
        projectId,
        event: "civilization.mail.rejected",
        severity: "normal",
        fields: { bytes: 4096, rejectionCode: "recipient_pending", projectRevision: 3 },
      });
      yield* diagnostics.emit({
        projectId,
        event: "civilization.mail.rejected",
        severity: "normal",
        fields: { bytes: 4096, rejectionCode: "recipient_pending", projectRevision: 3 },
      });
      assert.lengthOf(logs, 1);
      assert.equal(logs[0]?.message, "civilization.mail.rejected");
      assert.deepInclude(logs[0]?.annotations, {
        projectId,
        bytes: 4096,
        rejectionCode: "recipient_pending",
        projectRevision: 3,
      });
      assert.notProperty(logs[0]?.annotations ?? {}, "body");
      assert.notProperty(logs[0]?.annotations ?? {}, "prompt");
      assert.notProperty(logs[0]?.annotations ?? {}, "credential");

      yield* TestClock.adjust(Duration.seconds(60));
      yield* diagnostics.emit({
        projectId,
        event: "civilization.mail.rejected",
        severity: "normal",
        fields: { count: 1 },
      });
      assert.lengthOf(logs, 2);
      assert.equal(logs[1]?.annotations.suppressedCount, 1);

      mode = "errors";
      yield* diagnostics.emit({
        projectId,
        event: "civilization.context.bounded",
        severity: "normal",
        fields: { bytes: 16 * 1024 },
      });
      assert.lengthOf(logs, 2);
      yield* diagnostics.emit({
        projectId,
        event: "civilization.storage.unavailable",
        severity: "error",
        fields: { rejectionCode: "storage" },
      });
      assert.lengthOf(logs, 3);

      mode = "off";
      yield* TestClock.adjust(Duration.seconds(60));
      yield* diagnostics.emit({
        projectId,
        event: "civilization.storage.unavailable",
        severity: "error",
        fields: { rejectionCode: "storage" },
      });
      assert.lengthOf(logs, 3);
    }).pipe(
      Effect.provide(
        Layer.merge(TestClock.layer(), Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  },
);
