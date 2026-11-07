import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { MuseSettings } from "../settings.ts";
import { refreshMuseUsage as refreshState, type MuseUsageReport } from "./usageProbe.ts";
import type { MuseUsageAccount } from "./usageLimits.ts";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

const settings = Schema.decodeEffect(MuseSettings);

const observedAtMs = 1793073851130;
const allowance = {
  asOfMs: observedAtMs,
  source: "mint",
  tier: "Muse Code High Usage",
  window: { usedPercent: 1, resetsAtMs: 1793091678000 },
  weekly: { usedPercent: 33, resetsAtMs: 1793577600000 },
};
const response = { schemaVersion: 1, allowance, reason: null, hint: null };
const provider = {
  enabled: true,
  installed: true,
  version: "1.4.13",
  status: "ready",
  auth: { status: "authenticated", type: "accountLogin", email: "a@example.com" },
  checkedAt: "2026-10-27T04:04:11.130Z",
  models: [],
  skills: [],
  slashCommands: [],
} satisfies ServerProviderDraft;
const account = { generation: 0, identity: "a@example.com" };
const report = {
  generation: 0,
  usage: {
    observedAtMs,
    tier: allowance.tier,
    window: { ...allowance.window, windowDurationMins: 300 },
    weekly: allowance.weekly,
  },
};

const fixture = (source = `process.stdout.write(${JSON.stringify(JSON.stringify(response))});`) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-usage-probe-" });
    const binaryPath = writeFakeCli({
      directory,
      name: "muse",
      source: `
        if (JSON.stringify(process.argv.slice(2)) !== '["usage","--json"]') process.exit(12);
        ${source}
      `,
    });
    return {
      settings: yield* settings({ enabled: true, binaryPath }),
      environment: {
        ...process.env,
        MUSE_NO_AUTO_UPDATE: "1",
        T3_USAGE_TEST: "configured",
        T3_USAGE_CWD: yield* fs.realPath(directory),
      },
      cwd: directory,
      provider,
      account,
      latestUsage: undefined,
    };
  });

const refreshMuseUsage = Effect.fn("test.refreshMuseUsage")(function* (
  input: Omit<Parameters<typeof refreshState>[0], "state"> & {
    readonly account: MuseUsageAccount;
    readonly latestUsage: MuseUsageReport | undefined;
  },
) {
  return yield* refreshState({
    ...input,
    state: {
      account: yield* Ref.make(input.account),
      latestUsage: yield* Ref.make(input.latestUsage),
      permit: yield* Semaphore.make(1),
    },
  });
});

