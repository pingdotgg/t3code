import { describe, expect, it } from "vite-plus/test";

import { createEngine, type EngineConfig, type Question } from "./engine";
import { runtimeSupportsClient } from "./runtimeCompatibility";
import { createLinuxHost, type ProcessRunner, type RunResult } from "./wslEngine";

const NO_CONFIG: EngineConfig = {
  engineUrl: undefined,
  envToken: undefined,
  t3Home: undefined,
  t3Cli: undefined,
  distro: undefined,
};
const RUNTIME_FILE_READ = `cat "$T3_HOME/userdata/server-runtime.json"`;
const CURRENT = "0.1.10";
const OLD = "0.0.30";

const ok = (stdout = ""): RunResult => ({ exitCode: 0, stdout, stderr: "" });

interface RuntimeFile {
  readonly pid: number;
  readonly origin: string;
}

/** A distro that answers the way wsl.exe does, and records what the app asked of it. */
class FakeWsl {
  runtimeFile: RuntimeFile | null = null;
  readonly alive = new Set<number>();
  readonly liveOrigins = new Map<string, string>();
  readonly acceptedTokens = new Set<string>();
  hasT3 = true;
  t3Version = CURRENT;
  rejectEveryToken = false;
  readonly serviceEngine: RuntimeFile = { pid: 7001, origin: "http://127.0.0.1:3773" };
  mints = 0;
  installs = 0;
  serviceInstalls = 0;
  updates = 0;
  readonly scripts: string[] = [];
  readonly kills: string[] = [];
  readonly commands: string[][] = [];

  readonly runner: ProcessRunner = {
    run: async (command, args, options) => {
      expect(command).toBe("wsl.exe");
      const argv = args.slice(args.indexOf("--exec") + 1);
      this.commands.push(argv);
      const [program = ""] = argv;
      if (program === "bash") return ok("resolvedPath:/fake/login/bin\n");
      if (program === "test") {
        return {
          ...ok(),
          exitCode: this.alive.has(Number((argv[2] ?? "").split("/").pop())) ? 0 : 1,
        };
      }
      if (program === "kill") {
        this.kills.push(argv.slice(1).join(" "));
        return ok();
      }
      const script = options.stdin ?? "";
      this.scripts.push(script);
      if (script.includes("service install")) {
        this.serviceInstalls += 1;
        this.serve(this.serviceEngine, this.t3Version);
        return ok();
      }
      if (script.includes("update --yes")) {
        this.updates += 1;
        this.t3Version = CURRENT;
        for (const origin of this.liveOrigins.keys()) this.liveOrigins.set(origin, CURRENT);
        return ok();
      }
      if (script.includes("install.sh")) {
        this.installs += 1;
        this.hasT3 = true;
        this.t3Version = CURRENT;
        return ok();
      }
      if (script.includes("auth session issue")) {
        this.mints += 1;
        this.acceptedTokens.add(`token-${this.mints}`);
        return ok(`token-${this.mints}\n`);
      }
      if (script.includes("command -v t3")) {
        return ok(this.hasT3 ? `cli:t3|t3 v${this.t3Version}\n` : "");
      }
      if (script.includes(RUNTIME_FILE_READ)) {
        return ok(this.runtimeFile === null ? "" : JSON.stringify(this.runtimeFile));
      }
      throw new Error(`Unexpected script: ${script}`);
    },
    start: () => {
      throw new Error("The app must not start a long-lived process through the runner.");
    },
  };

  readonly fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const version = this.liveOrigins.get(new URL(url).origin);
    if (version === undefined) throw new TypeError("connect ECONNREFUSED");
    if (url.endsWith("/.well-known/t3/environment")) {
      return Response.json({ environmentId: "environment-1", serverVersion: version });
    }
    const bearer = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
    return Response.json({
      authenticated: !this.rejectEveryToken && this.acceptedTokens.has(bearer),
    });
  };

  /** Makes an engine run in the distro and returns its origin. */
  serve(
    engine: RuntimeFile = { pid: 9001, origin: "http://127.0.0.1:3774" },
    version = CURRENT,
  ): string {
    this.runtimeFile = engine;
    this.alive.add(engine.pid);
    this.liveOrigins.set(engine.origin, version);
    return engine.origin;
  }
}

