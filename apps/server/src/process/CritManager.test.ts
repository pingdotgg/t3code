// @effect-diagnostics nodeBuiltinImport:off - drives a real fake CLI process and loopback health server.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { CheckpointRef, ThreadId, type CritOpenInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { afterEach, it } from "@effect/vitest";
import { createCritManager } from "./CritManager.ts";

const decodeArguments = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const decodeForwardRoute = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ port: Schema.Number })),
);
const decodeEnvironment = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      ghRepo: Schema.optional(Schema.String),
      home: Schema.String,
    }),
  ),
);
const fixtures: Array<() => Promise<void>> = [];

async function tailnetFixture(
  options: {
    readonly failForward?: boolean;
    readonly requireSudo?: boolean;
  } = {},
): Promise<{
  readonly directory: string;
  readonly manager: ReturnType<typeof createCritManager>;
  readonly forwardClosed: Promise<void>;
  readonly browserConnected: Promise<void>;
  readonly existingConfig: string;
}> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-crit-tailnet-test-"));
  fixtures.push(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  let notifyClosed: () => void = () => undefined;
  const forwardClosed = new Promise<void>((resolve) => {
    notifyClosed = resolve;
  });
  let notifyConnected: () => void = () => undefined;
  const browserConnected = new Promise<void>((resolve) => {
    notifyConnected = resolve;
  });
  const control = NodeHttp.createServer((request, response) => {
    if (request.url === "/connected") notifyConnected();
    else notifyClosed();
    response.end("ok");
  });
  await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
  fixtures.push(() => new Promise<void>((resolve) => control.close(() => resolve())));
  const address = control.address();
  NodeAssert.ok(address && typeof address !== "string");
  const closedUrl = `http://127.0.0.1:${address.port}/closed`;
  const command = NodePath.join(directory, "crit");
  const tailscaleCommand = NodePath.join(directory, "tailscale");
  const sudoCommand = NodePath.join(directory, "sudo");
  const configPath = NodePath.join(directory, "serve.json");
  const existingConfig = JSON.stringify({
    TCP: { "443": { HTTPS: true } },
    Foreground: { existing: { TCP: { "8443": { HTTPS: true } } } },
  });
  await NodeFSP.writeFile(configPath, existingConfig);
  await Promise.all([
    NodeFSP.writeFile(
      command,
      `#!${process.execPath}
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
if (args.includes('stop')) process.exit(0);
if (args.includes('status')) {
  process.stdout.write(fs.readFileSync(path.join(process.env.HOME, 'status.json')));
  process.exit(0);
}
fs.writeFileSync(path.join(process.env.HOME, 'status.json'), JSON.stringify({ sessions: [{ port }] }));
fs.writeFileSync(${encodeJsonString(NodePath.join(directory, "review-home"))}, process.env.HOME);
let connected = false;
let reportedConnection = false;
const server = http.createServer((req, res) => {
  if (req.url === '/api/health') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', browser_clients: connected }));
    if (connected && !reportedConnection) {
      reportedConnection = true;
      fetch(${encodeJsonString(`http://127.0.0.1:${address.port}/connected`)}, { method: 'POST' });
    }
    return;
  }
  connected = req.url !== '/close';
  res.end('Crit review');
});
server.listen(port, '127.0.0.1', () => {
  process.stderr.write('Started crit daemon at ' + args[args.indexOf('--public-url') + 1] + ' (session test)\\n');
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`,
      { mode: 0o755 },
    ),
    NodeFSP.writeFile(
      tailscaleCommand,
      `#!${process.execPath}
const fs = require('node:fs');
const http = require('node:http');
const args = process.argv.slice(2);
if (args[0] === 'status') {
  process.stdout.write(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'dev.tail123.ts.net.' } }));
  process.exit(0);
}
if (args[1] === 'status') {
  process.stdout.write(fs.readFileSync(${encodeJsonString(configPath)}));
  process.exit(0);
}
if (${String(options.requireSudo ?? false)} && !process.env.T3_CRIT_TEST_ELEVATED) {
  process.stderr.write('sending serve config: 401 Unauthorized: must be root\\n');
  process.exit(1);
}
if (${String(options.failForward ?? false)}) process.exit(1);
if (args.includes('--bg') || args.includes('off') || args.includes('reset') || args[0] !== 'serve') process.exit(2);
const port = Number(args.find(arg => arg.startsWith('--https=')).split('=')[1]);
const target = args.at(-1);
const route = ${encodeJsonString(directory)} + '/route-' + port;
const server = http.createServer((req, res) => {
  const upstream = http.request(target + req.url, { method: req.method }, response => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  upstream.on('error', () => { res.statusCode = 502; res.end(); });
  req.pipe(upstream);
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(route, JSON.stringify({ port: server.address().port }));
  process.stdout.write('Available within your tailnet:\\n\\nhttps://dev.tail123.ts.net:' + port + '/\\n');
});
process.on('SIGTERM', () => server.close(() => {
  fs.unlinkSync(route);
  fetch(${encodeJsonString(closedUrl)}, { method: 'POST' }).then(() => process.exit(0));
}));
`,
      { mode: 0o755 },
    ),
    NodeFSP.writeFile(
      sudoCommand,
      `#!${process.execPath}
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] !== '-n' || args[1] !== '--') process.exit(2);
const child = spawn(args[2], args.slice(3), { stdio: 'inherit', env: { ...process.env, T3_CRIT_TEST_ELEVATED: '1' } });
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', code => process.exit(code ?? 0));
`,
      { mode: 0o755 },
    ),
  ]);
  const manager = createCritManager({
    command,
    tailscaleCommand,
    sudoCommand,
    outputDir: directory,
    browserCheckIntervalMs: 10,
    browserDisconnectGraceMs: 0,
  });
  fixtures.push(() => manager.dispose());
  return { directory, manager, forwardClosed, browserConnected, existingConfig };
}
afterEach(async () => {
  for (const cleanup of fixtures.splice(0).toReversed()) await cleanup();
});

it.effect.each(["browser disconnect", "one-hour lifetime"] as const)(
  "opens the selected scope and stops only its CLI after %s",
  (stopReason) =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-crit-test-")),
      );
      fixtures.push(() => NodeFSP.rm(directory, { recursive: true, force: true }));
      let healthRequests = 0;
      let stopCommands = 0;
      let stopHome: string | undefined;
      let notifyStop: (args: ReadonlyArray<string>) => void = () => undefined;
      const stopped = new Promise<ReadonlyArray<string>>((resolve) => {
        notifyStop = resolve;
      });
      const server = NodeHttp.createServer((request, response) => {
        if (request.url === "/api/health") {
          healthRequests += 1;
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              status: "ok",
              browser_clients: stopReason === "one-hour lifetime" || healthRequests <= 2,
            }),
          );
          return;
        }
        if (request.url === "/stopped") {
          let body = "";
          request.on("data", (chunk: Buffer) => {
            body += chunk.toString();
          });
          request.on("end", () => {
            notifyStop(decodeArguments(body));
            response.end("ok");
          });
        }
        if (request.url === "/stop-command") {
          stopCommands += 1;
          const header = request.headers["x-crit-home"];
          stopHome = typeof header === "string" ? header : undefined;
          response.end("ok");
        }
      });
      yield* Effect.promise(
        () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
      );
      fixtures.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
      const address = server.address();
      NodeAssert.ok(address && typeof address !== "string");
      const port = address.port;
      const command = NodePath.join(directory, "crit");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          command,
          `#!${process.execPath}\n` +
            `const port=${port};\n` +
            `if(process.argv.includes('stop')){fetch('http://127.0.0.1:'+port+'/stop-command',{headers:{'x-crit-home':process.env.HOME}}).then(()=>process.exit(0));return;}\n` +
            `process.stderr.write('Started crit daemon at http://127.0.0.1:'+port+' (session test, PID '+process.pid+')\\n');\n` +
            `if(!process.argv.includes('stop'))setInterval(()=>{},1000);\n` +
            `process.on('SIGTERM',()=>{fetch('http://127.0.0.1:'+port+'/stopped',{method:'POST',body:JSON.stringify(process.argv.slice(2))}).then(()=>process.exit(0))});\n`,
        ),
      );
      yield* Effect.promise(() => NodeFSP.chmod(command, 0o755));
      const manager = createCritManager({
        command,
        outputDir: directory,
        browserCheckIntervalMs: 10,
        browserDisconnectGraceMs: 0,
        ...(stopReason === "one-hour lifetime" ? { maxReviewLifetimeMs: 500 } : {}),
      });
      fixtures.push(() => manager.dispose());

      yield* manager.open({ cwd: process.cwd(), scope: { kind: "working-tree" } });
      const args = yield* Effect.promise(() => stopped);
      NodeAssert.ok(healthRequests > (stopReason === "one-hour lifetime" ? 0 : 2));
      NodeAssert.deepEqual(args.slice(4), ["--base-branch", "HEAD"]);
      const outputDir = args[3];
      NodeAssert.deepEqual(args.slice(0, 3), ["--host", "127.0.0.1", "--output"]);
      NodeAssert.equal(outputDir, directory);
      yield* Effect.promise(() => manager.dispose());
      NodeAssert.equal(stopCommands, 1);
      NodeAssert.ok(stopHome);
      NodeAssert.notEqual(stopHome, outputDir);
      NodeAssert.equal(NodeFS.existsSync(stopHome), false);
      NodeAssert.equal(NodeFS.existsSync(outputDir), true);
    }),
);

