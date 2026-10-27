// @effect-diagnostics nodeBuiltinImport:off - exercises the real native runner and local HTTP collector.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

it("uses one machine hook across fresh worktrees without modifying Vite+", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "task-cache-hook-"));
  const unrelated = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "unrelated-project-"));
  const reports: { authorization: string | undefined; body: string }[] = [];
  let firstExit!: () => void;
  const firstExited = new Promise<void>((resolve) => {
    firstExit = resolve;
  });
  let completedReports = 0;
  let notified: (() => void) | undefined;
  let firstDisconnected = false;
  const report = (count: number) =>
    completedReports >= count
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          notified = resolve;
        });
  const server = NodeHttp.createServer(async (request, response) => {
    if (!request.url?.endsWith("/telemetry")) {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    reports.push({ authorization: request.headers.authorization, body });
    if (reports.length === 1) {
      await firstExited;
      firstDisconnected = response.destroyed;
    }
    response.writeHead(204).end();
    completedReports++;
    notified?.();
    notified = undefined;
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP address");
    const runner = NodePath.join(root, "vite-plus");
    const distribution = await NodeFSP.realpath(
      NodePath.resolve(import.meta.dirname, "../../../node_modules/vite-plus/dist"),
    );
    await NodeFSP.cp(distribution, NodePath.join(runner, "dist"), { recursive: true });
    await NodeFSP.copyFile(
      NodePath.join(distribution, "../package.json"),
      NodePath.join(runner, "package.json"),
    );
    await NodeFSP.symlink(
      NodePath.resolve(distribution, "../binding"),
      NodePath.join(runner, "binding"),
    );
    await NodeFSP.symlink(
      NodePath.resolve(distribution, "../.."),
      NodePath.join(runner, "node_modules"),
    );
    const entrypoint = NodePath.join(runner, "dist/bin.js");
    await NodeFSP.writeFile(
      NodePath.join(unrelated, "package.json"),
      JSON.stringify({ name: "unrelated", scripts: { build: 'node -e "console.log(7)"' } }),
    );
    const nested = NodePath.join(root, "nested");
    await NodeFSP.mkdir(nested);
    await NodeFSP.writeFile(
      NodePath.join(nested, "package.json"),
      JSON.stringify({ name: "nested", scripts: { build: 'node -e "console.log(8)"' } }),
    );
    await NodeFSP.writeFile(NodePath.join(nested, "pnpm-workspace.yaml"), "packages: []\n");
    const endpoint = `http://127.0.0.1:${address.port}/projects/test`;
    await NodeFSP.writeFile(NodePath.join(root, ".task-cache.json"), JSON.stringify({ endpoint }));
    await NodeFSP.writeFile(
      NodePath.join(root, "package.json"),
      JSON.stringify({
        name: "hook-fixture",
        private: true,
        scripts: {
          build: `node build.cjs ${JSON.stringify(entrypoint)} ${JSON.stringify(unrelated)}`,
          fail: 'node -e "process.exit(7)"',
          nested: `node ${JSON.stringify(entrypoint)} -C ${JSON.stringify(nested)} run --no-cache build`,
        },
      }),
    );
    await NodeFSP.writeFile(
      NodePath.join(root, "build.cjs"),
      'require("node:fs").writeFileSync("environment.json", JSON.stringify({url: process.env.VP_REMOTE_CACHE_URL ?? null, mode: process.env.VP_REMOTE_CACHE ?? null})); console.log(42); try {for (const cwd of process.argv.slice(3)) require("node:child_process").execFileSync(process.execPath, [process.argv[2], "run", "--no-cache", "build"], {cwd, encoding:"utf8"})} catch (error) { throw new Error(error.stdout + error.stderr) }',
    );
    await NodeFSP.writeFile(
      NodePath.join(root, "vite.config.ts"),
      `import { remoteCacheUrl } from ${JSON.stringify(new URL("./remoteCache.ts", import.meta.url).href)}; export default {run:{cache:{scripts:true,remote:{url:remoteCacheUrl(import.meta.dirname)}}}};`,
    );
    await NodeFSP.mkdir(NodePath.join(root, ".config/t3-task-cache"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(root, ".config/t3-task-cache/credentials.json"),
      JSON.stringify({ [endpoint]: { name: "maria", token: "secret" } }),
    );
    const configDirectory = NodePath.join(root, ".config/vite-plus");
    await NodeFSP.mkdir(configDirectory, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(configDirectory, "run-hook.json"),
      JSON.stringify({
        rootMarker: ".task-cache.json",
        module: NodePath.join(import.meta.dirname, "runHook.ts"),
      }),
    );
    const originalEntrypoint = await NodeFSP.readFile(entrypoint, "utf8");
    const run = (task: string, cwd = root, ci = false, cache = "--cache") =>
      new Promise<number | null>((resolve, reject) => {
        const child = NodeChildProcess.spawn(
          process.execPath,
          [entrypoint, "run", ...(task === "--last-details" ? [] : [cache]), task],
          {
            cwd,
            env: {
              ...process.env,
              HOME: root,
              GITHUB_ACTIONS: ci ? "true" : undefined,
              T3_TASK_CACHE_TELEMETRY: undefined,
              T3_TASK_CACHE_HOST: undefined,
              VITE_CACHE_PATH: undefined,
              ACTIONS_ID_TOKEN_REQUEST_URL: undefined,
              ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined,
              NODE_OPTIONS: `--import=${new URL("./preload.mjs", import.meta.url).href}`,
              VP_REMOTE_CACHE: undefined,
              VP_REMOTE_CACHE_URL: undefined,
            },
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) => {
          firstExit();
          if (code !== 0 && task !== "fail") reject(new Error(stderr));
          else resolve(code);
        });
      });
    expect(await run("build")).toBe(0);
    await report(1);
    expect(await run("--last-details")).toBe(0);
    expect(
      JSON.parse(await NodeFSP.readFile(NodePath.join(root, "environment.json"), "utf8")),
    ).toMatchObject({ url: null });
    expect(firstDisconnected).toBe(false);
    expect(await run("build")).toBe(0);
    await report(2);
    expect(await run("fail")).toBe(7);
    await report(3);
    const secondWorktree = NodePath.join(root, "second-worktree");
    await NodeFSP.mkdir(secondWorktree);
    for (const file of ["package.json", ".task-cache.json", "vite.config.ts", "build.cjs"])
      await NodeFSP.copyFile(NodePath.join(root, file), NodePath.join(secondWorktree, file));
    expect(await run("build", secondWorktree)).toBe(0);
    await report(4);
    expect(await run("build", secondWorktree, true)).toBe(0);
    await report(5);
    expect(await NodeFSP.readFile(entrypoint, "utf8")).toBe(originalEntrypoint);
    expect(await run("nested", root, false, "--no-cache")).toBe(0);
    expect(await run("build", nested)).toBe(0);
    expect(reports).toHaveLength(5);
    expect(
      reports.every(
        (report) =>
          report.authorization === `Basic ${Buffer.from("maria:secret").toString("base64")}`,
      ),
    ).toBe(true);
    const events = reports.map((report) => JSON.parse(report.body));
    expect(events[0].tasks[0].source).toBe("executed");
    expect(events[1].tasks[0].source).toBe("local");
    expect(events[3].tasks[0].source).toBe("executed");
    expect(new Set(events.map((event) => event.id)).size).toBe(5);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await NodeFSP.rm(root, { recursive: true, force: true });
    await NodeFSP.rm(unrelated, { recursive: true, force: true });
  }
});

it("rejects invalid setup credentials before installing anything and never prints the token", async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "task-cache-setup-"));
  const token = "private-credential-that-must-not-appear-in-output";
  const server = NodeHttp.createServer((_request, response) => response.writeHead(401).end());
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP address");
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = NodeChildProcess.spawn(
        process.execPath,
        [NodePath.join(import.meta.dirname, "../scripts/install.ts"), "--non-interactive"],
        {
          env: {
            ...process.env,
            HOME: home,
            T3_CACHE_SETUP_URL: `http://127.0.0.1:${address.port}/projects/test`,
            T3_CACHE_SETUP_NAME: "maria",
            T3_CACHE_SETUP_TOKEN: token,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, output }));
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("Credential verification failed (401)");
    expect(result.output).not.toContain(token);
    expect(await NodeFSP.readdir(home)).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
});