function setup(
  config: Partial<EngineConfig> = {},
  answers: Partial<Record<Question, boolean>> = {},
) {
  const wsl = new FakeWsl();
  const tokenStore = new Map<string, string>();
  const asked: Question[] = [];
  const engine = createEngine({
    config: { ...NO_CONFIG, ...config },
    host: createLinuxHost({ platform: "win32", distro: null, runner: wsl.runner }),
    runtimeCompatible: runtimeSupportsClient,
    fetch: wsl.fetch,
    tokens: {
      read: (key) => tokenStore.get(key) ?? null,
      write: (key, token) => void tokenStore.set(key, token),
    },
    confirm: async (question) => {
      asked.push(question);
      return answers[question] ?? false;
    },
    log: () => undefined,
    sleep: () => Promise.resolve(),
  });
  return { wsl, engine, tokenStore, asked };
}

describe("engine discovery", () => {
  it("Given AGENT_BOARD_ENGINE_URL, when the app starts, then it uses that engine and never asks WSL", async () => {
    const { wsl, engine } = setup({ engineUrl: "http://127.0.0.1:4100/ignored/path" });
    wsl.serve();
    wsl.liveOrigins.set("http://127.0.0.1:4100", CURRENT);

    await engine.start();

    expect(engine.state()).toEqual({
      phase: "ready",
      origin: "http://127.0.0.1:4100",
      source: "url",
    });
    expect(wsl.commands).toEqual([]);
  });

  it("Given a live server-runtime.json, when the app starts, then it joins and starts nothing", async () => {
    const { wsl, engine } = setup();
    const origin = wsl.serve();

    await engine.start();

    expect(engine.state()).toEqual({ phase: "ready", origin, source: "service" });
    expect(wsl.serviceInstalls).toBe(0);
    expect(wsl.kills).toEqual([]);
  });

  it("Given a server-runtime.json whose pid is dead, when the app starts, then it asks T3 to start its service and joins it", async () => {
    const { wsl, engine } = setup();
    wsl.runtimeFile = { pid: 1234, origin: "http://127.0.0.1:3773" };

    await engine.start();

    expect(wsl.serviceInstalls).toBe(1);
    expect(engine.state()).toEqual({
      phase: "ready",
      origin: wsl.serviceEngine.origin,
      source: "service",
    });
    expect(wsl.kills).toEqual([]);
  });

  it("Given AGENT_BOARD_T3_HOME, when the app starts the service, then every command targets that folder", async () => {
    const { wsl, engine } = setup({ t3Home: "/tmp/board-lane/t3" });

    await engine.start();

    const install = wsl.scripts.find((script) => script.includes("service install"));
    expect(install).toContain(`T3_HOME='/tmp/board-lane/t3'`);
    expect(install).toContain(`service install --base-dir "$T3_HOME"`);
  });

  it("Given a compatible t3, when the app starts, then it runs t3 from the login PATH", async () => {
    const { wsl, engine } = setup();

    await engine.start();

    const discovery = wsl.scripts.find((script) => script.includes("command -v t3"));
    expect(discovery).toContain(
      "export PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/fake/login/bin'",
    );
  });

  it("Given the app runs under its dev server, when it runs any T3 command, then the dev flag cannot reach T3", async () => {
    const { wsl, engine } = setup();

    await engine.start();

    const withT3 = wsl.scripts.filter((script) => script.includes("T3_HOME="));
    expect(withT3.length).toBeGreaterThan(0);
    for (const script of withT3) expect(script).toContain("unset VITE_DEV_SERVER_URL\n");
  });
});