it.effect("maps branch, turn, pull request, and commit selections to Crit scopes", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-crit-args-test-")),
    );
    fixtures.push(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    const command = NodePath.join(directory, "crit");
    const output = NodePath.join(directory, "args.jsonl");
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        command,
        `#!${process.execPath}\n` +
          `if(!process.argv.includes('stop'))require('node:fs').appendFileSync(require('node:path').join(process.argv[5],'args.jsonl'),JSON.stringify(process.argv.slice(2))+'\\n');\n` +
          `if(!process.argv.includes('stop'))require('node:fs').appendFileSync(require('node:path').join(process.argv[5],'env.jsonl'),JSON.stringify({ghRepo:process.env.GH_REPO,home:process.env.HOME})+'\\n');\n` +
          `process.stderr.write('Started crit daemon at http://127.0.0.1:1 (session test, PID '+process.pid+')\\n');\n` +
          `if(!process.argv.includes('stop'))setInterval(()=>{},1000);\n` +
          `process.on('SIGTERM',()=>process.exit(0));\n`,
      ),
    );
    yield* Effect.promise(() => NodeFSP.chmod(command, 0o755));
    const manager = createCritManager({ command, outputDir: directory });
    fixtures.push(() => manager.dispose());
    const cwd = process.cwd();
    const head = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
    }).trim();
    yield* manager.open({ cwd, scope: { kind: "branch", baseRef: "HEAD" } });
    yield* manager.open({
      cwd,
      scope: {
        kind: "turn",
        threadId: ThreadId.make("turn-test"),
        fromTurnCount: 0,
        toRef: CheckpointRef.make("refs/t3/orchestration-v2/checkpoints/scope-test/ordinal/2"),
      },
    });
    yield* manager.open({
      cwd,
      scope: {
        kind: "turn",
        threadId: ThreadId.make("turn-test"),
        fromTurnCount: 1,
        fromRef: CheckpointRef.make("refs/custom/previous"),
        toRef: CheckpointRef.make("refs/custom/current"),
      },
    });
    const githubUrl = "https://github.com/NicholasZolton/t3code/pull/9";
    yield* manager.open({
      cwd,
      scope: { kind: "pull-request", provider: "github", url: githubUrl, number: 9 },
    });
    const gitlabUrl = "https://gitlab.example.org/team/app/-/merge_requests/12";
    yield* manager.open({
      cwd,
      scope: { kind: "pull-request", provider: "gitlab", url: gitlabUrl, number: 12 },
    });
    yield* manager.open({
      cwd,
      scope: { kind: "pull-request", provider: "github", url: githubUrl, number: 9, commit: head },
    });
    yield* Effect.promise(() => manager.dispose());
    const args = (yield* Effect.promise(() => NodeFSP.readFile(output, "utf8")))
      .trim()
      .split("\n")
      .map((line) => decodeArguments(line));
    const branchArgs = args[0];
    NodeAssert.ok(branchArgs);
    NodeAssert.deepEqual(branchArgs.slice(4), ["--range", `${head}..HEAD`]);
    const turnRange = args[1]?.[5];
    NodeAssert.ok(turnRange);
    NodeAssert.equal(
      turnRange,
      "refs/t3/orchestration-v2/checkpoints/scope-test/ordinal/0..refs/t3/orchestration-v2/checkpoints/scope-test/ordinal/2",
    );
    NodeAssert.deepEqual(args[2]?.slice(4), [
      "--range",
      "refs/custom/previous..refs/custom/current",
    ]);
    NodeAssert.deepEqual(args[3]?.slice(4), ["--pr", githubUrl]);
    NodeAssert.deepEqual(args[4]?.slice(4), ["--mr", gitlabUrl, "--remote"]);
    NodeAssert.deepEqual(args[5]?.slice(4), ["--range", `${head}^..${head}`]);
    const environments = (yield* Effect.promise(() =>
      NodeFSP.readFile(NodePath.join(directory, "env.jsonl"), "utf8"),
    ))
      .trim()
      .split("\n")
      .map((line) => decodeEnvironment(line));
    NodeAssert.equal(environments[3]?.ghRepo, "github.com/NicholasZolton/t3code");
    NodeAssert.notEqual(environments[3]?.home, NodeOS.homedir());
  }),
);

