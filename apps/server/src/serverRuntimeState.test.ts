import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  clearPersistedServerRuntimeState,
  persistServerRuntimeState,
  readPersistedServerRuntimeState,
} from "./serverRuntimeState.ts";

it("only clears persisted runtime state owned by the expected pid", async () => {
  const root = await mkdtemp(join(process.cwd(), ".server-runtime-state-"));
  const path = join(root, "server-runtime.json");
  try {
    await Effect.runPromise(
      persistServerRuntimeState({
        path,
        state: {
          version: 1,
          pid: process.pid,
          host: "127.0.0.1",
          port: 3773,
          origin: "http://127.0.0.1:3773",
          startedAt: new Date(0).toISOString(),
        },
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    assert.isFalse(
      await Effect.runPromise(
        clearPersistedServerRuntimeState(path, process.pid + 1).pipe(
          Effect.provide(NodeServices.layer),
        ),
      ),
    );
    const preserved = await Effect.runPromise(
      readPersistedServerRuntimeState(path).pipe(Effect.provide(NodeServices.layer)),
    );
    assert.equal(Option.getOrThrow(preserved).pid, process.pid);

    assert.isTrue(
      await Effect.runPromise(
        clearPersistedServerRuntimeState(path, process.pid).pipe(
          Effect.provide(NodeServices.layer),
        ),
      ),
    );
    assert.isTrue(
      Option.isNone(
        await Effect.runPromise(
          readPersistedServerRuntimeState(path).pipe(Effect.provide(NodeServices.layer)),
        ),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
