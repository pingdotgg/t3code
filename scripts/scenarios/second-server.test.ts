// @effect-diagnostics nodeBuiltinImport:off - runs a failing server fixture in an isolated directory.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";

const fixture = await vi.hoisted(async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  return {
    root: await fs.mkdtemp(path.join(os.tmpdir(), "second-server-exit-")),
    exited: Promise.withResolvers<number>(),
  };
});

vi.mock("../e2e.config.ts", () => ({
  APP_DIR: fixture.root,
  T3_HOME: NodePath.join(fixture.root, "home"),
}));

vi.mock("./start-app.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./start-app.ts")>();
  return {
    ...actual,
    start: (input: Parameters<typeof actual.start>[0]) =>
      actual
        .start(input)
        .pipe(
          Effect.tap((child) =>
            child.exitCode.pipe(
              Effect.tap((code) => Effect.sync(() => fixture.exited.resolve(Number(code)))),
            ),
          ),
        ),
  };
});

import { startSecondServer } from "./second-server.ts";

it("rejects readiness when the second server exits before printing a token", async () => {
  await NodeFSP.mkdir(NodePath.join(fixture.root, "apps/server/src"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(fixture.root, "apps/server/src/bin.ts"),
    "process.exit(1);\n",
  );
  const server = startSecondServer("http://127.0.0.1:5733");
  let readiness = "pending";
  const settled = server.ready.then(
    () => {
      readiness = "ready";
    },
    () => {
      readiness = "failed";
    },
  );
  try {
    expect(await fixture.exited.promise).toBe(1);
    vi.useFakeTimers();
    await vi.runAllTimersAsync();
    expect(readiness, "expect startup failure to reject readiness after the server exits").toBe(
      "failed",
    );
  } finally {
    vi.useRealTimers();
    await server.stop();
    await settled;
    await NodeFSP.rm(fixture.root, { recursive: true, force: true });
  }
});
