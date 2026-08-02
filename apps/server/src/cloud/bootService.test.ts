import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  liveServiceHost,
  filesystemErrorIsAbsence,
  lockOwnerRemainsActive,
  make,
  parseLaunchctlState,
  renderLaunchAgent,
  resolvePackagedDist,
  servicePaths,
  type ServiceHost,
  type ServicePlan,
} from "./bootService.ts";
import type { ProcessRunResult } from "../processRunner.ts";

const result = (
  code: number | null = 0,
  stdout = "",
  stderr = "",
  timedOut = false,
): ProcessRunResult => ({
  code,
  stdout,
  stderr,
  signal: null,
  timedOut,
});

const makeDeferred = () => {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
};

const makeHost = (options?: { readonly canonicalize?: ServiceHost["canonicalize"] }) => {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const canonical = new Map<string, string>();
  const modes = new Map<string, number>();
  const commands: Array<{ command: string; args: ReadonlyArray<string> }> = [];
  const commandResults = new Map<string, ProcessRunResult>();
  const heldLocks = new Set<string>();
  const lockWaiters = new Map<string, Array<() => void>>();
  const lockAttemptWaiters: Array<{ count: number; resolve: () => void }> = [];
  let loaded = false;
  let disabled = false;
  let pid = 0;
  let runtimePid = 4321;
  let probe = true;
  let failCopy = false;
  let bootoutHook: (() => void) | undefined;
  let lockAttempts = 0;
  let activeCriticalSections = 0;
  let maxCriticalSections = 0;
  let copyGate:
    | {
        readonly entered: ReturnType<typeof makeDeferred>;
        readonly release: ReturnType<typeof makeDeferred>;
      }
    | undefined;
  const host: ServiceHost = {
    canonicalize: options?.canonicalize ?? (async (path) => canonical.get(path) ?? path),
    exists: async (path) => files.has(path) || directories.has(path),
    read: async (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    },
    writeAtomic: async (path, contents, mode) => {
      files.set(path, contents);
      modes.set(path, mode);
    },
    makeDirectory: async (path, mode) => {
      directories.add(path);
      modes.set(path, mode);
    },
    listDirectory: async (path) =>
      [...directories]
        .filter((entry) => entry.startsWith(`${path}/`))
        .map((entry) => entry.slice(path.length + 1).split("/")[0]!)
        .filter((entry, index, entries) => entries.indexOf(entry) === index),
    copyDirectory: async (_source, destination) => {
      if (failCopy) throw new Error("copy failed");
      const gate = copyGate;
      copyGate = undefined;
      if (gate !== undefined) {
        gate.entered.resolve();
        await gate.release.promise;
      }
      directories.add(destination);
      files.set(`${destination}/bin.mjs`, "bundle");
      files.set(`${destination}/client/index.html`, "client");
    },
    rename: async (source, destination) => {
      const value = files.get(source);
      if (value !== undefined) files.set(destination, value);
      files.delete(source);
    },
    remove: async (path, recursive) => {
      files.delete(path);
      directories.delete(path);
      if (recursive) {
        for (const key of files.keys()) if (key.startsWith(`${path}/`)) files.delete(key);
        for (const key of directories) if (key.startsWith(`${path}/`)) directories.delete(key);
      }
    },
    chmod: async (path, mode) => {
      modes.set(path, mode);
      directories.add(path);
    },
    acquireLock: async (path) => {
      lockAttempts += 1;
      for (const waiter of lockAttemptWaiters.splice(0)) {
        if (lockAttempts >= waiter.count) waiter.resolve();
        else lockAttemptWaiters.push(waiter);
      }
      if (heldLocks.has(path)) {
        await new Promise<void>((resolve) => {
          const waiters = lockWaiters.get(path) ?? [];
          waiters.push(resolve);
          lockWaiters.set(path, waiters);
        });
      } else {
        heldLocks.add(path);
      }
      activeCriticalSections += 1;
      maxCriticalSections = Math.max(maxCriticalSections, activeCriticalSections);
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          activeCriticalSections -= 1;
          const waiters = lockWaiters.get(path);
          const next = waiters?.shift();
          if (waiters?.length === 0) lockWaiters.delete(path);
          if (next === undefined) heldLocks.delete(path);
          else next();
        },
      };
    },
    run: async (command, args) => {
      commands.push({ command, args });
      const override = commandResults.get(args[0] ?? "");
      if (override !== undefined) return override;
      if (args[0] === "print") {
        return loaded
          ? result(0, `state = ${pid > 0 ? "running" : "waiting"}\npid = ${pid}\n`)
          : result(113, "", `Could not find service "${args[1]}" in domain`);
      }
      if (args[0] === "print-disabled") {
        const label = commands
          .flatMap(({ args: commandArgs }) => commandArgs)
          .findLast((argument) => argument.includes("com.t3tools.t3code.server."));
        return result(0, disabled && label ? `"${label.split("/").at(-1)}" => disabled\n` : "");
      }
      if (args[0] === "bootstrap") loaded = true;
      if (args[0] === "bootout") {
        if (!loaded) return result(3, "", "Boot-out failed: 3: No such process");
        loaded = false;
        pid = 0;
        bootoutHook?.();
      }
      if (args[0] === "kickstart") {
        loaded = true;
        pid = 4321;
      }
      if (args[0] === "disable") disabled = true;
      if (args[0] === "enable") disabled = false;
      return result();
    },
    probeRuntime: async (_runtimeStatePath, expectedPid) => probe && runtimePid === expectedPid,
    removeRuntimeStateIfOwned: async (runtimeStatePath, expectedPid) => {
      const raw = files.get(runtimeStatePath);
      if (raw === undefined) return false;
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("pid" in parsed) ||
        parsed.pid !== expectedPid
      ) {
        return false;
      }
      files.delete(runtimeStatePath);
      return true;
    },
  };
  return {
    host,
    files,
    directories,
    canonical,
    modes,
    commands,
    setProbe: (value: boolean) => {
      probe = value;
    },
    setRuntimePid: (value: number) => {
      runtimePid = value;
    },
    setFailCopy: (value: boolean) => {
      failCopy = value;
    },
    setBootoutHook: (hook: (() => void) | undefined) => {
      bootoutHook = hook;
    },
    setCommandResult: (action: string, value: ProcessRunResult | undefined) => {
      if (value === undefined) commandResults.delete(action);
      else commandResults.set(action, value);
    },
    pauseNextCopy: () => {
      const gate = { entered: makeDeferred(), release: makeDeferred() };
      copyGate = gate;
      return {
        entered: gate.entered.promise,
        release: gate.release.resolve,
      };
    },
    waitForLockAttempts: (count: number) => {
      if (lockAttempts >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        lockAttemptWaiters.push({ count, resolve });
      });
    },
    lockAttempts: () => lockAttempts,
    maxCriticalSections: () => maxCriticalSections,
  };
};