it("does not start telemetry or create local state without cache credentials", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "task-cache-unconfigured-"));
  try {
    await NodeFSP.writeFile(
      NodePath.join(root, ".task-cache.json"),
      JSON.stringify({ endpoint: "https://cache.invalid/projects/test" }),
    );
    const hook = new URL("./runHook.ts", import.meta.url).href;
    const output = await new Promise<string>((resolve, reject) => {
      const child = NodeChildProcess.spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import start from ${JSON.stringify(hook)}; const finish = start({ root: process.cwd() }); if (finish !== undefined) process.exit(1);`,
        ],
        {
          cwd: root,
          env: { ...process.env, HOME: root, VP_REMOTE_CACHE_URL: "" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? resolve(output) : reject(new Error(output || `Exited ${code}`)),
      );
    });
    expect(output).toBe("");
    expect(await NodeFSP.readdir(root)).toEqual([".task-cache.json"]);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("installs without masking .profile and configures CI through bash", async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "task-cache-login-"));
  const server = NodeHttp.createServer((_request, response) => response.writeHead(204).end());
  const run = (args: string[], env: NodeJS.ProcessEnv) =>
    new Promise<string>((resolve, reject) => {
      const child = NodeChildProcess.spawn(args[0]!, args.slice(1), {
        env: { ...process.env, ...env, HOME: home, NODE_OPTIONS: "" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => (code === 0 ? resolve(output) : reject(new Error(output))));
    });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP address");
    await NodeFSP.writeFile(NodePath.join(home, ".profile"), "export EXISTING_PROFILE=preserved\n");
    await NodeFSP.mkdir(NodePath.join(home, ".config/t3-task-cache"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(home, ".config/t3-task-cache/credentials.json"),
      "{partial",
    );
    await run(
      [
        process.execPath,
        NodePath.join(import.meta.dirname, "../scripts/install.ts"),
        "--non-interactive",
      ],
      {
        T3_CACHE_SETUP_URL: `http://127.0.0.1:${address.port}/projects/test`,
        T3_CACHE_SETUP_NAME: "maria",
        T3_CACHE_SETUP_TOKEN: "test-credential-for-isolated-http-server",
      },
    );
    expect(await NodeFSP.readdir(home)).not.toContain(".bash_profile");
    expect(await NodeFSP.readFile(NodePath.join(home, ".profile"), "utf8")).toContain(
      "EXISTING_PROFILE=preserved",
    );
    const githubEnv = NodePath.join(home, "github-env");
    await run([process.execPath, NodePath.join(import.meta.dirname, "../scripts/install-ci.ts")], {
      T3_TASK_CACHE_READ_TOKEN: "read-only-fixture-token-01234567890123456789",
      GITHUB_REPOSITORY: "pingdotgg/t3code",
      GITHUB_ACTIONS: "true",
      GITHUB_ENV: githubEnv,
      RUNNER_TEMP: home,
    });
    const values = await NodeFSP.readFile(githubEnv, "utf8");
    expect(values).not.toContain("\nNODE_OPTIONS=");
    const bashEnv = values
      .split("\n")
      .find((line) => line.startsWith("BASH_ENV="))
      ?.slice(9);
    const output = await run(["bash", "-c", 'printf "%s" "$NODE_OPTIONS"'], { BASH_ENV: bashEnv });
    expect(output).toContain("--import=file:");
    expect(output).toContain("/infra/task-cache/src/preload.mjs");
    await NodeFSP.rm(NodePath.join(home, ".local/share/t3-task-cache/preload.mjs"));
    const missing = await run(["bash", "-c", `node -e 'console.log("missing preload is safe")'`], {
      BASH_ENV: NodePath.join(home, ".config/t3-task-cache/env"),
    });
    expect(missing).toContain("missing preload is safe");

    await NodeFSP.writeFile(
      NodePath.join(home, ".bash_profile"),
      '. "$HOME/.config/t3-task-cache/env"\n',
    );
    await run(
      [
        process.execPath,
        NodePath.join(import.meta.dirname, "../scripts/install.ts"),
        "--uninstall",
      ],
      {},
    );
    expect(await NodeFSP.readdir(home)).not.toContain(".bash_profile");
    expect(await NodeFSP.readdir(NodePath.join(home, ".local/share/t3-task-cache"))).toEqual([
      "preload.mjs",
    ]);
    expect(await NodeFSP.readFile(NodePath.join(home, ".profile"), "utf8")).not.toContain(
      "t3-task-cache/env",
    );
    expect(await NodeFSP.readdir(NodePath.join(home, ".config/t3-task-cache"))).not.toContain(
      "credentials.json",
    );
    const remaining = await run(
      [
        process.execPath,
        "--import",
        NodePath.join(home, ".local/share/t3-task-cache/preload.mjs"),
        "-e",
        'console.log("node survives uninstall")',
      ],
      {},
    );
    expect(remaining).toContain("node survives uninstall");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
});

