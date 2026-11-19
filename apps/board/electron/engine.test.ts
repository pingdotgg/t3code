import { describe, expect, it } from "vite-plus/test";

import { createEngine, type EngineConfig } from "./engine";
import { createLinuxHost, type ProcessRunner, type RunResult } from "./wslEngine";

const NO_CONFIG: EngineConfig = {
  engineUrl: undefined,
  envToken: undefined,
  t3Home: undefined,
  t3Cli: undefined,
};
const RUNTIME_FILE_READ = `cat "$T3_HOME/userdata/server-runtime.json"`;

const ok = (stdout = ""): RunResult => ({ exitCode: 0, stdout, stderr: "" });

interface RuntimeFile {
  readonly pid: number;
  readonly origin: string;
}

/** A distro that answers the way wsl.exe does, and records what the app asked of it. */
class FakeWsl {
  runtimeFile: RuntimeFile | null = null;
  readonly alive = new Set<number>();
  readonly liveOrigins = new Set<string>();
  readonly acceptedTokens = new Set<string>();
  hasT3 = true;
  rejectEveryToken = false;
  stagedRuntime: string | null = null;
  readonly bootPid = 4242;
  readonly bootOrigin = "http://127.0.0.1:3901";
  /** When set, the booted engine exits at once with this code, as if another engine owned the folder. */
  bootExitCode: number | null = null;
  rival: RuntimeFile | null = null;
  mints = 0;
  installs = 0;
  readonly starts: string[] = [];
  readonly kills: string[] = [];
  readonly commands: string[][] = [];
  readonly exit = Promise.withResolvers<number | null>();

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
        if (argv[1] === "-TERM") this.exit.resolve(143);
        return ok();
      }
      const script = options.stdin ?? "";
      if (script.includes("grep -q")) {
        if (!this.alive.has(this.bootPid)) return { exitCode: 2, stdout: "", stderr: "" };
        this.runtimeFile = { pid: this.bootPid, origin: this.bootOrigin };
        this.liveOrigins.add(this.bootOrigin);
        return ok(JSON.stringify(this.runtimeFile));
      }
      if (script.includes(RUNTIME_FILE_READ)) {
        return ok(this.runtimeFile === null ? "" : JSON.stringify(this.runtimeFile));
      }
      if (script.includes("command -v t3")) {
        if (this.hasT3) return ok("cli:t3\n");
        return ok(this.stagedRuntime === null ? "" : `node:${this.stagedRuntime}\n`);
      }
      if (script.includes("auth session issue")) {
        this.mints += 1;
        this.acceptedTokens.add(`token-${this.mints}`);
        return ok(`token-${this.mints}\n`);
      }
      if (script.includes("install.sh")) {
        this.installs += 1;
        this.hasT3 = true;
        return ok();
      }
      throw new Error(`Unexpected script: ${script}`);
    },
    start: (command, args, options) => {
      expect(command).toBe("wsl.exe");
      expect(args).toContain("sh");
      this.starts.push(options.stdin ?? "");
      this.alive.add(this.bootPid);
      if (this.bootExitCode !== null) {
        this.alive.delete(this.bootPid);
        if (this.rival !== null) this.serve(this.rival);
        this.exit.resolve(this.bootExitCode);
      }
      return {
        firstLine: Promise.resolve(`pid:${this.bootPid}`),
        output: () => "engine output",
        exited: this.exit.promise,
        kill: () => undefined,
      };
    },
  };

  readonly fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    if (!this.liveOrigins.has(new URL(url).origin)) throw new TypeError("connect ECONNREFUSED");
    if (url.endsWith("/.well-known/t3/environment")) {
      return Response.json({ environmentId: "environment-1" });
    }
    const bearer = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
    return Response.json({
      authenticated: !this.rejectEveryToken && this.acceptedTokens.has(bearer),
    });
  };

  /** Makes an engine run in the distro and returns its origin. */
  serve(engine: RuntimeFile = { pid: 9001, origin: "http://127.0.0.1:3773" }): string {
    this.runtimeFile = engine;
    this.alive.add(engine.pid);
    this.liveOrigins.add(engine.origin);
    return engine.origin;
  }
}

function setup(config: Partial<EngineConfig> = {}, install = false) {
  const wsl = new FakeWsl();
  const tokenStore = new Map<string, string>();
  const installQuestions: number[] = [];
  const engine = createEngine({
    config: { ...NO_CONFIG, ...config },
    host: createLinuxHost({ platform: "win32", distro: null, runner: wsl.runner }),
    fetch: wsl.fetch,
    tokens: {
      read: (key) => tokenStore.get(key) ?? null,
      write: (key, token) => void tokenStore.set(key, token),
    },
    confirmInstall: async () => {
      installQuestions.push(1);
      return install;
    },
    log: () => undefined,
    sleep: () => Promise.resolve(),
  });
  return { wsl, engine, tokenStore, installQuestions };
}

