import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  DEFAULT_DEV_STATE_DIR,
  createDevRunnerEnv,
  findFirstAvailableOffset,
  resolveModePortOffsets,
} from "./dev-runner.ts";

it.layer(NodeServices.layer)("dev-runner", (it) => {
  it.effect("defaults state dir to ~/.t3/dev when not provided", () =>
    Effect.gen(function* () {
      const env = yield* createDevRunnerEnv({
        mode: "dev",
        env: {},
        offset: 0,
        envOverrides: {},
      });
      const defaultStateDir = yield* DEFAULT_DEV_STATE_DIR;

      assert.equal(env.T3CODE_STATE_DIR, defaultStateDir);
    }),
  );

  it.effect("uses existing env state dir when --state-dir is not provided", () =>
    Effect.gen(function* () {
      const env = yield* createDevRunnerEnv({
        mode: "dev:server",
        env: { T3CODE_STATE_DIR: "/tmp/existing-state" },
        offset: 0,
        envOverrides: {},
      });

      assert.equal(env.T3CODE_STATE_DIR, "/tmp/existing-state");
    }),
  );

  it.effect("lets --state-dir override existing env state dir", () =>
    Effect.gen(function* () {
      const env = yield* createDevRunnerEnv({
        mode: "dev:server",
        env: { T3CODE_STATE_DIR: "/tmp/existing-state" },
        offset: 0,
        envOverrides: { T3CODE_STATE_DIR: "/tmp/override-state" },
      });

      assert.equal(env.T3CODE_STATE_DIR, "/tmp/override-state");
    }),
  );

  it.effect("treats whitespace-only --state-dir as missing and falls back to env/default", () =>
    Effect.gen(function* () {
      const env = yield* createDevRunnerEnv({
        mode: "dev:server",
        env: { T3CODE_STATE_DIR: "/tmp/existing-state" },
        offset: 0,
        envOverrides: { T3CODE_STATE_DIR: "   " },
      });

      assert.equal(env.T3CODE_STATE_DIR, "/tmp/existing-state");
    }),
  );

  it.effect("recomputes websocket url when port is overridden", () =>
    Effect.gen(function* () {
      const env = yield* createDevRunnerEnv({
        mode: "dev",
        env: {},
        offset: 0,
        envOverrides: { T3CODE_PORT: "4222" },
      });

      assert.equal(env.T3CODE_PORT, "4222");
      assert.equal(env.VITE_WS_URL, "ws://localhost:4222");
    }),
  );

  it.effect("keeps explicitly forwarded web-mode flags", () =>
    Effect.gen(function* () {
      const env = yield* createDevRunnerEnv({
        mode: "dev",
        env: {
          T3CODE_AUTH_TOKEN: "desktop-token",
        },
        offset: 0,
        envOverrides: {
          T3CODE_NO_BROWSER: "1",
          T3CODE_AUTH_TOKEN: "cli-token",
        },
      });

      assert.equal(env.T3CODE_NO_BROWSER, "1");
      assert.equal(env.T3CODE_AUTH_TOKEN, "cli-token");
    }),
  );

  it.effect("fails fast for invalid port overrides", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        createDevRunnerEnv({
          mode: "dev",
          env: {},
          offset: 0,
          envOverrides: { T3CODE_PORT: "not-a-port" },
        }),
      );

      assert.ok(error.message.includes("Invalid T3CODE_PORT override"));
    }),
  );
});

it.layer(NodeServices.layer)("findFirstAvailableOffset", (it) => {
  it.effect("returns the starting offset when required ports are available", () =>
    Effect.gen(function* () {
      const offset = yield* findFirstAvailableOffset({
        startOffset: 0,
        requireServerPort: true,
        requireWebPort: true,
        checkPortAvailability: () => Effect.succeed(true),
      });

      assert.equal(offset, 0);
    }),
  );

  it.effect("advances until all required ports are available", () =>
    Effect.gen(function* () {
      const taken = new Set([3773, 5733, 3774, 5734]);
      const offset = yield* findFirstAvailableOffset({
        startOffset: 0,
        requireServerPort: true,
        requireWebPort: true,
        checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
      });

      assert.equal(offset, 2);
    }),
  );

  it.effect("allows offsets where only non-required ports exceed max", () =>
    Effect.gen(function* () {
      const offset = yield* findFirstAvailableOffset({
        startOffset: 59_803,
        requireServerPort: true,
        requireWebPort: false,
        checkPortAvailability: () => Effect.succeed(true),
      });

      assert.equal(offset, 59_803);
    }),
  );
});

it.layer(NodeServices.layer)("resolveModePortOffsets", (it) => {
  it.effect("uses a shared fallback offset for dev mode", () =>
    Effect.gen(function* () {
      const taken = new Set([3773, 5733]);
      const offsets = yield* resolveModePortOffsets({
        mode: "dev",
        startOffset: 0,
        envOverrides: {},
        checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
      });

      assert.deepStrictEqual(offsets, { serverOffset: 1, webOffset: 1 });
    }),
  );

  it.effect("keeps server offset stable for dev:web and only shifts web offset", () =>
    Effect.gen(function* () {
      const taken = new Set([5733]);
      const offsets = yield* resolveModePortOffsets({
        mode: "dev:web",
        startOffset: 0,
        envOverrides: {},
        checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
      });

      assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 1 });
    }),
  );

  it.effect("shifts only server offset for dev:server", () =>
    Effect.gen(function* () {
      const taken = new Set([3773]);
      const offsets = yield* resolveModePortOffsets({
        mode: "dev:server",
        startOffset: 0,
        envOverrides: {},
        checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
      });

      assert.deepStrictEqual(offsets, { serverOffset: 1, webOffset: 1 });
    }),
  );

  it.effect("respects explicit dev-url override for dev:web", () =>
    Effect.gen(function* () {
      const offsets = yield* resolveModePortOffsets({
        mode: "dev:web",
        startOffset: 0,
        envOverrides: { VITE_DEV_SERVER_URL: "http://localhost:9999" },
        checkPortAvailability: () => Effect.succeed(false),
      });

      assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 0 });
    }),
  );

  it.effect("respects explicit server port override for dev:server", () =>
    Effect.gen(function* () {
      const offsets = yield* resolveModePortOffsets({
        mode: "dev:server",
        startOffset: 0,
        envOverrides: { T3CODE_PORT: "4888" },
        checkPortAvailability: () => Effect.succeed(false),
      });

      assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 0 });
    }),
  );
});