const seedPackage = (fake: ReturnType<typeof makeHost>, realEntry: string) => {
  fake.files.set(realEntry, "bundle");
  fake.files.set(`${realEntry.slice(0, -"/bin.mjs".length)}/client/index.html`, "client");
};

const makeTestService = (fake: ReturnType<typeof makeHost>, baseDir = "/data/one") => {
  const realEntry = "/Applications/T3/dist/bin.mjs";
  seedPackage(fake, realEntry);
  return make({
    baseDir,
    host: fake.host,
    platform: "darwin",
    homeDir: "/Users/me",
    userId: 501,
    executablePath: "/usr/bin/node",
    cliEntryPath: realEntry,
    processEnvironment: {},
  });
};

it("resolves symlinked npm and Bun bin entrypoints to packaged dist assets", async () => {
  for (const link of ["/Users/me/.npm/bin/t3", "/Users/me/.bun/bin/t3"]) {
    const fake = makeHost();
    const realEntry = "/opt/t3/node_modules/t3/dist/bin.mjs";
    fake.canonical.set(link, realEntry);
    seedPackage(fake, realEntry);
    assert.deepEqual(await Effect.runPromise(resolvePackagedDist(link, fake.host)), {
      entryPath: realEntry,
      distDir: "/opt/t3/node_modules/t3/dist",
    });
  }
});

it.effect("rejects transient and incomplete runtime layouts", () =>
  Effect.gen(function* () {
    const fake = makeHost();
    const transient = "/Users/me/.bun/install/cache/t3/dist/bin.mjs";
    fake.files.set(transient, "bundle");
    assert.equal(
      (yield* resolvePackagedDist(transient, fake.host).pipe(Effect.flip))._tag,
      "BootServiceError",
    );
    assert.equal(
      (yield* resolvePackagedDist("/repo/apps/server/src/bin.ts", fake.host).pipe(Effect.flip))
        ._tag,
      "BootServiceError",
    );
  }),
);

