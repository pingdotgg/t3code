import * as Command from "@/Command/index.ts";
import * as Provider from "@/Provider.ts";
import * as Test from "@/Test/Alchemy";
import { assert, describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";

const { test } = Test.make({
  // DevServer is provider-agnostic — register it directly without dragging
  // in a cloud provider's auth chain.
  providers: Command.providers(),
  dev: true,
});

const fixtureDir = pathe.resolve(import.meta.dirname, "fixture");
const fixtureScript = pathe.join(fixtureDir, "long-running.cjs");
const urlServerScript = pathe.join(fixtureDir, "url-server.cjs");
const dieScript = pathe.join(fixtureDir, "die.cjs");

// The provider runs `command.split(" ")` and uses `shell: false`, so the
// fixture path must not contain spaces. The in-repo path doesn't, but a CI
// clone under e.g. `C:\Program Files\...` would. Fail loudly with a clear
// message instead of letting the test hang on a misparsed argv.
if (fixtureScript.includes(" ") || urlServerScript.includes(" ")) {
  throw new Error(
    `DevServer test fixture path contains a space, which the provider's ` +
      `argv split cannot represent: ${fixtureScript} / ${urlServerScript}`,
  );
}

const isAlive = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });

const readPidFile = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* fs.readFileString(path);
    return JSON.parse(content) as { pid: number; marker: string };
  });

const waitForPidFile = (path: string, marker: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(path);
    if (!exists) {
      return yield* Effect.fail(new Error("pid file not yet present"));
    }
    const parsed = yield* readPidFile(path);
    if (parsed.marker !== marker) {
      return yield* Effect.fail(
        new Error(`pid file marker ${parsed.marker} !== ${marker}`),
      );
    }
    return parsed;
  }).pipe(
    Effect.retry({
      schedule: Schedule.spaced("100 millis"),
      times: 100,
    }),
  );

const waitForDeath = (pid: number) =>
  isAlive(pid).pipe(
    Effect.flatMap((alive) =>
      alive
        ? Effect.fail(new Error(`pid ${pid} still alive`))
        : Effect.succeed(undefined),
    ),
    Effect.retry({
      schedule: Schedule.spaced("100 millis"),
      times: 50,
    }),
  );

test.provider(
  "list returns [] (non-listable local dev-server process)",
  () =>
    Effect.gen(function* () {
      // DevServer is a local dev-server child process, not a cloud resource —
      // there is no remote enumeration API, so list() is the non-listable
      // pattern and always returns []. No deploy is needed to observe this.
      const provider = yield* Provider.findProvider(Command.Dev);
      const all = yield* provider.list();
      expect(all).toEqual([]);
    }),
  { timeout: 30_000 },
);

test.provider(
  "starts the process",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "devcmd-" });
      const pidFile = pathe.join(tmp, "pid.json");

      yield* stack.deploy(
        Command.Dev("Dev", {
          command: `node ${fixtureScript}`,
          env: { PID_FILE: pidFile, MARKER: "start" },
        }),
      );

      const { pid } = yield* waitForPidFile(pidFile, "start");
      expect(yield* isAlive(pid)).toBe(true);

      yield* stack.destroy();
      yield* waitForDeath(pid);
    }),
  { timeout: 30_000 },
);

test.provider(
  "runs multiple distinct dev servers concurrently",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "devcmd-" });
      const pidFileA = pathe.join(tmp, "pid-a.json");
      const pidFileB = pathe.join(tmp, "pid-b.json");

      yield* stack.deploy(
        Effect.gen(function* () {
          yield* Command.Dev("Alpha", {
            command: `node ${fixtureScript}`,
            env: { PID_FILE: pidFileA, MARKER: "alpha" },
          });
          yield* Command.Dev("Beta", {
            command: `node ${fixtureScript}`,
            env: { PID_FILE: pidFileB, MARKER: "beta" },
          });
        }),
      );

      const alpha = yield* waitForPidFile(pidFileA, "alpha");
      const beta = yield* waitForPidFile(pidFileB, "beta");

      expect(alpha.pid).not.toBe(beta.pid);
      expect(yield* isAlive(alpha.pid)).toBe(true);
      expect(yield* isAlive(beta.pid)).toBe(true);

      yield* stack.destroy();
      yield* waitForDeath(alpha.pid);
      yield* waitForDeath(beta.pid);
    }),
  { timeout: 30_000 },
);

