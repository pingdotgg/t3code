#!/usr/bin/env node

import { Framework } from "@alchemy.run/frontend-frameworks/core";
import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import * as Options from "./Options.ts";
import * as Runtime from "./Runtime.ts";
import * as Server from "./Server.ts";

const build = Command.make(
  "build",
  {},
  Effect.fn(function* () {
    // Build, then persist the BuildOutput to dist/build.json (the harness's
    // E2E persistence mechanism — `e2e preview` serves from it).
    yield* Server.buildAndPersist;
  }),
);

const dev = Command.make(
  "dev",
  {
    port: Flag.integer("port").pipe(Flag.optional),
  },
  Effect.fn(function* ({ port }) {
    const framework = yield* Framework;
    // Thread the fixture's project root (Options.root) into Framework.dev,
    // mirroring what Server/buildAndPersist do for `live`/`build`.
    const root = yield* Options.load().pipe(
      Effect.flatMap(Options.resolveRoot),
    );
    const { url } = yield* framework.dev({ port: port.valueOrUndefined, root });
    yield* Effect.log(`Dev server running at ${url}`);
    yield* Effect.never;
  }),
);

const preview = Command.make(
  "preview",
  {},
  Effect.fn(function* () {
    const server = yield* Server.Server;
    const instance = yield* server.live();
    yield* Effect.log("Previewing on", instance.url.toString());
    yield* Effect.never;
  }),
);

Command.make("e2e").pipe(
  Command.withSubcommands([build, dev, preview]),
  Command.run({ version: "0.0.0" }),
  Effect.provide(Runtime.layer),
  Runtime.runMain,
);