it.layer(NodeServices.layer)("Muse CLI usage refresh", (it) => {
  it.effect("fills limits on the first status refresh without a model turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const input = yield* fixture(`
        if (process.env.T3_USAGE_TEST !== 'configured' || process.cwd() !== process.env.T3_USAGE_CWD) process.exit(13);
        process.stdout.write(${JSON.stringify(JSON.stringify(response))});
      `);
        const refreshed = yield* refreshMuseUsage(input);
        expect(refreshed.latestUsage).toEqual(report);
        expect(refreshed.provider.usageLimits).toEqual({
          checkedAt: "2026-10-27T04:04:11.130Z",
          windows: [
            {
              id: "window",
              kind: "session",
              label: "Session",
              windowDurationMins: 300,
              usedPercent: 1,
              resetsAt: "2026-10-27T09:01:18.000Z",
            },
            {
              id: "weekly",
              kind: "weekly",
              label: "Weekly",
              windowDurationMins: 10080,
              usedPercent: 33,
              resetsAt: "2026-11-02T00:00:00.000Z",
            },
          ],
        });
        expect(refreshed.provider.status).toBe("ready");
      }),
    ),
  );

  it.effect.each([
    [
      "an empty allowance",
      'process.stdout.write(JSON.stringify({schemaVersion:1,allowance:null,reason:"server_sent_no_usage"}));',
    ],
    [
      "an older CLI without the command",
      'process.stderr.write("unknown command usage"); process.exit(2);',
    ],
    ["invalid JSON", 'process.stdout.write("invalid");'],
    [
      "an unknown schema version",
      `process.stdout.write(${JSON.stringify(JSON.stringify({ ...response, schemaVersion: 2 }))});`,
    ],
    [
      "an invalid percentage",
      `process.stdout.write(${JSON.stringify(JSON.stringify({ ...response, allowance: { ...allowance, window: { ...allowance.window, usedPercent: -1 } } }))});`,
    ],
  ] as const)("keeps the latest same-account report after %s", ([, source]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const input = yield* fixture(source);
        const refreshed = yield* refreshMuseUsage({ ...input, latestUsage: report });
        expect(refreshed.latestUsage).toBe(report);
        expect(refreshed.provider.usageLimits?.unavailable).toBeUndefined();
        expect(refreshed.provider.usageLimits?.windows.map((w) => w.usedPercent)).toEqual([1, 33]);
        const first = yield* refreshMuseUsage(input);
        expect(first.latestUsage).toBeUndefined();
        expect(first.provider.usageLimits?.unavailable?.message).toContain("next reply");
      }),
    ),
  );

  it.effect("keeps a newer notification instead of replacing it with an older CLI read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const input = yield* fixture();
        const newer = {
          ...report,
          usage: {
            ...report.usage,
            observedAtMs: observedAtMs + 1,
            window: { ...report.usage.window, usedPercent: 10 },
          },
        };
        const refreshed = yield* refreshMuseUsage({ ...input, latestUsage: newer });
        expect(refreshed.latestUsage).toBe(newer);
        expect(refreshed.provider.usageLimits?.windows[0]?.usedPercent).toBe(10);
      }),
    ),
  );

  it.effect("drops the old account's report when a new account has no allowance", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const input = yield* fixture(
          "process.stdout.write(JSON.stringify({schemaVersion:1,allowance:null}));",
        );
        const refreshed = yield* refreshMuseUsage({
          ...input,
          latestUsage: report,
          provider: { ...provider, auth: { ...provider.auth, email: "b@example.com" } },
        });
        expect(refreshed.account).toEqual({ generation: 1, identity: "b@example.com" });
        expect(refreshed.latestUsage).toBeUndefined();
        expect(refreshed.provider.usageLimits).toBeUndefined();
      }),
    ),
  );

  it.effect("attributes a new account's CLI read to its new generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const input = yield* fixture();
        const refreshed = yield* refreshMuseUsage({
          ...input,
          latestUsage: report,
          provider: { ...provider, auth: { ...provider.auth, email: "b@example.com" } },
        });
        expect(refreshed.latestUsage).toEqual({ ...report, generation: 1 });
        expect(refreshed.account.identity).toBe("b@example.com");
      }),
    ),
  );

  it.effect(
    "never runs the command for API keys, signed-out accounts, disabled or failed providers",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const input = yield* fixture();
          const fs = yield* FileSystem.FileSystem;
          const marker = `${input.cwd}/spawned`;
          const binaryPath = writeFakeCli({
            directory: input.cwd,
            name: "forbidden",
            source: `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'spawned');`,
          });
          const cases: ServerProviderDraft[] = [
            { ...provider, auth: { status: "authenticated", type: "apiKey" } },
            { ...provider, auth: { status: "unauthenticated" } },
            { ...provider, auth: { status: "unknown" } },
            { ...provider, enabled: false },
            { ...provider, status: "error" },
            { ...provider, version: "1.4.12-R6909.1" },
            { ...provider, version: null },
          ];
          for (const candidate of cases) {
            const refreshed = yield* refreshMuseUsage({
              ...input,
              settings: { ...input.settings, binaryPath },
              provider: candidate,
              latestUsage: report,
            });
            expect(refreshed.provider.auth).toEqual(candidate.auth);
            if (candidate.auth.status === "unauthenticated" || candidate.auth.type === "apiKey") {
              expect(refreshed.latestUsage).toBeUndefined();
            }
          }
          expect(yield* fs.exists(marker)).toBe(false);
        }),
      ),
  );

  it.effect(
    "publishes a notification while the CLI read is stalled and retains the newer report",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const input = yield* fixture();
          const state = {
            account: yield* Ref.make<MuseUsageAccount>(account),
            latestUsage: yield* Ref.make<MuseUsageReport | undefined>(report),
            permit: yield* Semaphore.make(1),
          };
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const pending = yield* refreshState({
            ...input,
            provider: { ...provider, auth: { ...provider.auth, email: "b@example.com" } },
            state,
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
              ...spawner,
              spawn: (command) =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(spawner.spawn(command)),
                ),
            }),
            Effect.forkChild,
          );
          yield* Deferred.await(started);
          expect(yield* Ref.get(state.account)).toEqual({
            generation: 1,
            identity: "b@example.com",
          });
          const newer = {
            ...report,
            generation: 1,
            usage: {
              ...report.usage,
              observedAtMs: observedAtMs + 1,
              window: { ...report.usage.window, usedPercent: 10 },
            },
          };
          const published = yield* Deferred.make<void>();
          yield* state.permit.withPermits(1)(
            Ref.set(state.latestUsage, newer).pipe(
              Effect.andThen(Deferred.succeed(published, undefined)),
            ),
          );
          yield* Deferred.await(published);
          expect(yield* Ref.get(state.latestUsage)).toBe(newer);
          yield* Deferred.succeed(release, undefined);
          const refreshed = yield* Fiber.join(pending);
          expect(refreshed.latestUsage).toBe(newer);
          expect(refreshed.provider.usageLimits?.windows[0]?.usedPercent).toBe(10);
        }),
      ),
  );

  it.effect("discards an in-flight read after the account generation changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const input = yield* fixture();
        const state = {
          account: yield* Ref.make<MuseUsageAccount>(account),
          latestUsage: yield* Ref.make<MuseUsageReport | undefined>(report),
          permit: yield* Semaphore.make(1),
        };
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const pending = yield* refreshState({ ...input, state }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
            ...spawner,
            spawn: (command) =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(spawner.spawn(command)),
              ),
          }),
          Effect.forkChild,
        );
        yield* Deferred.await(started);
        const signedOut = { generation: 1, identity: null };
        yield* state.permit.withPermits(1)(
          Ref.set(state.account, signedOut).pipe(
            Effect.andThen(Ref.set(state.latestUsage, undefined)),
          ),
        );
        yield* Deferred.succeed(release, undefined);
        const refreshed = yield* Fiber.join(pending);
        expect(refreshed.account).toBe(signedOut);
        expect(refreshed.latestUsage).toBeUndefined();
        expect(refreshed.provider.usageLimits).toBeUndefined();
        expect(yield* Ref.get(state.account)).toBe(signedOut);
      }),
    ),
  );

  it.effect("bounds a stalled CLI read and keeps the last observation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const input = yield* fixture();
        const started = yield* Deferred.make<void>();
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const pending = yield* refreshMuseUsage({ ...input, latestUsage: report }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
            ...spawner,
            spawn: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          }),
          Effect.forkChild,
        );
        yield* Deferred.await(started);
        yield* TestClock.adjust("4 seconds");
        const refreshed = yield* Fiber.join(pending);
        expect(refreshed.latestUsage).toBe(report);
        expect(refreshed.provider.status).toBe("ready");
      }),
    ),
  );
});