it.effect("fetches a pull request commit absent from the local checkout", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-crit-pr-test-")),
    );
    fixtures.push(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    const git = (cwd: string, ...args: string[]): string =>
      NodeChildProcess.execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const origin = NodePath.join(directory, "origin.git");
    const author = NodePath.join(directory, "author");
    const checkout = NodePath.join(directory, "checkout");
    git(directory, "init", "--bare", "-b", "main", origin);
    git(directory, "clone", origin, author);
    git(
      author,
      "-c",
      "user.name=T3",
      "-c",
      "user.email=t3@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "base",
    );
    git(author, "push", "origin", "HEAD:main");
    git(directory, "clone", origin, checkout);
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(author, "change.txt"), "change\n"));
    git(author, "add", "change.txt");
    git(author, "-c", "user.name=T3", "-c", "user.email=t3@example.test", "commit", "-m", "change");
    const commit = git(author, "rev-parse", "HEAD");
    git(author, "push", "origin", "HEAD:refs/pull/9/head");
    NodeAssert.notEqual(
      NodeChildProcess.spawnSync("git", ["cat-file", "-e", commit], { cwd: checkout }).status,
      0,
    );

    const command = NodePath.join(directory, "crit");
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        command,
        `#!${process.execPath}\n` +
          `if(process.argv.includes('stop'))process.exit(0);\n` +
          `require('node:fs').writeFileSync(require('node:path').join(process.argv[5],'args.json'),JSON.stringify(process.argv.slice(2)));\n` +
          `process.stderr.write('Started crit daemon at http://127.0.0.1:1\\n');\n` +
          `setInterval(()=>{},1000);\n`,
      ),
    );
    yield* Effect.promise(() => NodeFSP.chmod(command, 0o755));
    const manager = createCritManager({ command, outputDir: directory });
    fixtures.push(() => manager.dispose());
    yield* manager.open({
      cwd: checkout,
      scope: {
        kind: "pull-request",
        provider: "github",
        url: "https://github.com/example/repo/pull/9",
        number: 9,
        commit,
      },
    });
    yield* Effect.promise(() => manager.dispose());
    NodeAssert.equal(git(checkout, "rev-parse", "HEAD"), git(author, "rev-parse", "HEAD^"));
    NodeAssert.equal(git(checkout, "cat-file", "-t", commit), "commit");
    const args = decodeArguments(
      yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(directory, "args.json"), "utf8")),
    );
    NodeAssert.deepEqual(args.slice(4), ["--range", `${commit}^..${commit}`]);
  }),
);