it("derives isolated launchd targets and paths from canonical base directories", () => {
  const first = servicePaths({ homeDir: "/Users/me", canonicalBaseDir: "/data/one", userId: 501 });
  const second = servicePaths({ homeDir: "/Users/me", canonicalBaseDir: "/data/two", userId: 501 });
  assert.notEqual(first.instanceId, second.instanceId);
  assert.notEqual(first.target, second.target);
  assert.notEqual(first.definitionPath, second.definitionPath);
  assert.notEqual(first.lockPath, second.lockPath);
  assert.notEqual(first.instanceDir, second.instanceDir);
  assert.isFalse(first.lockPath.startsWith(first.instanceDir));
  assert.isTrue(first.instanceDir.startsWith("/data/one/runtime/background-service/"));
  assert.isTrue(second.instanceDir.startsWith("/data/two/runtime/background-service/"));
});

it("keeps identity stable when a missing base directory is reached through a symlink", async () => {
  const root = await mkdtemp(join(process.cwd(), ".boot-service-symlink-"));
  try {
    const realParent = join(root, "real-parent");
    const linkedParent = join(root, "linked-parent");
    const requestedBaseDir = join(linkedParent, "missing-child");
    await mkdir(realParent);
    await symlink(realParent, linkedParent);

    const fake = makeHost({ canonicalize: liveServiceHost.canonicalize });
    const realEntry = "/Applications/T3/dist/bin.mjs";
    seedPackage(fake, realEntry);
    const beforeCreation = await Effect.runPromise(
      make({
        baseDir: requestedBaseDir,
        host: fake.host,
        platform: "darwin",
        homeDir: "/Users/me",
        userId: 501,
        executablePath: "/usr/bin/node",
        cliEntryPath: realEntry,
        processEnvironment: {},
      }),
    );
    const installed = await Effect.runPromise(beforeCreation.install({ cwd: "/Users/me/code" }));

    await mkdir(join(realParent, "missing-child"));
    const afterCreation = await Effect.runPromise(
      make({
        baseDir: requestedBaseDir,
        host: fake.host,
        platform: "darwin",
        homeDir: "/Users/me",
        userId: 501,
        executablePath: "/usr/bin/node",
        cliEntryPath: realEntry,
        processEnvironment: {},
      }),
    );
    const status = await Effect.runPromise(afterCreation.status);

    assert.equal(status.instanceId, installed.instanceId);
    assert.equal(status.definitionPath, installed.definitionPath);
    assert.equal(status.instanceDir, installed.instanceDir);
    assert.isTrue(await Effect.runPromise(afterCreation.uninstall));
    assert.isFalse(fake.directories.has(installed.instanceDir));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("bounds live lock acquisition, preserves live owners, and reclaims dead owners", async () => {
  const root = await mkdtemp(join(process.cwd(), ".boot-service-lock-"));
  const lockPath = join(root, "locks", "instance.lock");
  const options = {
    timeoutMs: 100,
    pollIntervalMs: 5,
    incompleteOwnerStaleMs: 5,
  };
  try {
    const first = await liveServiceHost.acquireLock(lockPath, options);
    let acquisitionError: unknown;
    try {
      await liveServiceHost.acquireLock(lockPath, options);
    } catch (cause) {
      acquisitionError = cause;
    }
    if (!(acquisitionError instanceof Error)) {
      assert.fail(`Expected lock acquisition error, received ${String(acquisitionError)}`);
    }
    assert.match(acquisitionError.message, /Timed out acquiring background service lock/);
    await first.release();

    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({ pid: 999_999, token: "dead-owner" })}\n`,
    );
    const reclaimed = await liveServiceHost.acquireLock(lockPath, options);
    await reclaimed.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("treats unavailable process identity as inconclusive for a live lock owner", () => {
  assert.isTrue(
    lockOwnerRemainsActive({
      pidAlive: true,
      recordedProcessStart: "recorded",
    }),
  );
  assert.isFalse(
    lockOwnerRemainsActive({
      pidAlive: true,
      recordedProcessStart: "recorded",
      currentProcessStart: "different",
    }),
  );
  assert.isFalse(
    lockOwnerRemainsActive({
      pidAlive: false,
      recordedProcessStart: "recorded",
    }),
  );
});

it("classifies only actual path absence as missing", () => {
  assert.isTrue(filesystemErrorIsAbsence({ code: "ENOENT" }));
  assert.isTrue(filesystemErrorIsAbsence({ code: "ENOTDIR" }));
  assert.isFalse(filesystemErrorIsAbsence({ code: "EACCES" }));
  assert.isFalse(filesystemErrorIsAbsence({ code: "EIO" }));
});

it("only removes live runtime state claimed by the expected pid", async () => {
  const root = await mkdtemp(join(process.cwd(), ".boot-service-state-"));
  const runtimeStatePath = join(root, "server-runtime.json");
  try {
    await writeFile(runtimeStatePath, `${JSON.stringify({ pid: process.pid })}\n`);
    assert.isFalse(
      await liveServiceHost.removeRuntimeStateIfOwned(runtimeStatePath, process.pid + 1),
    );
    assert.equal(JSON.parse(await readFile(runtimeStatePath, "utf8")).pid, process.pid);

    await writeFile(runtimeStatePath, `${JSON.stringify({ pid: process.pid })}\n`);
    assert.isTrue(await liveServiceHost.removeRuntimeStateIfOwned(runtimeStatePath, process.pid));
    assert.isFalse(await liveServiceHost.exists(runtimeStatePath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("renders escaped private LaunchAgents with service-only startup", () => {
  const paths = servicePaths({
    homeDir: "/Users/me",
    canonicalBaseDir: "/Users/me/T3 & Data",
    userId: 501,
  });
  const plan: ServicePlan = {
    ...paths,
    baseDir: "/Users/me/T3 & Data",
    runtimePath: `${paths.runtimesDir}/1/dist/bin.mjs`,
    arguments: ["/usr/bin/node", `${paths.runtimesDir}/1/dist/bin.mjs`, "serve"],
    environment: {
      T3CODE_HOME: "/Users/me/T3 & Data",
      T3CODE_BACKGROUND_SERVICE: "true",
    },
  };
  const plist = renderLaunchAgent(plan);
  assert.include(plist, "/Users/me/T3 &amp; Data");
  assert.include(plist, "<key>Umask</key>\n  <integer>63</integer>");
  assert.include(plist, "<key>T3CODE_BACKGROUND_SERVICE</key>");
  assert.include(plist, "<key>WorkingDirectory</key>\n  <string>/Users/me/T3 &amp; Data</string>");
  assert.include(plist, "<key>StandardOutPath</key>\n  <string>/dev/null</string>");
  assert.include(plist, "<key>StandardErrorPath</key>\n  <string>/dev/null</string>");
  assert.notInclude(plist, paths.logPath);
});

it("distinguishes a loaded job from a live process", () => {
  assert.deepEqual(parseLaunchctlState("state = waiting\n"), {
    loaded: true,
    processAlive: false,
  });
  assert.deepEqual(parseLaunchctlState("state = waiting\npid = 0\n"), {
    loaded: true,
    processAlive: false,
  });
  assert.deepEqual(parseLaunchctlState("state = running\npid = 123\n"), {
    loaded: true,
    processAlive: true,
    pid: 123,
  });
});

it.effect("propagates launchctl print failures other than documented absence", () =>
  Effect.gen(function* () {
    for (const failure of [
      result(1, "", "Operation not permitted"),
      result(null, "", ""),
      result(null, "", "", true),
      result(113, "", "launchctl internal error"),
    ]) {
      const fake = makeHost();
      fake.setCommandResult("print", failure);
      const service = yield* makeTestService(fake);
      const error = yield* service.status.pipe(Effect.flip);
      assert.equal(error._tag, "BootServiceError");
      fake.setCommandResult("print", undefined);
    }
  }),
);

it.effect("propagates print-disabled failures other than documented missing domains", () =>
  Effect.gen(function* () {
    const fake = makeHost();
    fake.setCommandResult("print-disabled", result(1, "", "Operation not permitted"));
    const service = yield* makeTestService(fake);
    const error = yield* service.status.pipe(Effect.flip);
    assert.equal(error._tag, "BootServiceError");

    fake.setCommandResult(
      "print-disabled",
      result(112, "", "Could not find domain for user gui: 501"),
    );
    assert.isFalse((yield* service.status).enabled);
  }),
);

it.effect("only ignores documented bootout absence", () =>
  Effect.gen(function* () {
    const fake = makeHost();
    const service = yield* makeTestService(fake);
    yield* service.stop;

    fake.setCommandResult("bootout", result(3, "", "Operation not permitted"));
    const error = yield* service.stop.pipe(Effect.flip);
    assert.equal(error._tag, "BootServiceError");
  }),
);

it.effect("installs, health-checks, isolates, and completely uninstalls instances", () =>
  Effect.gen(function* () {
    const fake = makeHost();
    const realEntry = "/Applications/T3/dist/bin.mjs";
    seedPackage(fake, realEntry);
    const first = yield* make({
      baseDir: "/data/one",
      host: fake.host,
      platform: "darwin",
      homeDir: "/Users/me",
      userId: 501,
      executablePath: "/usr/bin/node",
      cliEntryPath: realEntry,
      processEnvironment: {
        PATH: "/usr/bin:/bin",
        T3CODE_RELAY_URL: "https://relay.example.test",
        T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_public",
        T3CODE_DESKTOP_BOOTSTRAP_TOKEN: "must-not-be-persisted",
      },
    });
    const second = yield* make({
      baseDir: "/data/two",
      host: fake.host,
      platform: "darwin",
      homeDir: "/Users/me",
      userId: 501,
      executablePath: "/usr/bin/node",
      cliEntryPath: realEntry,
      processEnvironment: {},
    });

    yield* first.install({ cwd: "/Users/me/code", host: "127.0.0.1", port: 13_773 });
    yield* second.install({ cwd: "/Users/me/other", port: 13_774 });
    const firstStatus = yield* first.status;
    const secondStatus = yield* second.status;
    assert.isTrue(firstStatus.responsive);
    assert.notEqual(firstStatus.target, secondStatus.target);
    assert.equal(fake.modes.get(firstStatus.definitionPath), 0o600);
    assert.equal(fake.modes.get(firstStatus.instanceDir), 0o700);
    assert.equal(firstStatus.logPath, "/data/one/userdata/logs/server.log");
    assert.isTrue(firstStatus.runtimeStatePath.startsWith(`${firstStatus.instanceDir}/`));
    const definition = fake.files.get(firstStatus.definitionPath) ?? "";
    assert.include(definition, "https://relay.example.test");
    assert.include(definition, "pk_test_public");
    assert.notInclude(definition, "must-not-be-persisted");

    fake.files.delete(firstStatus.definitionPath);
    assert.isTrue(yield* first.uninstall);
    assert.isFalse(fake.directories.has(firstStatus.instanceDir));
    assert.isTrue(fake.files.has(secondStatus.definitionPath));
    assert.isFalse(yield* first.uninstall);
  }),
);

it.effect("rejects health from a runtime state owned by a different pid", () =>
  Effect.gen(function* () {
    const fake = makeHost();
    fake.setRuntimePid(9876);
    const service = yield* makeTestService(fake);
    const error = yield* service.install({ cwd: "/Users/me/code" }).pipe(Effect.flip);
    assert.equal(error._tag, "BootServiceError");
  }),
);

it.effect("preserves foreground runtime state that appears while uninstall stops the service", () =>
  Effect.gen(function* () {
    const fake = makeHost();
    const service = yield* makeTestService(fake);
    yield* service.install({ cwd: "/Users/me/code" });
    const foregroundStatePath = "/data/one/userdata/server-runtime.json";
    fake.setBootoutHook(() => {
      fake.files.set(foregroundStatePath, JSON.stringify({ pid: 9001 }));
    });

    assert.isTrue(yield* service.uninstall);
    assert.equal(fake.files.get(foregroundStatePath), JSON.stringify({ pid: 9001 }));
  }),
);

it("serializes concurrent install operations for one instance", async () => {
  const fake = makeHost();
  const service = await Effect.runPromise(makeTestService(fake));
  const gate = fake.pauseNextCopy();
  const first = Effect.runPromise(service.install({ cwd: "/Users/me/first" }));
  await gate.entered;
  const second = Effect.runPromise(service.install({ cwd: "/Users/me/second" }));
  await fake.waitForLockAttempts(2);

  assert.equal(fake.maxCriticalSections(), 1);
  gate.release();
  await Promise.all([first, second]);
  assert.equal(fake.maxCriticalSections(), 1);
});

it("serializes install and uninstall through rollback, health, and pruning", async () => {
  const fake = makeHost();
  const service = await Effect.runPromise(makeTestService(fake));
  await Effect.runPromise(service.install({ cwd: "/Users/me/initial" }));
  const gate = fake.pauseNextCopy();
  const installing = Effect.runPromise(service.install({ cwd: "/Users/me/replacement" }));
  await gate.entered;
  const uninstalling = Effect.runPromise(service.uninstall);
  await fake.waitForLockAttempts(3);

  assert.equal(fake.maxCriticalSections(), 1);
  gate.release();
  await installing;
  assert.isTrue(await uninstalling);
  assert.equal(fake.maxCriticalSections(), 1);
});

it.effect("fails install when launchd has no live responsive process and rolls back", () =>
  Effect.gen(function* () {
    const fake = makeHost();
    const realEntry = "/Applications/T3/dist/bin.mjs";
    seedPackage(fake, realEntry);
    const service = yield* make({
      baseDir: "/data/one",
      host: fake.host,
      platform: "darwin",
      homeDir: "/Users/me",
      userId: 501,
      executablePath: "/usr/bin/node",
      cliEntryPath: realEntry,
      processEnvironment: {},
    });
    yield* service.install({ cwd: "/Users/me/code", port: 13_773 });
    const previous = yield* service.status;
    const previousDefinition = fake.files.get(previous.definitionPath);
    const knownGoodRuntimes = yield* Effect.promise(() =>
      fake.host.listDirectory(previous.runtimesDir),
    );
    fake.setProbe(false);
    assert.equal(
      (yield* service.install({ cwd: "/Users/me/code", port: 13_773 }).pipe(Effect.flip))._tag,
      "BootServiceError",
    );
    assert.equal(fake.files.get(previous.definitionPath), previousDefinition);
    assert.deepEqual(
      yield* Effect.promise(() => fake.host.listDirectory(previous.runtimesDir)),
      knownGoodRuntimes,
    );
  }),
);

it.effect("restores the prior definition even when rollback cleanup also fails", () =>
  Effect.gen(function* () {
    const fake = makeHost();
    const service = yield* makeTestService(fake);
    const original = yield* service.install({ cwd: "/Users/me/original" });
    const originalDefinition = fake.files.get(original.definitionPath);

    fake.setCommandResult("bootout", result(1, "", "Operation not permitted"));
    const error = yield* service.install({ cwd: "/Users/me/replacement" }).pipe(Effect.flip);

    assert.equal(error._tag, "BootServiceError");
    assert.equal(fake.files.get(original.definitionPath), originalDefinition);
  }),
);

it.effect("preserves the active service when candidate copying fails", () =>
  Effect.gen(function* () {
    const fake = makeHost();
    const realEntry = "/Applications/T3/dist/bin.mjs";
    seedPackage(fake, realEntry);
    const service = yield* make({
      baseDir: "/data/one",
      host: fake.host,
      platform: "darwin",
      homeDir: "/Users/me",
      userId: 501,
      executablePath: "/usr/bin/node",
      cliEntryPath: realEntry,
      processEnvironment: {},
    });
    yield* service.install({ cwd: "/Users/me/code" });
    const before = yield* service.status;
    const definition = fake.files.get(before.definitionPath);
    fake.setFailCopy(true);
    yield* service.install({ cwd: "/Users/me/code" }).pipe(Effect.flip);
    assert.equal(fake.files.get(before.definitionPath), definition);
    assert.isTrue((yield* service.status).processAlive);
  }),
);

it.effect("explicitly defers Linux and Windows", () =>
  Effect.gen(function* () {
    for (const platform of ["linux", "win32"] as const) {
      const fake = makeHost();
      const service = yield* make({
        baseDir: "/data/one",
        host: fake.host,
        platform,
        homeDir: "/home/me",
        userId: 1000,
        executablePath: "/usr/bin/node",
        cliEntryPath: "/opt/t3/dist/bin.mjs",
        processEnvironment: {},
      });
      assert.isFalse((yield* service.status).supported);
      assert.equal(
        (yield* service.install({ cwd: "/data" }).pipe(Effect.flip))._tag,
        "BootServiceUnsupportedError",
      );
      assert.equal(fake.lockAttempts(), 0);
    }
  }),
);

it.effect("respects an explicitly unavailable macOS user id", () =>
  Effect.gen(function* () {
    const service = yield* make({
      baseDir: "/data/one",
      host: makeHost().host,
      platform: "darwin",
      homeDir: "/Users/me",
      userId: null,
      executablePath: "/usr/bin/node",
      cliEntryPath: "/Applications/T3/dist/bin.mjs",
      processEnvironment: {},
    });
    assert.isFalse((yield* service.status).supported);
  }),
);
