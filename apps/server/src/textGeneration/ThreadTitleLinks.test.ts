import { SourceControlProviderKind } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import { SourceControlProviderError } from "@t3tools/contracts";
import { resolveThreadTitleLinks } from "./ThreadTitleLinks.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";

const layerRegistry = Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry);
const encodeSubject = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ title: Schema.String, body: Schema.String })),
);

it.effect(
  "uses provider-selected links, deduplicates anchors, and bounds lookups and summaries",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const result = yield* resolveThreadTitleLinks({
        cwd: "/tmp/project",
        message:
          "https://docs.test/guide **https://forge.test/change/1**: [https://forge.test/change/1] https://forge.test/change/1#discussion https://forge.test/change/1?view=full `https://forge.test/change/2` https://forge.test/change/2. https://forge.test/change/3",
      }).pipe(
        Effect.provide(
          layerRegistry({
            resolveLink: ({ url, cwd }) =>
              url.host === "forge.test"
                ? Effect.sync(() => {
                    expect(cwd).toBe("/tmp/project");
                    calls.push(url.href);
                    // Change 1 puts an emoji across each limit; change 2 ends one inside it.
                    const pad = url.pathname.endsWith("/1") ? 0 : 1;
                    return {
                      title: `${"t".repeat(299 - pad)}🚀${"t".repeat(100)}`,
                      body: `${"b".repeat(1_199 - pad)}🚀${"b".repeat(800)}`,
                    };
                  })
                : undefined,
          }),
        ),
      );
      expect(calls).toEqual(["https://forge.test/change/1", "https://forge.test/change/2"]);
      expect(result).toBe(
        [
          `${calls[0]}\n${encodeSubject({ title: "t".repeat(299), body: "b".repeat(1_199) })}`,
          `${calls[1]}\n${encodeSubject({ title: `${"t".repeat(298)}🚀`, body: `${"b".repeat(1_198)}🚀` })}`,
        ].join("\n\n"),
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
      layerRegistry({
        resolveLink: () =>
          Effect.fail(
            new SourceControlProviderError({
              provider: SourceControlProviderKind.make("unknown"),
              operation: "resolveLink",
              cwd: "/tmp",
              detail: "Unavailable",
            }),
          ),
      }),
    ),
  ),
);