it.effect(
  "the desktop review stream releases its isolated Crit daemon when the client leaves",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-crit-forward-test-")),
      );
      fixtures.push(() => NodeFSP.rm(directory, { recursive: true, force: true }));
      const command = NodePath.join(directory, "crit");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          command,
          `#!${process.execPath}\n` +
            `const fs = require('node:fs'); const path = require('node:path');\n` +
            `const args = process.argv.slice(2);\n` +
            `if (args[0] === 'stop') { fs.writeFileSync(path.join(__dirname, 'stopped'), process.env.HOME); process.exit(0); }\n` +
            `fs.writeFileSync(path.join(__dirname, 'args'), JSON.stringify(args));\n` +
            `process.stderr.write('Started crit daemon at http://127.0.0.1:41234 (session test)\\n');\n` +
            `setInterval(() => {}, 1000);\n`,
          { mode: 0o755 },
        ),
      );
      const manager = createCritManager({ command, outputDir: directory });
      fixtures.push(() => manager.dispose());
      const ports = yield* manager
        .forward({ cwd: directory, scope: { kind: "working-tree" } })
        .pipe(Stream.take(1), Stream.runCollect);
      NodeAssert.deepEqual(ports, [41234]);
      const args = decodeArguments(
        yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(directory, "args"), "utf8")),
      );
      NodeAssert.deepEqual(args, [
        "--host",
        "127.0.0.1",
        "--output",
        directory,
        "--no-open",
        "--base-branch",
        "HEAD",
      ]);
      const reviewHome = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(directory, "stopped"), "utf8"),
      );
      NodeAssert.equal(NodeFS.existsSync(reviewHome), false);
    }),
);