test.provider(
  "keeps the process running across an unchanged update",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "devcmd-" });
      const pidFile = pathe.join(tmp, "pid.json");

      const program = Command.Dev("Dev", {
        command: `node ${fixtureScript}`,
        env: { PID_FILE: pidFile, MARKER: "stable" },
      });

      yield* stack.deploy(program);
      const first = yield* waitForPidFile(pidFile, "stable");

      // Re-deploy the same props. Provider hashes match → keep running.
      yield* stack.deploy(program);
      // Give the provider a moment in case it would (incorrectly) respawn.
      yield* Effect.sleep("500 millis");

      const second = yield* readPidFile(pidFile);
      expect(second.pid).toBe(first.pid);
      expect(second.marker).toBe("stable");
      expect(yield* isAlive(first.pid)).toBe(true);

      yield* stack.destroy();
      yield* waitForDeath(first.pid);
    }),
  { timeout: 30_000 },
);

test.provider(
  "restarts the process when props change",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "devcmd-" });
      const pidFile = pathe.join(tmp, "pid.json");

      yield* stack.deploy(
        Command.Dev("Dev", {
          command: `node ${fixtureScript}`,
          env: { PID_FILE: pidFile, MARKER: "v1" },
        }),
      );
      const first = yield* waitForPidFile(pidFile, "v1");
      expect(yield* isAlive(first.pid)).toBe(true);

      // Change the env (and therefore the hash) — provider should kill the
      // running process and spawn a fresh one with the new marker.
      yield* stack.deploy(
        Command.Dev("Dev", {
          command: `node ${fixtureScript}`,
          env: { PID_FILE: pidFile, MARKER: "v2" },
        }),
      );
      const second = yield* waitForPidFile(pidFile, "v2");

      expect(second.pid).not.toBe(first.pid);
      expect(yield* isAlive(second.pid)).toBe(true);
      yield* waitForDeath(first.pid);

      yield* stack.destroy();
      yield* waitForDeath(second.pid);
    }),
  { timeout: 30_000 },
);

test.provider(
  "extracts the first URL printed to stdout",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "devcmd-" });
      const pidFile = pathe.join(tmp, "pid.json");

      const output = yield* stack.deploy(
        Command.Dev("Dev", {
          command: `node ${urlServerScript}`,
          env: {
            PID_FILE: pidFile,
            MARKER: "url-stdout",
            URL_LINE: "Local: http://localhost:5173/",
          },
        }),
      );

      expect(output.url).toBe("http://localhost:5173/");

      const { pid } = yield* waitForPidFile(pidFile, "url-stdout");
      yield* stack.destroy();
      yield* waitForDeath(pid);
    }),
  { timeout: 30_000 },
);

test.provider(
  "extracts a URL printed to stderr",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "devcmd-" });
      const pidFile = pathe.join(tmp, "pid.json");

      const output = yield* stack.deploy(
        Command.Dev("Dev", {
          command: `node ${urlServerScript}`,
          env: {
            PID_FILE: pidFile,
            MARKER: "url-stderr",
            URL_LINE: "ready - started server on http://127.0.0.1:3000",
            URL_STREAM: "stderr",
          },
        }),
      );

      expect(output.url).toBe("http://127.0.0.1:3000");

      const { pid } = yield* waitForPidFile(pidFile, "url-stderr");
      yield* stack.destroy();
      yield* waitForDeath(pid);
    }),
  { timeout: 30_000 },
);

test.provider(
  "strips ANSI escapes before matching",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "devcmd-" });
      const pidFile = pathe.join(tmp, "pid.json");

      // Vite-style colored output: "  ➜  Local:   http://localhost:5173/"
      // with green + cyan SGR sequences around the URL.
      const ansi = (open: string, body: string) =>
        `\x1b[${open}m${body}\x1b[0m`;
      const line = `  ➜  ${ansi("32", "Local:")}   ${ansi("36", "http://localhost:5173/")}`;

      const output = yield* stack.deploy(
        Command.Dev("Dev", {
          command: `node ${urlServerScript}`,
          env: {
            PID_FILE: pidFile,
            MARKER: "url-ansi",
            URL_LINE: line,
          },
        }),
      );

      expect(output.url).toBe("http://localhost:5173/");

      const { pid } = yield* waitForPidFile(pidFile, "url-ansi");
      yield* stack.destroy();
      yield* waitForDeath(pid);
    }),
  { timeout: 30_000 },
);

test.provider(
  "favors a localhost URL over an unrelated URL printed first (#695)",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "devcmd-" });
      const pidFile = pathe.join(tmp, "pid.json");

      const output = yield* stack.deploy(
        Command.Dev("Dev", {
          command: `node ${urlServerScript}`,
          env: {
            PID_FILE: pidFile,
            MARKER: "url-favor-local",
            // A docs link is printed first (as Astro does on a content
            // error), then the dev server prints its own localhost URL.
            URL_LINE: "https://docs.astro.build/en/guides/content-collections/",
            URL_LINE_2: "  ➜  Local:   http://localhost:5001/",
            URL_DELAY_2_MS: "300",
          },
        }),
      );

      expect(output.url).toBe("http://localhost:5001/");

      const { pid } = yield* waitForPidFile(pidFile, "url-favor-local");
      yield* stack.destroy();
      yield* waitForDeath(pid);
    }),
  { timeout: 30_000 },
);