describe("engine install", () => {
  it("Given WSL has no T3, when the user declines, then the app is offline and installs nothing", async () => {
    const { wsl, engine, asked } = setup({}, { install: false });
    wsl.hasT3 = false;

    await engine.start();

    expect(asked).toEqual(["install"]);
    expect(wsl.installs).toBe(0);
    expect(engine.state()).toEqual({
      phase: "offline",
      reason: "T3 is not installed in WSL. Installing it was declined.",
    });
  });

  it("Given WSL has no T3, when the user accepts, then the app installs T3, installs its service, and joins", async () => {
    const { wsl, engine, asked } = setup({}, { install: true });
    wsl.hasT3 = false;

    await engine.start();

    expect(asked).toEqual(["install"]);
    expect(wsl.installs).toBe(1);
    expect(wsl.serviceInstalls).toBe(1);
    expect(engine.state()).toMatchObject({ phase: "ready" });
  });
});

describe("engine update", () => {
  it("Given only an old t3, when the user declines the update, then the app is offline with the found version and changes nothing", async () => {
    const { wsl, engine, asked } = setup({}, { update: false });
    wsl.t3Version = OLD;

    await engine.start();

    expect(asked).toEqual(["update"]);
    expect(wsl.updates).toBe(0);
    expect(wsl.serviceInstalls).toBe(0);
    expect(engine.state()).toEqual({
      phase: "offline",
      reason: "T3 in WSL is 0.0.30, which is too old for this app. Updating was declined.",
    });
  });

  it("Given only an old t3, when the user accepts, then the app runs t3 update, starts the service, and joins", async () => {
    const { wsl, engine } = setup({}, { update: true });
    wsl.t3Version = OLD;

    await engine.start();

    expect(wsl.updates).toBe(1);
    expect(wsl.serviceInstalls).toBe(1);
    expect(engine.state()).toMatchObject({ phase: "ready" });
  });

  it("Given an old engine someone else runs, when the user declines the update, then the app never stops that engine", async () => {
    const { wsl, engine, asked } = setup({}, { update: false });
    const origin = wsl.serve(undefined, OLD);

    await engine.start();

    expect(asked).toEqual(["update"]);
    expect(engine.state()).toMatchObject({ phase: "offline" });
    expect(wsl.kills).toEqual([]);
    expect(wsl.alive.has(9001)).toBe(true);
    expect(wsl.liveOrigins.has(origin)).toBe(true);
  });
});

describe("engine token", () => {
  const joined = async () => {
    const harness = setup();
    harness.wsl.serve();
    await harness.engine.start();
    return harness;
  };

  it("Given no saved token, when asked, then it issues one, saves it, and reuses it", async () => {
    const { wsl, engine, tokenStore } = await joined();

    const first = await engine.token();
    const second = await engine.token();

    expect(first).toEqual({ ok: true, token: "token-1" });
    expect(second).toEqual({ ok: true, token: "token-1" });
    expect(wsl.mints).toBe(1);
    expect([...tokenStore.values()]).toEqual(["token-1"]);
  });

  it("Given a saved token the engine rejects, when asked, then it reissues exactly once and uses the new token", async () => {
    const { wsl, engine, tokenStore } = await joined();
    tokenStore.set("default:home:~/.t3", "revoked");

    const result = await engine.token();

    expect(result).toEqual({ ok: true, token: "token-1" });
    expect(wsl.mints).toBe(1);
    expect(tokenStore.get("default:home:~/.t3")).toBe("token-1");
  });

  it("Given the engine also rejects the reissued token, when asked, then it reports auth_failed after one reissue", async () => {
    const { wsl, engine, tokenStore } = await joined();
    tokenStore.set("default:home:~/.t3", "revoked");
    wsl.rejectEveryToken = true;

    const result = await engine.token();

    expect(result).toMatchObject({ ok: false, error: "auth_failed" });
    expect(wsl.mints).toBe(1);
  });

  it("Given AGENT_BOARD_TOKEN, when the engine accepts it, then no token is issued", async () => {
    const harness = setup({ engineUrl: "http://127.0.0.1:4100", envToken: "from-env" });
    harness.wsl.liveOrigins.set("http://127.0.0.1:4100", CURRENT);
    harness.wsl.acceptedTokens.add("from-env");
    await harness.engine.start();

    const result = await harness.engine.token();

    expect(result).toEqual({ ok: true, token: "from-env" });
    expect(harness.wsl.mints).toBe(0);
  });
});