it.effect.each([false, true])(
  "forwards concurrent Crit reviews without changing existing endpoints (sudo required: %s)",
  (requireSudo) =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => tailnetFixture({ requireSudo }));
      const input: CritOpenInput = {
        cwd: process.cwd(),
        tailscale: true,
        scope: { kind: "working-tree" },
      };
      const urls = yield* Effect.all([fixture.manager.open(input), fixture.manager.open(input)], {
        concurrency: "unbounded",
      });
      NodeAssert.ok(urls[0] && urls[1]);
      NodeAssert.notEqual(urls[0], urls[1]);
      const ports = urls.map((url) => {
        NodeAssert.ok(url);
        const parsed = new URL(url);
        NodeAssert.equal(parsed.protocol, "https:");
        NodeAssert.equal(parsed.hostname, "dev.tail123.ts.net");
        NodeAssert.ok(!["443", "8443"].includes(parsed.port));
        return parsed.port;
      });
      const origins = yield* Effect.forEach(ports, (port) =>
        Effect.promise(async () => {
          const route = decodeForwardRoute(
            await NodeFSP.readFile(NodePath.join(fixture.directory, `route-${port}`), "utf8"),
          );
          return `http://127.0.0.1:${route.port}`;
        }),
      );
      const first = origins[0];
      const second = origins[1];
      NodeAssert.ok(first && second);
      const response = yield* HttpClient.get(first);
      NodeAssert.equal(yield* response.text, "Crit review");
      yield* Effect.promise(() => fixture.browserConnected);
      const closing = yield* HttpClient.get(`${first}/close`);
      yield* closing.text;
      yield* Effect.promise(() => fixture.forwardClosed);
      NodeAssert.equal(
        NodeFS.existsSync(NodePath.join(fixture.directory, `route-${ports[0]}`)),
        false,
      );
      const remaining = yield* HttpClient.get(second);
      NodeAssert.equal(yield* remaining.text, "Crit review");
      yield* Effect.promise(() => fixture.manager.dispose());
      NodeAssert.equal(
        NodeFS.existsSync(NodePath.join(fixture.directory, `route-${ports[1]}`)),
        false,
      );
      NodeAssert.equal(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(fixture.directory, "serve.json"), "utf8"),
        ),
        fixture.existingConfig,
      );
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.scoped),
);

it.effect.each([
  { requireSudo: false, message: /Tailscale Serve exited before forwarding Crit/ },
  { requireSudo: true, message: /Allow non-interactive sudo for tailscale/ },
])(
  "cleans up a Crit launch when Tailscale cannot publish the review ($requireSudo)",
  ({ requireSudo, message }) =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        tailnetFixture({ failForward: true, requireSudo }),
      );
      const error = yield* fixture.manager
        .open({
          cwd: process.cwd(),
          tailscale: true,
          scope: { kind: "working-tree" },
        })
        .pipe(Effect.flip);
      NodeAssert.match(error.message, message);
      const reviewHome = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(fixture.directory, "review-home"), "utf8"),
      );
      NodeAssert.equal(NodeFS.existsSync(reviewHome), false);
      yield* Effect.promise(() => fixture.manager.dispose());
      NodeAssert.equal(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(fixture.directory, "serve.json"), "utf8"),
        ),
        fixture.existingConfig,
      );
      NodeAssert.equal(
        (yield* Effect.promise(() => NodeFSP.readdir(fixture.directory))).some((name) =>
          name.startsWith("route-"),
        ),
        false,
      );
    }),
);
