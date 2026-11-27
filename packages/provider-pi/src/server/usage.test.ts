import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect } from "vite-plus/test";

import { piUsageReader } from "./usage.ts";

describe("piUsageReader CLIProxyAPI discovery", () => {
  it.effect("claims moved Pi sessions but not a moved Grok home's logs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-cliproxy-" });
      const write = (file: string) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* fs.writeFileString(file, "{}\n");
        });
      const piSessions = path.join(home, ".cli-proxy-api", "pi", "sessions");
      yield* write(path.join(piSessions, "--workspace--", "0001_abc.jsonl"));
      const grokSession = path.join(home, ".cli-proxy-api", "grok", "sessions", "%2Fwork", "s1");
      yield* write(path.join(grokSession, "updates.jsonl"));
      yield* write(path.join(grokSession, "chat_history.jsonl"));
      yield* write(path.join(grokSession, "events.jsonl"));

      if (piUsageReader.kind !== "transcripts") throw new Error("Expected a transcript reader");
      const directories = yield* piUsageReader
        .directories(
          {
            instanceId: ProviderInstanceId.make("pi"),
            configured: false,
            config: undefined,
            environment: {},
          },
          { awaitRefresh: false },
        )
        .pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.Environment, {}),
        );

      expect(directories).toEqual([
        { dir: path.join(home, ".pi", "agent", "sessions") },
        { dir: piSessions },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