describe("engine discovery", () => {
  it("Given AGENT_BOARD_ENGINE_URL, when the app starts, then it uses that engine and never asks WSL", async () => {
    const { wsl, engine } = setup({ engineUrl: "http://127.0.0.1:4100/ignored/path" });
    wsl.serve();
    wsl.liveOrigins.add("http://127.0.0.1:4100");

    await engine.start();

    expect(engine.state()).toEqual({
      phase: "ready",
      route: "env",
      origin: "http://127.0.0.1:4100",
    });
    expect(wsl.commands).toEqual([]);
    expect(wsl.starts).toEqual([]);
  });

  it("Given a live server-runtime.json, when the app starts, then it joins that engine and boots nothing", async () => {
    const { wsl, engine } = setup();
    const origin = wsl.serve();

    await engine.start();

    expect(engine.state()).toEqual({ phase: "ready", route: "joined", origin });
    expect(wsl.starts).toEqual([]);
  });

  it("Given a server-runtime.json whose pid is dead, when the app starts, then it boots its own engine", async () => {
    const { wsl, engine } = setup();
    wsl.runtimeFile = { pid: 1234, origin: "http://127.0.0.1:3773" };
    wsl.liveOrigins.add("http://127.0.0.1:3773");

    await engine.start();

    expect(engine.state()).toEqual({ phase: "ready", route: "booted", origin: wsl.bootOrigin });
    expect(wsl.starts).toHaveLength(1);
    expect(wsl.starts[0]).toContain("serve --no-browser");
    expect(wsl.starts[0]).toContain(
      "export PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/fake/login/bin'",
    );
  });

  it("Given no live engine and no t3 on PATH, when the app starts, then it boots the newest staged runtime", async () => {
    const { wsl, engine } = setup();
    wsl.hasT3 = false;
    wsl.stagedRuntime = "/home/u/.t3/wsl-runtime/0.0.30/apps/server/dist/bin.mjs";

    await engine.start();

    expect(engine.state()).toMatchObject({ phase: "ready", route: "booted" });
    expect(wsl.starts[0]).toContain(`exec node '${wsl.stagedRuntime}' serve`);
  });

  it("Given AGENT_BOARD_T3_HOME, when the app joins or boots, then every command targets that folder", async () => {
    const { wsl, engine } = setup({ t3Home: "/tmp/board-lane-2/t3" });

    await engine.start();

    expect(wsl.starts[0]).toContain(`T3_HOME='/tmp/board-lane-2/t3'`);
    expect(wsl.starts[0]).toContain(`--base-dir "$T3_HOME"`);
  });

  it("Given another engine took the state folder first, when the boot exits as owned, then the app joins it", async () => {
    const { wsl, engine } = setup();
    wsl.bootExitCode = 78;
    wsl.rival = { pid: 9001, origin: "http://127.0.0.1:3773" };

    await engine.start();

    expect(engine.state()).toEqual({ phase: "ready", route: "joined", origin: wsl.rival.origin });
  });
});

describe("engine ownership", () => {
  it("Given a booted engine, when the app stops, then it terminates exactly that process and waits for it", async () => {
    const { wsl, engine } = setup();
    await engine.start();

    await engine.stop();

    expect(wsl.kills).toEqual([`-TERM ${wsl.bootPid}`]);
  });

  it("Given a joined engine, when the app stops, then it leaves the engine running", async () => {
    const { wsl, engine } = setup();
    wsl.serve();
    await engine.start();

    await engine.stop();

    expect(wsl.kills).toEqual([]);
    expect(wsl.alive.has(9001)).toBe(true);
  });
});

describe("engine install", () => {
  it("Given WSL has no T3, when the user declines, then the app is offline with a reason and installs nothing", async () => {
    const { wsl, engine, installQuestions } = setup({}, false);
    wsl.hasT3 = false;

    await engine.start();

    expect(installQuestions).toHaveLength(1);
    expect(wsl.installs).toBe(0);
    expect(engine.state()).toEqual({
      phase: "offline",
      reason: "T3 is not installed in WSL, and installing it was declined.",
    });
  });

  it("Given WSL has no T3, when the user accepts, then the app installs once and boots", async () => {
    const { wsl, engine, installQuestions } = setup({}, true);
    wsl.hasT3 = false;

    await engine.start();

    expect(installQuestions).toHaveLength(1);
    expect(wsl.installs).toBe(1);
    expect(engine.state()).toMatchObject({ phase: "ready", route: "booted" });
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
    tokenStore.set("home:~/.t3", "revoked");

    const result = await engine.token();

    expect(result).toEqual({ ok: true, token: "token-1" });
    expect(wsl.mints).toBe(1);
    expect(tokenStore.get("home:~/.t3")).toBe("token-1");
  });

  it("Given the engine also rejects the reissued token, when asked, then it reports auth_failed after one reissue", async () => {
    const { wsl, engine, tokenStore } = await joined();
    tokenStore.set("home:~/.t3", "revoked");
    wsl.rejectEveryToken = true;

    const result = await engine.token();

    expect(result).toMatchObject({ ok: false, error: "auth_failed" });
    expect(wsl.mints).toBe(1);
  });

  it("Given AGENT_BOARD_TOKEN, when the engine accepts it, then no token is issued", async () => {
    const harness = setup({ engineUrl: "http://127.0.0.1:4100", envToken: "from-env" });
    harness.wsl.liveOrigins.add("http://127.0.0.1:4100");
    harness.wsl.acceptedTokens.add("from-env");
    await harness.engine.start();

    const result = await harness.engine.token();

    expect(result).toEqual({ ok: true, token: "from-env" });
    expect(harness.wsl.mints).toBe(0);
  });
});