test.provider(
  "falls back to a non-local URL when no localhost URL appears (#695)",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "devcmd-" });
      const pidFile = pathe.join(tmp, "pid.json");

      const output = yield* stack.deploy(
        Command.Dev("Dev", {
          command: `node ${urlServerScript}`,
          env: {
            PID_FILE: pidFile,
            MARKER: "url-fallback",
            // Only a non-local URL is ever printed — it should still surface.
            URL_LINE: "https://docs.astro.build/en/guides/content-collections/",
          },
        }),
      );

      expect(output.url).toBe(
        "https://docs.astro.build/en/guides/content-collections/",
      );

      const { pid } = yield* waitForPidFile(pidFile, "url-fallback");
      yield* stack.destroy();
      yield* waitForDeath(pid);
    }),
  { timeout: 30_000 },
);

test.provider(
  "returns undefined when no URL is printed within the timeout",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "devcmd-" });
      const pidFile = pathe.join(tmp, "pid.json");

      const output = yield* stack.deploy(
        Command.Dev("Dev", {
          command: `node ${urlServerScript}`,
          env: {
            PID_FILE: pidFile,
            MARKER: "no-url",
            // URL_LINE intentionally unset — process stays silent so
            // reconcile waits the full URL_EXTRACT_TIMEOUT and falls back.
          },
        }),
      );

      expect(output.url).toBeUndefined();

      const { pid } = yield* waitForPidFile(pidFile, "no-url");
      expect(yield* isAlive(pid)).toBe(true);

      yield* stack.destroy();
      yield* waitForDeath(pid);
    }),
  { timeout: 30_000 },
);

test.provider(
  "stops the process on destroy",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "devcmd-" });
      const pidFile = pathe.join(tmp, "pid.json");

      yield* stack.deploy(
        Command.Dev("Dev", {
          command: `node ${fixtureScript}`,
          env: { PID_FILE: pidFile, MARKER: "stop" },
        }),
      );
      const { pid } = yield* waitForPidFile(pidFile, "stop");
      expect(yield* isAlive(pid)).toBe(true);

      yield* stack.destroy();
      yield* waitForDeath(pid);
      expect(yield* isAlive(pid)).toBe(false);
    }),
  { timeout: 30_000 },
);

test.provider("errors when the command fails in first 5 seconds", (stack) =>
  Effect.gen(function* () {
    const error = yield* stack
      .deploy(
        Command.Dev("Dev", {
          command: `node ${dieScript}`,
        }),
      )
      .pipe(Effect.flip);
    assert(Command.isCommandError(error));
    assert(error.reason._tag === "UnexpectedExit");
    expect(error.reason.exitCode).toBe(1);
    expect(error.reason.stderr).toContain("I'm not feeling it...");
  }),
);

describe("extractUrl", () => {
  it("returns a plain URL when it is the only match", () => {
    expect(Command.extractUrl("Local: http://localhost:5173/")).toBe(
      "http://localhost:5173/",
    );
  });

  it("favors a localhost URL over an unrelated URL printed first", () => {
    // Astro prints a docs link on a content error before the dev server
    // prints its own localhost URL. See issue #695.
    const buffer =
      "see https://docs.astro.build/en/guides/content-collections/\n" +
      "  ➜  Local:   http://localhost:5001/\n";
    expect(Command.extractUrl(buffer)).toBe("http://localhost:5001/");
  });

  it("favors an IP URL over an unrelated URL printed first", () => {
    const buffer =
      "update available https://example.com/release\n" +
      "ready - started server on http://127.0.0.1:3000\n";
    expect(Command.extractUrl(buffer)).toBe("http://127.0.0.1:3000");
  });

  it("falls back to a non-local URL when no local URL is present", () => {
    expect(
      Command.extractUrl("docs https://docs.astro.build/en/guides/x/"),
    ).toBe("https://docs.astro.build/en/guides/x/");
  });

  it("strips ANSI escapes before matching", () => {
    expect(Command.extractUrl("\x1b[36mhttp://localhost:5173/\x1b[0m")).toBe(
      "http://localhost:5173/",
    );
  });

  it("returns undefined when there is no URL", () => {
    expect(Command.extractUrl("no url here")).toBeUndefined();
  });
});
