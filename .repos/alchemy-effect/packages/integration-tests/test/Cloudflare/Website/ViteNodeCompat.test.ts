import * as NodeNet from "node:net";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectResponse } from "../Utils/Http.ts";
import { expectWorkerExists, waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

// Node.js compatibility of a `Website.Vite` Worker, mirroring
// `@cloudflare/vite-plugin`'s `node-compat` playground: each variant is the
// playground's Worker (`vite-node-compat-fixture/src/<variant>`) with its
// compatibility settings and bindings, run deployed and under `alchemy dev`
// as the plugin runs each in build and dev mode.

const { test } = Test.make({ providers: Cloudflare.providers() });
const { test: devTest } = Test.make({ providers: Cloudflare.providers(), dev: true });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const fixtureDir = pathe.resolve(import.meta.dirname, "vite-node-compat-fixture");

type Mode = "live" | "dev";

interface Variant {
  name: string;
  date: string;
  flags: Array<string>;
  env?: (mode: Mode, context: { pgPort: number }) => Record<string, unknown>;
  config?: string;
  modes?: ReadonlyArray<Mode>;
  check: (
    url: string,
    mode: Mode,
    /** The site's log since this attempt's deploy. */
    log: Effect.Effect<string>,
  ) => Effect.Effect<void, unknown, FileSystem.FileSystem>;
}

const expectText = (url: string, expected: string) =>
  expectResponse(url, (res) =>
    res.status === 200 && res.body === expected
      ? undefined
      : `${res.status} ${JSON.stringify(res.body.slice(0, 600))}, expected ${JSON.stringify(expected)}`,
  );

const expectJson = (url: string, check: (body: unknown) => void) =>
  expectResponse(url, (res) => {
    if (res.status !== 200) return `status ${res.status} ${res.body.slice(0, 600)}`;
    try {
      check(JSON.parse(res.body));
      return undefined;
    } catch {
      return `json ${res.body.slice(0, 300)}`;
    }
  });

const VARIANTS: ReadonlyArray<Variant> = [
  {
    name: "cloudflare-node",
    date: "2025-11-13",
    flags: ["nodejs_compat"],
    check: (url) => expectText(url, "Hello from an httpServerHandler"),
  },
  {
    name: "als",
    date: "2024-12-30",
    flags: ["nodejs_als"],
    check: (url, mode, log) =>
      Effect.gen(function* () {
        yield* expectText(url, "OK!");
        // It won't log any Node.js compat warnings.
        if (mode === "dev") {
          expect(yield* log).not.toContain("Unexpected Node.js imports");
        }
      }),
  },
  {
    name: "basic",
    date: "2024-12-30",
    flags: ["nodejs_compat"],
    env: () => ({
      MY_DO: Cloudflare.DurableObject("MyDurableObject", { className: "MyDurableObject" }),
      MY_SERVICE: Cloudflare.WorkerEntrypoint("MyWorkerEntrypoint"),
    }),
    check: (url) => expectText(url, `"OK!"`),
  },
  {
    // Third-party packages unenv aliases (`cross-fetch`).
    name: "cross-env",
    date: "2024-12-30",
    flags: ["nodejs_compat"],
    check: (url) => expectText(url, `"OK!"`),
  },
  {
    name: "crypto",
    date: "2024-12-30",
    flags: ["nodejs_compat"],
    check: (url) =>
      expectResponse(url, (res) =>
        res.status === 200 &&
        res.body.startsWith(`"OK!": -----BEGIN CERTIFICATE-----\nMIICZjCCAc+gAwIBAgIUOsv8Y+x40C+g`)
          ? undefined
          : `${res.status} ${res.body.slice(0, 300)}`,
      ),
  },
  {
    name: "debug",
    date: "2025-07-30",
    flags: ["nodejs_compat"],
    env: () => ({ DEBUG: "example:*,test" }),
    check: (url) =>
      expectJson(url, (body) =>
        expect(body).toEqual([
          "test Test import message 1",
          "example:foo Example foo import message",
          "test Test import enabled message",
        ]),
      ),
  },
  {
    name: "https",
    date: "2025-08-15",
    flags: ["nodejs_compat"],
    check: (url) => expectText(url, "OK"),
  },
  {
    // `pg` over `cloudflare:sockets`: deployed, the Worker can't reach the
    // test's local server, so only dev sends a query.
    name: "postgres",
    date: "2024-12-30",
    flags: ["nodejs_compat"],
    env: (_mode, { pgPort }) => ({
      DB_HOSTNAME: "127.0.0.1",
      DB_PORT: String(pgPort),
      DB_NAME: "testdb",
      DB_USERNAME: "testuser",
      DB_PASSWORD: "testpassword",
    }),
    check: (url, mode) =>
      Effect.gen(function* () {
        yield* expectText(url, "127.0.0.1");
        if (mode === "dev") {
          yield* expectJson(`${url}/send-query`, (body) =>
            expect(body).toEqual(expect.objectContaining({ id: "21" })),
          );
        }
      }),
  },
  {
    name: "process",
    date: "2024-12-30",
    flags: ["nodejs_compat", "nodejs_compat_do_not_populate_process_env"],
    env: () => ({ FOO: "foo value" }),
    check: (url) => expectText(url, "OK!"),
  },
  {
    name: "process-populated-env",
    date: "2024-12-30",
    flags: ["nodejs_compat", "nodejs_compat_populate_process_env"],
    env: () => ({ FOO: "foo value", BAR: Redacted.make("bar secret") }),
    check: (url) => expectText(url, "OK!"),
  },
  {
    name: "random",
    date: "2024-12-30",
    flags: ["nodejs_compat"],
    check: (url) =>
      expectJson(url, (body) =>
        expect(body).toEqual([
          expect.any(String),
          expect.any(String),
          expect.any(String),
          expect.any(String),
        ]),
      ),
  },
  {
    // A plugin resolving a Node.js built-in through the Worker environment's
    // plugin container gets its external id (dev only, as the plugin's spec).
    name: "resolve-externals",
    date: "2024-12-30",
    flags: ["nodejs_compat"],
    config: "resolve-externals",
    modes: ["dev"],
    check: (url, _mode, devLog) =>
      Effect.gen(function* () {
        yield* expectText(url, "OK!");
        const log = yield* devLog.pipe(
          Effect.filterOrFail((log) => log.includes("__node:dns__")),
          Effect.retry({ times: 10, schedule: Schedule.spaced("1 second") }),
        );
        expect(log).toContain("__node:dns__");
      }),
  },
];

const id = (variant: Variant, mode: Mode) =>
  `ViteNodeCompat${mode}${variant.name.replace(/(^|-)(\w)/g, (_, _dash, c: string) => c.toUpperCase())}`;

const deployVariant = (stack: Test.ScratchStack, variant: Variant, mode: Mode, pgPort: number) =>
  Effect.gen(function* () {
    const rootDir = yield* cloneFixture(fixtureDir, {
      prefix: `alchemy-vite-node-compat-${variant.name}-`,
      tempRoot,
      entries: ["package.json", "configs", "src"],
    });
    if (variant.config) {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.copyFile(
        pathe.join(rootDir, `configs/${variant.config}.ts`),
        pathe.join(rootDir, "vite.config.ts"),
      );
    }
    return yield* stack.deploy(
      Cloudflare.Website.Vite(id(variant, mode), {
        rootDir,
        main: `./src/${variant.name}/index.ts`,
        workersDev: true,
        compatibility: { date: variant.date, flags: variant.flags },
        memo: { include: ["**/*"] },
        env: variant.env?.(mode, { pgPort }) as never,
        ...(mode === "dev" ? { dev: { port: 0 } } : {}),
      }),
    );
  });

// The playground's mock Postgres server: trusts every login and answers
// every query with one row.
const mockPostgres = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<NodeNet.Server>((resolve) => {
        const server = NodeNet.createServer((socket) => {
          let buffer = Buffer.alloc(0);
          let started = false;
          const message = (type: string, body: Buffer) => {
            const header = Buffer.alloc(5);
            header.write(type, 0);
            header.writeInt32BE(body.length + 4, 1);
            return Buffer.concat([header, body]);
          };
          const int16 = (n: number) => {
            const b = Buffer.alloc(2);
            b.writeInt16BE(n);
            return b;
          };
          const int32 = (n: number) => {
            const b = Buffer.alloc(4);
            b.writeInt32BE(n);
            return b;
          };
          const cstr = (s: string) => Buffer.from(`${s}\0`);
          const ready = message("Z", Buffer.from("I"));
          const row = { id: "21", name: "mock-row" };
          socket.on("data", (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            while (true) {
              if (!started) {
                if (buffer.length < 4) return;
                const length = buffer.readInt32BE(0);
                if (buffer.length < length) return;
                const code = buffer.readInt32BE(4);
                buffer = buffer.subarray(length);
                // SSLRequest: refuse, the client continues in plain text.
                if (code === 80877103) {
                  socket.write("N");
                  continue;
                }
                started = true;
                socket.write(Buffer.concat([message("R", int32(0)), ready]));
                continue;
              }
              if (buffer.length < 5) return;
              const type = String.fromCharCode(buffer[0]!);
              const length = buffer.readInt32BE(1);
              if (buffer.length < length + 1) return;
              buffer = buffer.subarray(length + 1);
              if (type === "X") return void socket.end();
              if (type !== "Q") continue;
              const columns = Object.keys(row);
              const description = Buffer.concat([
                int16(columns.length),
                ...columns.map((name) =>
                  Buffer.concat([
                    cstr(name),
                    int32(0),
                    int16(0),
                    int32(25),
                    int16(-1),
                    int32(-1),
                    int16(0),
                  ]),
                ),
              ]);
              const data = Buffer.concat([
                int16(columns.length),
                ...Object.values(row).map((value) =>
                  Buffer.concat([int32(Buffer.byteLength(value)), Buffer.from(value)]),
                ),
              ]);
              socket.write(
                Buffer.concat([
                  message("T", description),
                  message("D", data),
                  message("C", cstr("SELECT 1")),
                  ready,
                ]),
              );
            }
          });
          socket.on("error", () => {});
        });
        server.listen(0, "127.0.0.1", () => resolve(server));
      }),
  ),
  (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
).pipe(Effect.map((server) => (server.address() as NodeNet.AddressInfo).port));

describe("Website.Vite Node.js compatibility", () => {
  for (const variant of VARIANTS) {
    for (const mode of variant.modes ?? (["live", "dev"] as const)) {
      (mode === "live" ? test : devTest).provider(
        `Vite node-compat: ${variant.name}${mode === "dev" ? " (dev)" : ""}`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const pgPort = yield* mockPostgres;
            const log = yield* Test.captureResourceLog(id(variant, mode));
            const site = yield* deployVariant(stack, variant, mode, pgPort);
            const url = site.url!.replace(/\/$/, "");
            if (mode === "live") {
              const { accountId } = yield* yield* CloudflareEnvironment;
              yield* expectWorkerExists(site.workerName, accountId);
              yield* variant.check(url, mode, log);
              yield* stack.destroy();
              yield* waitForWorkerToBeDeleted(site.workerName, accountId);
            } else {
              yield* variant.check(url, mode, log);
            }
          }).pipe(Effect.scoped, Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
        {
          tags: ["provider:cloudflare:worker", mode === "dev" ? "local" : "live"],
          timeout: 300_000,
        },
      );
    }
  }
});
