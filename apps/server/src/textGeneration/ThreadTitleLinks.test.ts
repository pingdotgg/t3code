import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import { SourceControlProviderError } from "@t3tools/contracts";
import { resolveThreadTitleLinks } from "./ThreadTitleLinks.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";

const registry = Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry);
const encodeSubject = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ title: Schema.String, body: Schema.String })),
);
const success = { title: "Fix QR pairing expiry", body: "Keep remote connections working." };

it.effect(
  "uses provider-selected links, deduplicates anchors, and bounds lookups and summaries",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const result = yield* resolveThreadTitleLinks({
        cwd: "/tmp/project",
        message:
          "https://docs.test/guide [https://forge.test/change/1] https://forge.test/change/1#discussion https://forge.test/change/1?view=full `https://forge.test/change/2` https://forge.test/change/2. https://forge.test/change/3",
      }).pipe(
        Effect.provide(
          registry({
            resolveLink: ({ url, cwd }) =>
              url.host === "forge.test"
                ? Effect.sync(() => {
                    expect(cwd).toBe("/tmp/project");
                    calls.push(url.href);
                    return { title: "t".repeat(400), body: "b".repeat(2_000) };
                  })
                : undefined,
          }),
        ),
      );
      expect(calls).toEqual(["https://forge.test/change/1", "https://forge.test/change/2"]);
      expect(result).toBe(
        calls
          .map(
            (url) =>
              `${url}\n${encodeSubject({ title: "t".repeat(300), body: "b".repeat(1_200) })}`,
          )
          .join("\n\n"),
      );
    }),
);

it.effect("returns unavailable when a lookup times out while retaining successful subjects", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const fiber = yield* resolveThreadTitleLinks({
      cwd: "/tmp/project",
      message: "https://forge.test/change/1 https://forge.test/change/2",
    }).pipe(
      Effect.provide(
        registry({
          resolveLink: ({ url }) =>
            url.pathname.endsWith("1")
              ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.succeed(success),
        }),
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust("3 seconds");
    expect(yield* Fiber.join(fiber)).toBe(
      `https://forge.test/change/1: unavailable\n\nhttps://forge.test/change/2\n${encodeSubject(success)}`,
    );
  }),
);

it.effect("keeps lookup failure out of generation and skips unlinked messages", () =>
  Effect.gen(function* () {
    expect(yield* resolveThreadTitleLinks({ cwd: "/tmp", message: "Fix pairing" })).toBeUndefined();
    expect(
      yield* resolveThreadTitleLinks({ cwd: "/tmp", message: "https://forge.test/change/1" }),
    ).toContain("unavailable");
  }).pipe(
    Effect.provide(
      registry({
        resolveLink: () =>
          Effect.fail(
            new SourceControlProviderError({
              provider: "unknown",
              operation: "resolveLink",
              cwd: "/tmp",
              detail: "Unavailable",
            }),
          ),
      }),
    ),
  ),
);
