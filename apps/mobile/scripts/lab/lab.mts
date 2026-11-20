// @effect-diagnostics nodeBuiltinImport:off - a dev script, not Effect code.
// Mobile UI lab: the real Conn iOS app on fake data, with live reload. Twin of the desktop lab.
//
// What it runs (all on this Mac, all stopped with ctrl+C or `stop`):
//   1. a T3 server with its own home (.t3-mobile-lab/, gitignored), seeded from fixtures.mts
//   2. Metro for apps/mobile on a free port, so edits to apps/mobile JS fast-refresh in the app
// The simulator and the native dev client are not started here: open the lab in the T3 Device panel.
//
// Usage (from apps/mobile; `vp run lab -- <args>` also works):
//   node scripts/lab/lab.mts start [--agent-device <path>] [--pair]   run server + Metro (foreground)
//   node scripts/lab/lab.mts reseed                                   re-run the seeder in a running lab
//   node scripts/lab/lab.mts open [--agent-device <path>] [--pair] [--keep-cache] [--udid <udid>]
//                                                                     open Metro and the fixture thread;
//                                                                     clears the app's thread cache unless --keep-cache
//   node scripts/lab/lab.mts header-icons <solid16|outline24|solid24|solid20>         switch the native header icons
//                                                                     (superheroicons 16px solid or 24px
//                                                                     outline) live, no Metro restart;
//                                                                     CONN_HEADER_ICONS=... at `start` too
//   node scripts/lab/lab.mts theme <dark-mono|dark-ocean|ocean|stock|light> [--agent-device <path>] [--udid <udid>]
//                                                                     switch the phone's theme (closes the app, writes its
//                                                                     theme preferences, reopens it with --agent-device).
//                                                                     The lab wears Nick's Dark Mono by default (scripts/lab/themes.mts);
//                                                                     `open` sets it on a phone that has no theme choice yet.
//   node scripts/lab/lab.mts status | stop
// `--agent-device` is the command `device_open` returned (it is bound to the device). With it,
// `start` opens the dev client and the fixture thread once the lab is up. `--pair` also pairs the
// app with the lab server; do that once, the pairing survives reseeds and restarts.
//
// First time only: build the dev client in nick-vm with scripts/lab/build-client-vm.sh and install it
// in a simulator of your own (a build is only needed again when native code changes).
//
// Edit data in scripts/lab/fixtures.mts, then `reseed`. Edit app code in src/: it fast-refreshes.
// Times in fixtures are relative to the seed, so a "Working 13m 45s" card starts there and ticks.
import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as Net from "node:net";
import * as Path from "node:path";
import * as URL from "node:url";

import {
  applyLabTheme,
  DEFAULT_LAB_THEME,
  isLabTheme,
  LAB_THEMES,
  publishLabThemes,
} from "./themes.mts";

