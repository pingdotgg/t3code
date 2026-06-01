import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProjectConfig } from "./projectConfig.ts";

const decodeProjectConfig = Schema.decodeUnknownEffect(ProjectConfig);

it.effect("decodes project config with browser preview URL and scripts", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectConfig({
      browser: { previewUrl: " http://localhost:5173 " },
      scripts: [
        {
          id: "dev",
          name: "Dev",
          command: "bun dev",
          icon: "play",
          runOnWorktreeCreate: false,
          pinnedToTopBar: true,
        },
      ],
    });

    assert.strictEqual(parsed.browser?.previewUrl, "http://localhost:5173");
    assert.strictEqual(parsed.scripts?.[0]?.id, "dev");
  }),
);

it.effect("decodes project config with only scripts", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectConfig({
      scripts: [
        {
          id: "test",
          name: "Test",
          command: "bun run test",
          icon: "test",
          runOnWorktreeCreate: false,
        },
      ],
    });

    assert.strictEqual(parsed.browser, undefined);
    assert.strictEqual(parsed.scripts?.[0]?.icon, "test");
  }),
);

it.effect("decodes project config with only browser preview URL", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectConfig({
      browser: { previewUrl: ":5173" },
    });

    assert.strictEqual(parsed.browser?.previewUrl, ":5173");
    assert.strictEqual(parsed.scripts, undefined);
  }),
);

it.effect("rejects invalid script icons", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeProjectConfig({
        scripts: [
          {
            id: "deploy",
            name: "Deploy",
            command: "bun deploy",
            icon: "rocket",
            runOnWorktreeCreate: false,
          },
        ],
      }),
    );

    assert.strictEqual(result._tag, "Failure");
  }),
);