it("does not send an old endpoint's token after changing the URL interactively", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "task-cache-endpoint-"));
  const requests: string[] = [];
  const server = NodeHttp.createServer((request, response) => {
    requests.push(request.headers.authorization || "");
    response.writeHead(401).end();
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP address");
    const nested = NodePath.join(root, "nested");
    await NodeFSP.mkdir(nested);
    await NodeFSP.writeFile(
      NodePath.join(nested, "package.json"),
      JSON.stringify({ name: "nested", scripts: { build: 'node -e "console.log(8)"' } }),
    );
    await NodeFSP.writeFile(NodePath.join(nested, "pnpm-workspace.yaml"), "packages: []\n");
    const endpoint = `http://127.0.0.1:${address.port}/projects/test`;
    const scripts = NodePath.join(root, "infra/task-cache/scripts");
    await NodeFSP.mkdir(scripts, { recursive: true });
    await NodeFSP.mkdir(NodePath.join(root, "infra/task-cache/src"));
    await NodeFSP.writeFile(NodePath.join(root, "package.json"), '{"type":"module"}');
    await NodeFSP.writeFile(NodePath.join(root, ".task-cache.json"), JSON.stringify({ endpoint }));
    await NodeFSP.copyFile(
      NodePath.join(import.meta.dirname, "../scripts/install.ts"),
      NodePath.join(scripts, "install.ts"),
    );
    await NodeFSP.copyFile(
      NodePath.join(import.meta.dirname, "nativeHook.js"),
      NodePath.join(root, "infra/task-cache/src/nativeHook.js"),
    );
    await NodeFSP.mkdir(NodePath.join(root, ".config/t3-task-cache"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(root, ".config/t3-task-cache/credentials.json"),
      JSON.stringify({
        [endpoint]: { name: "maria", token: "different-saved-endpoint-credential" },
      }),
    );
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = NodeChildProcess.spawn(
        process.execPath,
        [NodePath.join(scripts, "install.ts")],
        {
          env: {
            ...process.env,
            HOME: root,
            NODE_OPTIONS: "",
            T3_CACHE_SETUP_URL: "https://old.example",
            T3_CACHE_SETUP_NAME: "maria",
            T3_CACHE_SETUP_TOKEN: "old-endpoint-token-must-not-be-forwarded",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let output = "";
      let sentUrl = false;
      let sentName = false;
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (!sentUrl && output.includes("Cache URL")) {
          sentUrl = true;
          child.stdin.write(endpoint + "\n");
        }
        if (!sentName && output.includes("Developer name")) {
          sentName = true;
          child.stdin.write("\n");
        }
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, output }));
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("Use T3_CACHE_SETUP_TOKEN");
    expect(requests).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("rejects non-loopback HTTP before transmitting a setup credential", async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "task-cache-http-"));
  try {
    const output = await new Promise<string>((resolve) => {
      NodeChildProcess.execFile(
        process.execPath,
        [NodePath.join(import.meta.dirname, "../scripts/install.ts"), "--non-interactive"],
        {
          env: {
            ...process.env,
            HOME: home,
            NODE_OPTIONS: "",
            T3_CACHE_SETUP_URL: "http://cache.invalid/projects/test",
            T3_CACHE_SETUP_NAME: "maria",
            T3_CACHE_SETUP_TOKEN: "test-credential-that-must-not-be-transmitted",
          },
        },
        (_error, stdout, stderr) => resolve(stdout + stderr),
      );
    });
    expect(output).toContain("Use an HTTPS cache endpoint");
    expect(await NodeFSP.readdir(home)).toEqual([]);
  } finally {
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
});