const MOBILE_ROOT = Path.resolve(Path.dirname(URL.fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = Path.resolve(MOBILE_ROOT, "../..");
const HOME = Path.join(REPO_ROOT, ".t3-mobile-lab");
const STATE_FILE = Path.join(HOME, "lab.json");
const BUNDLE_ID = "com.t3tools.t3code.dev";
const SCHEME = "t3code-dev";
const PRIMARY_THREAD_ID = "lab-stalled-threads";
const PREFERRED = { server: 3791, metro: 8099 };

interface LabState {
  readonly pid: number;
  readonly serverPort: number;
  readonly metroPort: number;
  readonly serverPid: number | null;
  readonly metroPid: number | null;
  readonly environmentId: string | null;
}

const log = (message: string) => console.error(`[lab] ${message}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function readState(): LabState | null {
  try {
    return JSON.parse(FS.readFileSync(STATE_FILE, "utf8")) as LabState;
  } catch {
    return null;
  }
}

function alive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = Net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

async function pickPort(preferred: number): Promise<number> {
  if (await portFree(preferred)) return preferred;
  return new Promise((resolve) => {
    const probe = Net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === "object" && address ? address.port : preferred));
    });
  });
}

async function waitForPort(port: number, what: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portFree(port))) return;
    await sleep(300);
  }
  throw new Error(`${what} did not listen on ${port} within ${timeoutMs / 1000}s.`);
}

function run(command: string, args: string[], options: ChildProcess.SpawnSyncOptions = {}) {
  return ChildProcess.spawnSync(command, args, { encoding: "utf8", ...options });
}

/** The server reads the machine name from scutil/hostnamectl; a shim names this environment "mini". */
function labelShim(label: string): string {
  const dir = Path.join(HOME, "bin");
  FS.mkdirSync(dir, { recursive: true });
  const script = `#!/bin/sh
if [ "$1" = "--get" ] && [ "$2" = "ComputerName" ]; then printf '%s\\n' ${JSON.stringify(label)}; exit 0; fi
if [ "$1" = "--pretty" ]; then printf '%s\\n' ${JSON.stringify(label)}; exit 0; fi
exit 1
`;
  for (const name of ["scutil", "hostnamectl"]) {
    FS.writeFileSync(Path.join(dir, name), script, { mode: 0o755 });
  }
  // The server rebuilds PATH through the login shell; this one keeps ours, so the shims win.
  const shell = Path.join(dir, "lab-shell");
  FS.writeFileSync(
    shell,
    `#!/bin/sh
if [ "$1" = "-ilc" ] || [ "$1" = "-lic" ]; then exec /bin/sh -c "$2"; fi
exec /bin/cat
`,
    { mode: 0o755 },
  );
  return dir;
}

/** Own process group, so stopping it never touches anything else. */
function spawnGroup(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  logFile: string,
) {
  const out = FS.openSync(logFile, "a");
  const child = ChildProcess.spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", out, out],
  });
  return child;
}

async function stopGroup(child: ChildProcess.ChildProcess | null): Promise<void> {
  if (!child?.pid || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  await Promise.race([exited, sleep(8000)]);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
}

const HEADER_VARIANTS = ["solid16", "outline24", "solid24", "solid20"];

function setHeaderIcons(variant: string | undefined) {
  if (variant === undefined || !HEADER_VARIANTS.includes(variant))
    throw new Error(`Header icons: pass one of ${HEADER_VARIANTS.join(" | ")}.`);
  FS.writeFileSync(
    Path.join(MOBILE_ROOT, "src/lab/icons/headerVariant.ts"),
    `// Written by \`node scripts/lab/lab.mts header-icons <solid16|outline24|solid24|solid20>\`. Lab only.\nexport const HEADER_VARIANT: "solid16" | "outline24" | "solid24" | "solid20" = ${JSON.stringify(variant)};\n`,
  );
  log(`Native header icons: ${variant}`);
}

async function main() {
  const [command = "start", ...rest] = process.argv.slice(2);
  const flag = (name: string) => {
    const index = rest.indexOf(`--${name}`);
    return index === -1 ? null : (rest[index + 1] ?? "");
  };
  const has = (name: string) => rest.includes(`--${name}`);
  const agentDevice = flag("agent-device");
  const openOptions = { udid: flag("udid"), keepCache: has("keep-cache") };

  if (command === "status") {
    const state = readState();
    console.log(JSON.stringify({ running: alive(state?.pid), ...state }, null, 2));
    return;
  }
  if (command === "stop") {
    const state = readState();
    if (state && alive(state.pid)) process.kill(state.pid, "SIGTERM");
    else log("The lab is not running.");
    return;
  }
  if (command === "reseed") {
    const state = readState();
    if (state && alive(state.pid)) process.kill(state.pid, "SIGUSR2");
    else log("The lab is not running; `start` seeds it.");
    return;
  }
  if (command === "open") {
    const state = readState();
    if (!state || !alive(state.pid)) throw new Error("The lab is not running. Run `start` first.");
    openInApp(state, agentDevice, has("pair"), openOptions);
    return;
  }
  if (command === "theme") {
    const theme = rest[0];
    if (!isLabTheme(theme)) throw new Error(`Theme: pass one of ${LAB_THEMES.join(" | ")}.`);
    const udid = openOptions.udid ?? process.env.LAB_UDID ?? findLabSimulator();
    publishLabThemes(HOME, REPO_ROOT);
    if (agentDevice) run(agentDevice, ["close", BUNDLE_ID], { stdio: "pipe" });
    spawnSyncSleep(2);
    const database = appDatabase(udid);
    if (!database) throw new Error("No app database found. Open the lab once first.");
    applyLabTheme(database, theme);
    log(`Phone theme: ${theme}`);
    const state = readState();
    if (agentDevice && state && alive(state.pid))
      openInApp(state, agentDevice, false, { ...openOptions, keepCache: true });
    return;
  }
  if (command === "header-icons") {
    // Edits a file Metro watches, so the running app fast-refreshes: no restart.
    setHeaderIcons(rest[0]);
    return;
  }
  if (command !== "start") throw new Error(`Unknown command ${command}.`);
  if (process.env.CONN_HEADER_ICONS) setHeaderIcons(process.env.CONN_HEADER_ICONS);

  const existing = readState();
  if (existing && alive(existing.pid))
    throw new Error(`The lab already runs (pid ${existing.pid}).`);

  FS.mkdirSync(Path.join(HOME, "workspace", "apps"), { recursive: true });
  publishLabThemes(HOME, REPO_ROOT);
  const { LAB_ENVIRONMENT_LABEL } = await import("./fixtures.mts");
  const shim = labelShim(LAB_ENVIRONMENT_LABEL);
  const serverPort = await pickPort(PREFERRED.server);
  const metroPort = await pickPort(PREFERRED.metro);
  const serverEnv = {
    ...process.env,
    PATH: `${shim}:${process.env.PATH ?? ""}`,
    SHELL: Path.join(shim, "lab-shell"),
    NO_COLOR: "1",
  };
  const workspace = Path.join(HOME, "workspace", "apps");
  const serverArgs = [
    "apps/server/src/bin.ts",
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(serverPort),
    "--base-dir",
    HOME,
    "--no-browser",
    "--log-level",
    "error",
    workspace,
  ];
  const startServer = async () => {
    const child = spawnGroup(
      "node",
      serverArgs,
      REPO_ROOT,
      serverEnv,
      Path.join(HOME, "server.log"),
    );
    await waitForPort(serverPort, "The lab server");
    return child;
  };
  // One timestamp per seed, so the live pass lines up with the base pass.
  let seedNow = String(Date.now());
  const runSeeder = (extra: string[]) => {
    const result = run(
      "node",
      ["scripts/mobile-lab-seed.ts", HOME, Path.join(HOME, "workspace"), ...extra],
      {
        cwd: Path.join(REPO_ROOT, "apps/server"),
        env: { ...process.env, LAB_SEED_NOW: seedNow },
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    if (result.status !== 0) throw new Error("The seeder failed.");
  };
  const seed = () => {
    log("Seeding fixtures...");
    seedNow = String(Date.now());
    runSeeder([]);
  };
  /** Startup recovery cancels running work, so running state is written once the server is up. */
  const seedLive = async () => {
    await sleep(2500);
    runSeeder(["--live"]);
  };
  const environmentId = () => {
    try {
      return FS.readFileSync(Path.join(HOME, "userdata", "environment-id"), "utf8").trim();
    } catch {
      return null;
    }
  };

  let server: ChildProcess.ChildProcess | null = null;
  let metro: ChildProcess.ChildProcess | null = null;
  let stopping = false;
  let reseeding = false;
  const cleanupOnExit = () => {
    for (const child of [metro, server]) {
      if (child?.pid && child.exitCode === null) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
      }
    }
  };
  process.on("exit", cleanupOnExit);

  if (!FS.existsSync(Path.join(HOME, "userdata", "statev2.sqlite"))) {
    log("First run: letting the server create its database...");
    server = await startServer();
    while (!environmentId()) await sleep(300);
    await stopGroup(server);
    server = null;
  }
  seed();
  server = await startServer();
  await seedLive();
  log(`Server on http://127.0.0.1:${serverPort}`);

  metro = spawnGroup(
    Path.join(MOBILE_ROOT, "node_modules/.bin/expo"),
    ["start", "--dev-client", "--scheme", SCHEME, "--localhost", "--port", String(metroPort)],
    MOBILE_ROOT,
    {
      ...process.env,
      APP_VARIANT: "development",
      EXPO_NO_TELEMETRY: "1",
      // The lab draws the superheroicons 16px solid set (metro.config.js). CONN_ICON_LAB=0 turns it off.
      CONN_ICON_LAB: process.env.CONN_ICON_LAB ?? "1",
      // The Tasks tab reads Orbit's fixtures (src/features/tasks/orbitTasksFixtures.ts) instead of a
      // Gateway. Dev builds only. EXPO_PUBLIC_CONN_TASKS_FIXTURE=0 shows the real "unavailable" state.
      EXPO_PUBLIC_CONN_TASKS_FIXTURE: process.env.EXPO_PUBLIC_CONN_TASKS_FIXTURE ?? "1",
    },
    Path.join(HOME, "metro.log"),
  );
  await waitForPort(metroPort, "Metro");
  log(`Metro on http://127.0.0.1:${metroPort}`);

  const write = () =>
    FS.writeFileSync(
      STATE_FILE,
      JSON.stringify(
        {
          pid: process.pid,
          serverPort,
          metroPort,
          serverPid: server?.pid ?? null,
          metroPid: metro?.pid ?? null,
          environmentId: environmentId(),
        } satisfies LabState,
        null,
        2,
      ),
    );
  write();
  console.log(JSON.stringify({ ready: true, ...readState() }));
  if (agentDevice) openInApp(readState()!, agentDevice, has("pair"), openOptions);

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log("Stopping server and Metro...");
    await stopGroup(metro);
    await stopGroup(server);
    FS.rmSync(STATE_FILE, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGUSR2", async () => {
    if (reseeding || stopping) return;
    reseeding = true;
    try {
      await stopGroup(server);
      seed();
      server = await startServer();
      await seedLive();
      write();
      log("Reseeded. The app picks the new data up on its own; pull to refresh if it does not.");
    } catch (error) {
      log(`Reseed failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      reseeding = false;
    }
  });
  server.once("exit", () => !stopping && !reseeding && log("The server exited."));
  await new Promise(() => {});
}

function openInApp(
  state: LabState,
  agentDevice: string | null,
  pair: boolean,
  options: { readonly udid: string | null; readonly keepCache: boolean },
) {
  const { keepCache } = options;
  const udid = options.udid ?? process.env.LAB_UDID ?? findLabSimulator();
  const environmentId = (() => {
    try {
      return FS.readFileSync(Path.join(HOME, "userdata", "environment-id"), "utf8").trim();
    } catch {
      return state.environmentId;
    }
  })();
  const devClient =
    `${SCHEME}://expo-development-client/?url=${encodeURIComponent(`http://127.0.0.1:${state.metroPort}`)}` +
    "&disableOnboarding=1&disableAutoLaunch=1&disableFab=1";
  const threadLink = `${SCHEME}://threads/${environmentId}/${PRIMARY_THREAD_ID}`;
  let pairLink: string | null = null;
  if (pair) {
    const output = run(
      "node",
      [
        "apps/server/src/bin.ts",
        "auth",
        "pairing",
        "create",
        "--base-dir",
        HOME,
        "--base-url",
        `http://127.0.0.1:${state.serverPort}`,
        "--ttl",
        "15m",
        "--label",
        "mobile-lab",
      ],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, T3CODE_PORT: String(state.serverPort), NO_COLOR: "1" },
      },
    );
    const pairingUrl = /^Pair URL: (.+)$/m.exec(`${output.stdout}\n${output.stderr}`)?.[1];
    if (!pairingUrl) throw new Error(`Could not mint a pairing credential: ${output.stderr}`);
    pairLink = `${SCHEME}://connections/new?${new URLSearchParams({ pairingUrl, autoConnect: "1" })}`;
  }
  const links = { devClient, pair: pairLink, thread: threadLink };
  if (!agentDevice) {
    console.log(JSON.stringify(links, null, 2));
    return;
  }
  // iOS asks "Open in T3 Code Dev?" for every custom-scheme link; accept it when it shows.
  if (!keepCache) clearAppCache(agentDevice, udid);
  const open = (link: string) => {
    run(agentDevice, ["open", BUNDLE_ID, link], { stdio: "inherit" });
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = run(agentDevice, ["alert", "accept"], { stdio: "pipe" });
      if (/accepted/.test(`${result.stdout}`)) break;
      spawnSyncSleep(1);
    }
  };
  open(devClient);
  // The first bundle takes a while; later opens only reload.
  spawnSyncSleep(Number(process.env.LAB_BUNDLE_WAIT ?? 45));
  if (pairLink) {
    open(pairLink);
    spawnSyncSleep(8);
  }
  open(threadLink);
}

function findLabSimulator(): string | null {
  const listed = run("xcrun", ["simctl", "list", "devices", "-j"]);
  try {
    const devices = Object.values(JSON.parse(String(listed.stdout)).devices).flat() as {
      name: string;
      udid: string;
    }[];
    return devices.find((device) => device.name === "conn-mobile-lab")?.udid ?? null;
  } catch {
    return null;
  }
}

/**
 * The app caches threads on disk by id, so an entry removed from the fixtures would linger.
 * Close the app and drop that cache (not the pairing) before opening it again.
 */
function clearAppCache(agentDevice: string, udid: string | null) {
  if (!udid) return log("No lab simulator found; skipping the app cache reset.");
  run(agentDevice, ["close", BUNDLE_ID], { stdio: "pipe" });
  spawnSyncSleep(2);
  const database = appDatabase(udid);
  if (!database) return;
  // The app is closed now: a phone with no theme choice yet wears Nick's Dark Mono.
  if (applyLabTheme(database, DEFAULT_LAB_THEME, { onlyIfUnset: true }))
    log(`Phone theme: ${DEFAULT_LAB_THEME}`);
  run("sqlite3", [
    database,
    "delete from client_cache where kind in ('thread','shell'); pragma wal_checkpoint(truncate);",
  ]);
}

function appDatabase(udid: string | null): string | null {
  if (!udid) return null;
  const container = String(
    run("xcrun", ["simctl", "get_app_container", udid, BUNDLE_ID, "data"]).stdout,
  ).trim();
  const database = Path.join(container, "Documents/SQLite/t3code-client.db");
  return container && FS.existsSync(database) ? database : null;
}

function spawnSyncSleep(seconds: number) {
  run("sleep", [String(seconds)]);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
