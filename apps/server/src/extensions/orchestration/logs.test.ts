// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "@effect/vitest";
import {
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
  ProjectId,
  extensionWorkspaceRevision,
} from "@t3tools/contracts";
import { createExtensionRuntime, type RuntimeOptions } from "@t3tools/extension-runtime";
import {
  ORCHESTRATION_READ,
  ORCHESTRATION_READ_LOGS,
  type AgentLogRuns,
  type AgentLogTail,
} from "@t3tools/extension-sdk/catalogue";
import type { Json, ViewContext } from "@t3tools/extension-sdk/contracts";
import type { HostApiInvocationMetadata, HostApiProvider } from "@t3tools/extension-runtime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  claudeWorkspaceSlug,
  createOrchestrationLogsApiProvider,
  keyStateBefore,
  shapeLogTail,
} from "./logs.ts";

const decodeActivity = Schema.decodeUnknownSync(OrchestrationThreadActivity);
const decodeSnapshot = Schema.decodeUnknownSync(OrchestrationThreadDetailSnapshot);
const CWD = "/workspace/app";
const SLUG = claudeWorkspaceSlug(CWD);
const at = "2026-09-26T00:00:00.000Z";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const contextFor = (threadId: string, projectId = "project"): ViewContext => ({
  resource: {
    namespace: "logs.fixture",
    id: "agents",
    environmentId: "env",
    projectId,
    threadId,
  },
  client: "test",
  workspaceRevision: extensionWorkspaceRevision(CWD, null),
});
const context = contextFor("thread");
const signal = new AbortController().signal;
const meta = (
  scopes: readonly string[] = ["orchestration:read"],
  assertAuthority?: () => Promise<void>,
): HostApiInvocationMetadata => ({
  callId: "call",
  rootCallerId: "root",
  callerId: "caller",
  providerId: "t3.host-orchestration-logs",
  providerGeneration: 1,
  callerGenerations: [],
  principal: { kind: "environment-session", id: "session", environmentId: "env", scopes },
  ...(assertAuthority ? { assertAuthority } : {}),
});

const task = (taskId: string, extra: Record<string, unknown> = {}, createdAt = at) =>
  decodeActivity({
    id: `activity-${taskId}`,
    kind: "task.started",
    tone: "info",
    summary: "Started",
    createdAt,
    turnId: null,
    payload: { taskId, agentKind: "agent", description: `Task ${taskId}`, ...extra },
  });

async function fixture(options: { open?: typeof NodeFSP.open } = {}) {
  const tmp = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agent-logs-")),
  );
  cleanups.push(() => NodeFSP.rm(tmp, { recursive: true, force: true }));
  const projects = NodePath.join(tmp, "projects");
  const tasks = NodePath.join(tmp, "claude-tmp");
  const write = async (file: string, contents: string | Buffer) => {
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    await NodeFSP.writeFile(file, contents);
    return file;
  };
  const link = async (file: string, target: string) => {
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    await NodeFSP.symlink(target, file);
    return file;
  };
  const rosters = new Map<string, ReturnType<typeof task>[]>();
  const threadProjects = new Map([
    ["thread", "project"],
    ["thread-b", "project"],
    ["foreign", "project-b"],
  ]);
  const provider = createOrchestrationLogsApiProvider({
    environmentId: "env",
    projects: {
      getById: ({ projectId }) =>
        Effect.succeedSome({
          projectId,
          workspaceRoot: projectId === "project" ? CWD : "/workspace/other",
          deletedAt: null,
        }),
    },
    threads: {
      getById: ({ threadId }) => {
        const projectId = threadProjects.get(threadId);
        return Effect.succeed(
          projectId
            ? Option.some({
                projectId: ProjectId.make(projectId),
                worktreePath: null,
                deletedAt: null,
              })
            : Option.none(),
        );
      },
    },
    snapshots: {
      getThreadDetailSnapshot: (threadId) =>
        Effect.sync(() =>
          Option.some(
            decodeSnapshot({
              snapshotSequence: 1,
              thread: {
                id: threadId,
                projectId: threadProjects.get(threadId) ?? "project",
                title: "Logs fixture",
                modelSelection: { instanceId: "claudeAgent", model: "claude" },
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                latestTurn: null,
                createdAt: at,
                updatedAt: at,
                deletedAt: null,
                messages: [],
                activities: rosters.get(threadId) ?? [],
                checkpoints: [],
                session: null,
              },
            }),
          ),
        ),
    },
    roots: () => [projects, tasks, NodePath.join(tmp, "missing-root")],
    ...(options.open ? { open: options.open } : {}),
  });
  const call = async (
    method: string,
    input: Json = {},
    options: { context?: ViewContext; metadata?: HostApiInvocationMetadata } = {},
  ) =>
    provider.invoke(method, input, options.context ?? context, signal, options.metadata ?? meta());
  return { tmp, projects, tasks, write, link, rosters, provider, call };
}

const lines = (count: number, width = 40) =>
  Array.from({ length: count }, (_, index) => `line ${index} `.padEnd(width, "x")).join("\n") +
  "\n";

it("lists only runs that carry an output handle, without host paths", async () => {
  const f = await fixture();
  const transcript = await f.write(
    NodePath.join(f.projects, SLUG, "sess", "subagents", "agent-a.jsonl"),
    '{"type":"user"}\n',
  );
  const output = await f.link(
    NodePath.join(f.tasks, SLUG, "sess", "tasks", "a.output"),
    transcript,
  );
  f.rosters.set("thread", [
    task("a", { outputFile: output, title: "t".repeat(500) }),
    // Codex/Cursor/Grok/OpenCode/Antigravity rows carry no handle.
    task("no-handle"),
  ]);
  const listed = (await f.call("listRuns")) as AgentLogRuns;
  expect(listed).toEqual({
    runs: [
      {
        runId: "a",
        kind: "subagent",
        title: "t".repeat(200),
        status: "interrupted",
        sources: ["output"],
      },
    ],
    truncated: false,
  });
  expect(JSON.stringify(listed)).not.toContain(f.tmp);
});

it("reads a symlinked transcript tail at a line boundary with a truncation marker", async () => {
  const f = await fixture();
  const body = lines(1000);
  const transcript = await f.write(
    NodePath.join(f.projects, SLUG, "sess", "subagents", "agent-a.jsonl"),
    body,
  );
  const output = await f.link(
    NodePath.join(f.tasks, SLUG, "sess", "tasks", "a.output"),
    transcript,
  );
  f.rosters.set("thread", [task("a", { outputFile: output })]);

  const tail = (await f.call("readTail", { runId: "a", source: "output" })) as AgentLogTail;
  expect(tail.runId).toBe("a");
  expect(tail.byteLength).toBe(Buffer.byteLength(body));
  expect(tail.truncated).toBe(true);
  expect(Buffer.byteLength(tail.contents)).toBeLessThanOrEqual(8192);
  expect(tail.contents.startsWith("line ")).toBe(true);
  expect(body.endsWith(tail.contents)).toBe(true);
  expect(JSON.stringify(tail)).not.toContain(f.tmp);

  const small = (await f.call("readTail", {
    runId: "a",
    source: "output",
    maxBytes: 100,
    maxLines: 1,
  })) as AgentLogTail;
  expect(small).toEqual({
    runId: "a",
    source: "output",
    contents: `${"line 999 ".padEnd(40, "x")}\n`,
    byteLength: Buffer.byteLength(body),
    truncated: true,
  });

  const whole = await f.write(NodePath.join(f.tasks, SLUG, "sess", "tasks", "b.output"), "done\n");
  f.rosters.set("thread", [task("b", { outputFile: whole })]);
  expect(await f.call("readTail", { runId: "b", source: "output" })).toEqual({
    runId: "b",
    source: "output",
    contents: "done\n",
    byteLength: 5,
    truncated: false,
  });
});

const limits = { maxBytes: 8192, maxLines: 1000 };
it("never splits a UTF-8 sequence or keeps an unbounded partial line", () => {
  const encoded = new TextEncoder().encode("é first\nsecond\n");
  // Window starts inside the two-byte "é"; the lead read before it reaches
  // the source's start, so no key can be open.
  expect(shapeLogTail(encoded.subarray(1), 1, limits, encoded.subarray(0, 1))).toEqual({
    contents: "second\n",
    truncated: true,
  });
  // A line whose start was never read cannot be classified, so it is withheld
  // even when it is the only line.
  expect(shapeLogTail(new TextEncoder().encode("abcdef\n"), 10, limits)).toEqual({
    contents: "",
    truncated: true,
  });
  expect(shapeLogTail(new TextEncoder().encode("a\nb\nc"), 0, { ...limits, maxLines: 2 })).toEqual({
    contents: "b\nc",
    truncated: true,
  });
});

it("keeps whole lines when the byte cut lands exactly on a line boundary", () => {
  const encoded = new TextEncoder().encode("old\none\ntwo\n");
  expect(shapeLogTail(encoded, 0, { ...limits, maxBytes: 8 })).toEqual({
    contents: "one\ntwo\n",
    truncated: true,
  });
  // One byte fewer cuts inside "one", which is dropped.
  expect(shapeLogTail(encoded, 0, { ...limits, maxBytes: 7 })).toEqual({
    contents: "two\n",
    truncated: true,
  });
});

it("redacts a transcript record whose key is cut off before its closing quote", () => {
  const record = JSON.stringify({ content: "-----BEGIN PRIVATE KEY-----\nAAAA \nBBBB" });
  expect(shapeLogTail(new TextEncoder().encode(`${record}\n`), 0, limits)).toEqual({
    contents: `{"content":"[REDACTED]\n`,
    truncated: false,
  });
});

it("redacts key material when the read cuts both ends of a key", () => {
  // Deterministic base64 key lines, 64 wide as PEM writes them.
  let seed = 7;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const keyLine = () =>
    Array.from({ length: 64 }, () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return alphabet[seed % 64];
    }).join("");
  const body = Array.from({ length: 282 }, keyLine);
  const leaks = (contents: string) =>
    body.some((line) =>
      Array.from({ length: 8 }, (_, i) => line.slice(i * 8, i * 8 + 8)).some((part) =>
        contents.includes(part),
      ),
    );
  for (const lineBreak of ["\n", "\r\n"]) {
    const begin = `-----BEGIN PRIVATE KEY-----${lineBreak}`;
    const end = `-----END PRIVATE KEY-----${lineBreak}after${lineBreak}`;
    // Unfinished (the writer is mid-key), and finished with END in the read.
    for (const source of [
      begin + body.join(lineBreak),
      begin + body.join(lineBreak) + lineBreak + end,
    ]) {
      const encoded = new TextEncoder().encode(source);
      for (const maxBytes of [8192, 4000, 100]) {
        // The bounded read: the delivered window plus its redaction context.
        const from = encoded.length - Math.min(encoded.length, maxBytes + 8192);
        expect(from).toBeGreaterThan(begin.length);
        const shaped = shapeLogTail(encoded.subarray(from), from, { maxBytes, maxLines: 1000 });
        expect(leaks(shaped.contents), `${JSON.stringify(lineBreak)} ${maxBytes}`).toBe(false);
        expect(shaped.truncated).toBe(true);
        if (source.endsWith(end)) expect(shaped.contents.endsWith(`after${lineBreak}`)).toBe(true);
      }
    }
  }
});

it("decides whether a window starts inside a key from the markers before it", () => {
  const state = (before: string, complete = true) =>
    keyStateBefore(new TextEncoder().encode(before), complete);
  const inside = (type = "") => ({ inside: type });
  expect(state("log\n")).toBe("outside");
  expect(state("log\n", false)).toBe("unknown");
  expect(state("-----BEGIN PRIVATE KEY-----\nAAAA\n", false)).toEqual(inside());
  expect(state("-----BEGIN RSA PRIVATE KEY----- \r\nAAAA AAAA\n\nBBBB\n")).toEqual(inside("RSA"));
  expect(state("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\nok\n")).toBe(
    "outside",
  );
  // An escaped END closes it too.
  expect(
    state("-----BEGIN PRIVATE KEY-----\n" + String.raw`{"c":"-----END PRIVATE KEY-----"}` + "\n"),
  ).toBe("outside");
  expect(state("-----BEGIN PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n\nAAAA\n")).toEqual(inside());
  // A BEGIN in any form opens a key, whatever lines follow it.
  expect(
    state("-----BEGIN PRIVATE KEY-----\nAAAA\nThe -----BEGIN PRIVATE KEY----- line.\n"),
  ).toEqual(inside());
  expect(state("-----BEGIN PRIVATE KEY-----\nBuild passed.\nAAAA\n")).toEqual(inside());
  expect(state("The -----BEGIN PRIVATE KEY----- line.\n", false)).toEqual(inside());
  expect(state(String.raw`{"c":"-----BEGIN EC PRIVATE KEY-----\nAAAA"}` + "\n")).toEqual(
    inside("EC"),
  );
  expect(state(String.raw`{"c":"-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----"}`)).toBe(
    "outside",
  );
  // Markers are read after decoding escapes, at any depth.
  expect(state(String.raw`{"content":"-----BEGIN PRIVATE KEY-----"}` + "\n")).toEqual(inside());
  expect(
    state(JSON.stringify({ c: String.raw`{"c":"-----BEGIN OPENSSH PRIVATE KEY-----"}` })),
  ).toEqual(inside("OPENSSH"));
  // Only an END of the key's own type closes it.
  expect(state("-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----\n")).toEqual(
    inside("RSA"),
  );
  expect(state("-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n")).toEqual(
    inside("RSA"),
  );
  expect(
    state("-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----\n"),
  ).toBe("outside");
});

// Base64 key rows as the review's reproductions wrote them.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const shapeTail = (source: string, maxBytes = 8192, withLead = false) => {
  const bytes = new TextEncoder().encode(source);
  const from = bytes.length - Math.min(bytes.length, maxBytes + 8192);
  expect(from).toBeGreaterThan(0);
  const lead = withLead ? bytes.subarray(0, from) : undefined;
  return shapeLogTail(bytes.subarray(from), from, { maxBytes, maxLines: 1000 }, lead).contents;
};

it("redacts a window that starts inside a key, whatever its wrapping", () => {
  const begin = "-----BEGIN PRIVATE KEY-----\n";
  const rows = {
    standard: `${B64}\n`,
    wrapped32: `${B64.slice(0, 32)}\n${B64.slice(32)}\n`,
    spaced: `${B64.slice(0, 32)} ${B64.slice(32)}\n`,
    blank: `${B64}\n\n`,
    initialBlank: `\n${B64}\n`,
    indented: `${" ".repeat(80)}${B64.slice(0, 32)}\n`,
    tabbed: `${"\t".repeat(1000)}${B64.slice(0, 32)} ${B64.slice(32)}\n`,
  };
  for (const [name, row] of Object.entries(rows)) {
    // Neither marker is in the read: the writer is mid-key.
    const source = begin + row.repeat(400);
    for (const withLead of [false, true])
      for (const maxBytes of [8192, 100]) {
        const contents = shapeTail(source, maxBytes, withLead);
        expect(contents, `${name} ${maxBytes} ${withLead}`).not.toContain(B64.slice(32, 48));
        expect(contents, `${name} ${maxBytes} ${withLead}`).not.toContain(B64.slice(0, 16));
      }
  }
  // The review's exact reproduction: 32-column halves joined by a space.
  const row = `${"A".repeat(32)} ${"B".repeat(32)}\n`;
  const bytes = new TextEncoder().encode(begin + row.repeat(400));
  const from = bytes.length - 16384;
  const shaped = shapeLogTail(bytes.subarray(from), from, limits);
  expect(shaped.contents).not.toContain("BBBBBBBB");
  expect(
    shapeLogTail(bytes.subarray(from), from, limits, bytes.subarray(0, from)).contents,
  ).not.toMatch(/AAAAAAAA|BBBBBBBB/);
});

it("redacts through END a window that starts inside a key, and keeps what follows", () => {
  const key = `-----BEGIN PRIVATE KEY-----\n${`${B64.slice(0, 32)} ${B64.slice(32)}\n`.repeat(300)}`;
  const source = `${key}-----END PRIVATE KEY-----\nafter one\nafter two\n`;
  const contents = shapeTail(source, 8192, true);
  expect(contents).not.toContain(B64.slice(0, 16));
  expect(contents.endsWith("[REDACTED]\nafter one\nafter two\n")).toBe(true);
  // A key closed before the window leaves ordinary base64-looking lines alone.
  const closed = `${key}-----END PRIVATE KEY-----\n${"AAAA BBBB\n".repeat(2000)}`;
  expect(shapeTail(closed, 8192, true)).toMatch(/^AAAA BBBB\n/);
  // Without the lead the key state is unknown: leading key-like lines are
  // withheld up to the first line that cannot be key material.
  const unknown = shapeTail(`${"AAAA BBBB\n".repeat(2000)}done.\nAAAA\n`, 8192);
  expect(unknown.endsWith("[REDACTED]\ndone.\nAAAA\n")).toBe(true);
  expect(unknown).not.toContain("AAAA BBBB");
});

it("redacts valid RSA keys rewrapped or spaced when the read cuts both ends", () => {
  const pem = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 4096 })
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString()
    .trim()
    .split("\n");
  const base64 = pem.slice(1, -1).join("");
  const shapes: [string, number, string, boolean][] = [
    ["wrapped32", 32, " ".repeat(80), false],
    ["spaced64", 64, " ".repeat(120), true],
    ["tabs64", 64, "\t".repeat(1000), true],
    ["blank64", 64, "\t".repeat(1000), false],
  ];
  for (const [name, width, indent, spaced] of shapes) {
    const body = base64.match(new RegExp(`.{1,${width}}`, "g"))!;
    const blank = name.startsWith("blank") ? "\n" : "";
    const rows = body.map(
      (line) => `${indent}${spaced ? `${line.slice(0, 32)} ${line.slice(32)}` : line}\n${blank}`,
    );
    const source = `${pem[0]}\n${rows.join("")}`;
    // The review's rewrappings are still keys Node accepts.
    if (!indent.includes("\t"))
      expect(() => NodeCrypto.createPrivateKey(`${source}${pem.at(-1)}\n`)).not.toThrow();
    const fragments = body.flatMap((line) =>
      Array.from({ length: Math.floor(line.length / 8) }, (_, i) => line.slice(i * 8, i * 8 + 8)),
    );
    for (const withLead of [false, true])
      for (const maxBytes of [100, 1000]) {
        const contents = shapeTail(source, maxBytes, withLead);
        const leaked = fragments.filter((fragment) => contents.includes(fragment));
        expect(leaked, `${name} ${maxBytes} ${withLead}`).toEqual([]);
      }
  }
});

it("shapes escaped keys, escaped fields, and malformed quotes without leaking", () => {
  const shape = (text: string) => shapeLogTail(new TextEncoder().encode(text), 0, limits).contents;
  const encoded = String.raw`-----BEGIN PRIVATE KEY-----\nUNIQUESECRET\n-----END PRIVATE KEY-----`;
  expect(shape(`ok\n${encoded}`)).toBe("ok\n[REDACTED]");
  expect(shape(JSON.stringify({ content: encoded }))).toBe(`{"content":"[REDACTED]"}`);
  expect(shape("ok\n" + String.raw`{"password":"UNIQUESECRET"}`)).toBe(
    "ok\n" + String.raw`{"password":"[REDACTED]"}`,
  );
  expect(shape('{"password":"first"-UNIQUESECRET"}')).toBe('{"password":"[REDACTED]"}');
  expect(shape('[{"password":"UNIQUESECRET"},1]')).toBe('[{"password":"[REDACTED]"},1]');
  // An unfinished escaped key after a word runs to the end.
  const echo = String.raw`echo -----BEGIN PRIVATE KEY-----\nUNIQUESECRET`;
  expect(shape(`ok\n${echo}`)).toBe("ok\necho [REDACTED]");
});

it("reads the key state before the window from the file", async () => {
  const f = await fixture();
  const row = `${"A".repeat(32)} ${"B".repeat(32)}\n`;
  const file = await f.write(
    NodePath.join(f.projects, SLUG, "s", "k.jsonl"),
    `line\n-----BEGIN PRIVATE KEY-----\n${row.repeat(400)}`,
  );
  f.rosters.set("thread", [task("k", { outputFile: file })]);
  const tail = (await f.call("readTail", { runId: "k", source: "output" })) as AgentLogTail;
  expect(tail.contents).not.toMatch(/AAAAAAAA|BBBBBBBB/);
  expect(tail.contents).toContain("[REDACTED]");
  // Once END lands, later lines are delivered.
  await NodeFSP.appendFile(file, `-----END PRIVATE KEY-----\n${"AAAA later\n".repeat(1000)}`);
  const after = (await f.call("readTail", { runId: "k", source: "output" })) as AgentLogTail;
  expect(after.contents).toMatch(/^AAAA later\n/);
});

it("keeps a window inside a key after interleaved lines, until END", async () => {
  const f = await fixture();
  const row = `${"A".repeat(32)} ${"B".repeat(32)}\n`;
  const file = await f.write(
    NodePath.join(f.projects, SLUG, "s", "k.jsonl"),
    `line\n-----BEGIN PRIVATE KEY-----\nAAAA\n[progress] reading key\n${row.repeat(400)}`,
  );
  f.rosters.set("thread", [task("k", { outputFile: file })]);
  for (const maxBytes of [100, 8192]) {
    const tail = (await f.call("readTail", {
      runId: "k",
      source: "output",
      maxBytes,
    })) as AgentLogTail;
    expect(tail.contents, `${maxBytes}`).not.toMatch(/AAAAAAAA|BBBBBBBB/);
  }
  // The same source read whole: the interleaved line does not end the key.
  const whole = shapeLogTail(
    new TextEncoder().encode(`-----BEGIN PRIVATE KEY-----\n[progress]\n${row.repeat(20)}`),
    0,
    limits,
  );
  expect(whole.contents).not.toMatch(/AAAAAAAA|BBBBBBBB/);
  await NodeFSP.appendFile(file, `-----END PRIVATE KEY-----\n${"AAAA later\n".repeat(1000)}`);
  const after = (await f.call("readTail", { runId: "k", source: "output" })) as AgentLogTail;
  expect(after.contents).toMatch(/^AAAA later\n/);
});

/** Opens files through a handle that counts the bytes it reads. */
const countingOpen = () => {
  const counter = { bytes: 0 };
  const open = (async (path: string, flags: number) => {
    const file = await NodeFSP.open(path, flags);
    const read = file.read.bind(file);
    file.read = (async (buffer: Uint8Array, offset: number, length: number, position: number) => {
      const result = await read(buffer, offset, length, position);
      counter.bytes += result.bytesRead;
      return result;
    }) as typeof file.read;
    return file;
  }) as typeof NodeFSP.open;
  return { counter, open };
};
const ordinaryLines = (bytes: number) =>
  '{"type":"assistant","text":"normal output."}\n'.repeat(Math.ceil(bytes / 45)).slice(0, bytes);

const SECRET_ROW = `UNIQUESECRET${"A".repeat(52)}\n`;
const fill = (pattern: string, bytes: number) =>
  pattern.repeat(Math.ceil(bytes / pattern.length)).slice(0, bytes);

it("reads a fixed 256 KiB before the window on every call", async () => {
  const { counter, open } = countingOpen();
  const f = await fixture({ open });
  const file = await f.write(
    NodePath.join(f.projects, SLUG, "s", "a.jsonl"),
    ordinaryLines(8 * 1024 * 1024),
  );
  f.rosters.set("thread", [task("a", { outputFile: file })]);
  const read = async (maxBytes?: number) => {
    counter.bytes = 0;
    const tail = (await f.call("readTail", {
      runId: "a",
      source: "output",
      ...(maxBytes ? { maxBytes } : {}),
    })) as AgentLogTail;
    return { tail, bytes: counter.bytes };
  };
  // The window and its context, plus at most the scan before its first line.
  for (const maxBytes of [undefined, 100]) {
    const window = (maxBytes ?? 8192) + 8192;
    const first = await read(maxBytes);
    expect(first.bytes).toBeGreaterThan(window + 250 * 1024);
    expect(first.bytes).toBeLessThanOrEqual(window + 256 * 1024);
    expect((await read(maxBytes)).bytes).toBe(first.bytes);
  }
  // A BEGIN appended after the scan was last read is found.
  await NodeFSP.appendFile(file, `-----BEGIN PRIVATE KEY-----\n${SECRET_ROW.repeat(400)}`);
  expect((await read()).tail.contents).not.toContain("UNIQUESECRET");
});

it("finds the key state again after any rewrite, truncation, or append", async () => {
  const f = await fixture();
  const file = NodePath.join(f.projects, SLUG, "s", "a.jsonl");
  f.rosters.set("thread", [task("a", { outputFile: file })]);
  const begin = "-----BEGIN PRIVATE KEY-----\n";
  const end = "-----END PRIVATE KEY-----\n";
  // The review's reproductions: secret rows after ordinary lines, a marker at
  // 4096 or END at 8192, and the file's head and tail bytes kept the same.
  const size = 256 * 1024;
  const base = Buffer.from(fill("normal log line.\n", 8192) + fill(SECRET_ROW, size - 8192));
  const keyed = Buffer.from(base);
  keyed.write(begin, 4096);
  const ended = Buffer.from(keyed);
  ended.write(end, 8192);
  const bigAppend = fill("ordinary line.\n", 4 * 1024 * 1024) + begin + fill(SECRET_ROW, 65536);
  const read = async () =>
    ((await f.call("readTail", { runId: "a", source: "output" })) as AgentLogTail).contents;
  const cases: [string, Buffer, () => Promise<unknown>][] = [
    [
      "middle rewrite adds BEGIN",
      base,
      async () => {
        const handle = await NodeFSP.open(file, "r+");
        await handle.write(begin, 4096).finally(() => handle.close());
      },
    ],
    ["same-size rewrite", base, () => NodeFSP.writeFile(file, keyed)],
    [
      "middle rewrite removes END",
      ended,
      async () => {
        const handle = await NodeFSP.open(file, "r+");
        await handle
          .write(base.subarray(8192, 8192 + end.length), 0, end.length, 8192)
          .finally(() => handle.close());
      },
    ],
    [
      "rewrite plus append",
      base,
      async () => {
        await NodeFSP.writeFile(file, keyed);
        await NodeFSP.appendFile(file, fill(SECRET_ROW, 100_000));
      },
    ],
    [
      "truncate and regrow",
      base,
      async () => {
        await NodeFSP.truncate(file, 0);
        await NodeFSP.writeFile(
          file,
          Buffer.concat([keyed, Buffer.from(fill(SECRET_ROW, 100_000))]),
        );
      },
    ],
    [
      "hard link rewritten",
      base,
      async () => {
        const alias = `${file}.link`;
        await NodeFSP.rm(alias, { force: true });
        await NodeFSP.link(file, alias);
        await NodeFSP.writeFile(alias, keyed);
      },
    ],
    ["append over 4 MiB", base, () => NodeFSP.appendFile(file, bigAppend)],
    ["append over 4 MiB after END", ended, () => NodeFSP.appendFile(file, bigAppend)],
  ];
  for (const [name, initial, mutate] of cases) {
    await f.write(file, initial);
    await read();
    await read();
    await mutate();
    expect(await read(), name).not.toContain("UNIQUESECRET");
  }
  // Removing BEGIN releases lines the key withheld.
  await f.write(file, keyed);
  expect(await read()).not.toContain("UNIQUESECRET");
  await NodeFSP.writeFile(file, base);
  expect(await read()).toContain("UNIQUESECRET");
});

it("keeps a window inside a key opened by an escaped or mismatched marker", async () => {
  const f = await fixture();
  const cases = {
    unicode: String.raw`{"content":"-----BEGIN PRIVATE KEY-----"}` + "\n",
    literal: JSON.stringify({ content: "-----BEGIN PRIVATE KEY-----" }) + "\n",
    mismatched: "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----\n",
  };
  for (const [name, lead] of Object.entries(cases)) {
    const file = await f.write(
      NodePath.join(f.projects, SLUG, "s", `${name}.jsonl`),
      `${lead}[progress]\n${SECRET_ROW.repeat(800)}`,
    );
    f.rosters.set("thread", [task(name, { outputFile: file })]);
    const tail = (await f.call("readTail", { runId: name, source: "output" })) as AgentLogTail;
    expect(tail.contents, name).not.toContain("UNIQUESECRET");
  }
});

it("fails closed through the provider on encoded markers and invalid continuations", async () => {
  const f = await fixture();
  const nest = (text: string, depth: number) => {
    for (let level = 0; level < depth; level++) text = JSON.stringify({ content: text });
    return text;
  };
  const cases: Record<string, string> = {};
  for (const depth of [0, 1, 2, 3]) {
    cases[`wrapper-${depth}`] = nest('{"wrapper":{"password":"first"},"UNIQUESECRET"]', depth);
    cases[`root-${depth}`] = nest('{"password":"first"},"UNIQUESECRET"]', depth);
  }
  // A BEGIN that needs `passes` decoding passes, read in the window or only
  // in the scan before it.
  for (const passes of [12, 13, 14, 20]) {
    const record = JSON.stringify({
      content: `-----\\${"u005c".repeat(passes - 2)}u0042EGIN PRIVATE KEY-----`,
    });
    cases[`window-${passes}`] = `${record}\n[progress]\nUNIQUESECRET\n`;
    cases[`scan-${passes}`] =
      `${"ordinary log.\n".repeat(2000)}${record}\n[progress]\n${SECRET_ROW.repeat(800)}`;
  }
  for (const [name, contents] of Object.entries(cases)) {
    const file = await f.write(NodePath.join(f.projects, SLUG, "s", `${name}.jsonl`), contents);
    f.rosters.set("thread", [task(name, { outputFile: file })]);
    const tail = (await f.call("readTail", { runId: name, source: "output" })) as AgentLogTail;
    expect(tail.contents, name).not.toContain("UNIQUESECRET");
  }
});

it("withholds a leading line whose secret name fell before the read", async () => {
  const f = await fixture();
  const file = await f.write(
    NodePath.join(f.projects, SLUG, "s", "a.jsonl"),
    `PASSWORD=${"z".repeat(20_000)}`,
  );
  f.rosters.set("thread", [task("a", { outputFile: file })]);
  for (const maxBytes of [128, 8192]) {
    const tail = (await f.call("readTail", {
      runId: "a",
      source: "output",
      maxBytes,
    })) as AgentLogTail;
    expect(tail).toEqual({
      runId: "a",
      source: "output",
      contents: "",
      byteLength: 20_009,
      truncated: true,
    });
  }
  // Later complete lines are all delivered when they fit.
  await NodeFSP.appendFile(file, "\nFIRST-COMPLETE\nSECOND-COMPLETE\n");
  expect(await f.call("readTail", { runId: "a", source: "output", maxBytes: 128 })).toEqual({
    runId: "a",
    source: "output",
    contents: "FIRST-COMPLETE\nSECOND-COMPLETE\n",
    byteLength: 20_041,
    truncated: true,
  });
});

it("gates on the orchestration:read principal and a thread scope, by name", async () => {
  const f = await fixture();
  f.rosters.set("thread", [task("a", { outputFile: "/nowhere" })]);
  await expect(
    f.call("listRuns", {}, { metadata: meta(["orchestration:operate"]) }),
  ).rejects.toThrow("AgentLogsAuthorityDenied: orchestration:read");
  const { principal: _principal, ...anonymous } = meta();
  await expect(
    f.call("readTail", { runId: "a", source: "output" }, { metadata: anonymous }),
  ).rejects.toThrow("AgentLogsAuthorityDenied");
  const { threadId: _thread, ...resource } = context.resource;
  await expect(f.call("listRuns", {}, { context: { ...context, resource } })).rejects.toThrow(
    "AgentLogsThreadScopeRequired",
  );
});

it("isolates runs to the view's thread and the workspace's slug directory", async () => {
  const f = await fixture();
  const mine = await f.write(NodePath.join(f.projects, SLUG, "s", "mine.jsonl"), "mine\n");
  await NodeFSP.mkdir(NodePath.join(f.projects, SLUG, "s", "sub"));
  const theirs = await f.write(
    NodePath.join(f.projects, claudeWorkspaceSlug("/workspace/other"), "s", "theirs.jsonl"),
    "SECRET-OTHER-PROJECT\n",
  );
  const outside = await f.write(NodePath.join(f.tmp, "outside", "secret.log"), "SECRET-OUTSIDE\n");
  const escape = await f.link(NodePath.join(f.tasks, SLUG, "s", "escape.output"), outside);
  f.rosters.set("thread", [
    task("mine", { outputFile: mine }),
    task("theirs", { outputFile: theirs }),
    task("outside", { outputFile: outside }),
    task("escape", { outputFile: escape }),
    task("gone", { outputFile: NodePath.join(f.projects, SLUG, "s", "deleted.jsonl") }),
    task("dir", { outputFile: NodePath.join(f.projects, SLUG, "s", "sub") }),
    task("plain"),
  ]);
  f.rosters.set("thread-b", [task("b-only", { outputFile: mine })]);
  const read = (runId: string, options?: { context?: ViewContext }) =>
    f.call("readTail", { runId, source: "output" }, options);

  expect(((await read("mine")) as AgentLogTail).contents).toBe("mine\n");
  for (const runId of ["theirs", "outside", "escape"])
    await expect(read(runId)).rejects.toThrow("AgentLogsOutOfScope");
  // Another thread's run id is unknown here, even within the same project.
  await expect(read("b-only")).rejects.toThrow("AgentLogsRunUnknown");
  await expect(read("never-existed")).rejects.toThrow("AgentLogsRunUnknown");
  await expect(read("gone")).rejects.toThrow("AgentLogsSourceUnavailable");
  await expect(read("dir")).rejects.toThrow("AgentLogsSourceUnavailable");
  await expect(read("plain")).rejects.toThrow("AgentLogsSourceUnavailable");
  // A thread from another project cannot ride this project's view.
  await expect(read("mine", { context: contextFor("foreign") })).rejects.toThrow(
    "Extension thread does not belong to this project.",
  );
  expect(
    ((await f.call("listRuns", {}, { context: contextFor("thread-b") })) as AgentLogRuns).runs,
  ).toEqual([expect.objectContaining({ runId: "b-only" })]);
});

it("rejects caller-supplied paths and unknown methods, and redacts failures", async () => {
  const f = await fixture();
  const secret = await f.write(NodePath.join(f.tmp, "outside", "secret.log"), "SECRET\n");
  f.rosters.set("thread", [task("a", { outputFile: secret })]);
  for (const input of [
    { runId: "a", source: "output", path: secret },
    { runId: "a", source: "transcript" },
    { runId: "a", source: "output", maxBytes: 8193 },
    { runId: "a", source: "output", maxLines: 0 },
    { runId: "", source: "output" },
  ])
    await expect(f.call("readTail", input)).rejects.toThrow("AgentLogsInvalidInput");
  await expect(f.call("listRuns", { all: true })).rejects.toThrow("AgentLogsInvalidInput");
  await expect(f.call("subscribe")).rejects.toThrow("AgentLogsUnsupported: subscribe");
  const failure = await f
    .call("readTail", { runId: "a", source: "output" })
    .catch((error: unknown) => error as Error);
  expect(String(failure instanceof Error ? failure.message : failure)).toContain(
    "AgentLogsOutOfScope",
  );
  expect(JSON.stringify(failure)).not.toContain(f.tmp);
  expect(String(failure instanceof Error ? failure.message : failure)).not.toContain(f.tmp);
});

it("withholds bytes from a session revoked during the read", async () => {
  const f = await fixture();
  const file = await f.write(NodePath.join(f.projects, SLUG, "s", "a.jsonl"), "PRIVATE-BYTES\n");
  f.rosters.set("thread", [task("a", { outputFile: file })]);
  let checks = 0;
  const failure = await f
    .call(
      "readTail",
      { runId: "a", source: "output" },
      {
        metadata: meta(["orchestration:read"], async () => {
          if (++checks > 1) throw new Error("root revoked");
        }),
      },
    )
    .catch((error: unknown) => error as Error);
  expect(checks).toBe(2);
  expect(String(failure)).toContain("root revoked");
  expect(JSON.stringify(failure)).not.toContain("PRIVATE-BYTES");
});

const CONSUMER_MANIFEST = JSON.stringify({
  format: 2,
  manifest: { id: "test.logs-reader", apiVersion: 1, version: "1.0.0", surfaces: [] },
  serverEntry: "server.mjs",
  tools: [],
  provides: [],
  requires: [{ id: "t3.orchestration/logs", versionRange: "^1.0.0" }],
  dependencies: [],
});

async function installConsumer(f: Awaited<ReturnType<typeof fixture>>, capabilities: string[]) {
  const source = NodePath.join(f.tmp, "package");
  await f.write(NodePath.join(source, "t3-extension.json"), CONSUMER_MANIFEST);
  await f.write(NodePath.join(source, "server.mjs"), "export default {tools:[],apis:[]};");
  const audits: Parameters<NonNullable<RuntimeOptions["auditApi"]>>[0][] = [];
  const runtime = await createExtensionRuntime({
    rootDir: NodePath.join(f.tmp, "state"),
    environmentId: "env",
    services: [],
    apiProviders: [f.provider satisfies HostApiProvider],
    auditApi: (event) => audits.push(event),
    authorize: (installation, grant, scoped) =>
      installation.grants.capabilities.includes(grant) &&
      installation.grants.projectIds.includes(scoped.resource.projectId ?? ""),
  });
  cleanups.push(() => runtime.dispose());
  const installed = await runtime.install(source, { capabilities, projectIds: ["project"] });
  const root = {
    principal: meta().principal!,
    allowWrite: false,
    revalidate: () => {},
  };
  const invoke = (method: string, input: Json, scoped: ViewContext = context) =>
    runtime.invokeApi(
      installed.id,
      installed.contentHash,
      { id: "t3.orchestration/logs", versionRange: "^1.0.0", method, input, context: scoped },
      new AbortController().signal,
      root,
    );
  return { runtime, installed, audits, invoke };
}

it("the broker requires the distinct read-logs grant and audits no payloads", async () => {
  const f = await fixture();
  const file = await f.write(NodePath.join(f.projects, SLUG, "s", "a.jsonl"), "AUDIT-SECRET\n");
  f.rosters.set("thread", [task("a", { outputFile: file })]);
  // Roster read and operate grants never imply log contents.
  const { runtime, installed, audits, invoke } = await installConsumer(f, [
    ORCHESTRATION_READ,
    "t3.orchestration/operate",
  ]);
  await expect(invoke("readTail", { runId: "a", source: "output" })).rejects.toThrow(
    `API capability denied: ${ORCHESTRATION_READ_LOGS}`,
  );
  await runtime.updateGrants(installed.id, {
    capabilities: [ORCHESTRATION_READ_LOGS],
    projectIds: ["project"],
  });
  expect(await invoke("readTail", { runId: "a", source: "output" })).toMatchObject({
    contents: "AUDIT-SECRET\n",
    truncated: false,
  });
  // The installation's project grant bounds which views may read.
  await expect(invoke("listRuns", {}, contextFor("foreign", "project-b"))).rejects.toThrow(
    "Resource is outside installation grants",
  );
  expect(audits.map((event) => event.outcome)).toEqual(["denied", "completed", "denied"]);
  const recorded = JSON.stringify(audits);
  expect(recorded).not.toContain("AUDIT-SECRET");
  expect(recorded).not.toContain(f.tmp);
  expect(recorded).not.toContain('"runId"');
});

it("redacts secrets through the broker, including ones straddling the tail cut", async () => {
  const f = await fixture();
  const { invoke } = await installConsumer(f, [ORCHESTRATION_READ_LOGS]);
  const secrets = {
    env: "sk-proj-ENVSECRETVALUE0123456789abcdef",
    json: "JSONSECRET-0123456789-abcdefghij",
    header: "HDRSECRET0123456789abcdefghijkl",
    pem: "PEMBODYSECRET0123456789abcdefghijklmnopqrstuvwx",
  };
  const cases: { runId: string; secret: string; line: (secret: string) => string }[] = [
    { runId: "env", secret: secrets.env, line: (s) => `export OPENAI_API_KEY=${s}` },
    {
      runId: "json",
      secret: secrets.json,
      line: (s) => `{"type":"tool_result","content":"{\\"apiKey\\": \\"${s}\\"}"}`,
    },
    {
      runId: "escaped-quote",
      secret: "remaining-secret-123",
      line: (s) => String.raw`{"password":"first\"${s}"}`,
    },
    {
      runId: "escaped-quote-transcript",
      secret: "remaining-secret-123",
      line: (s) =>
        JSON.stringify({ type: "tool_result", content: String.raw`{"password":"first\"${s}"}` }),
    },
    {
      runId: "header",
      secret: secrets.header,
      line: (s) => `curl -H "Authorization: Bearer ${s}"`,
    },
    {
      runId: "pem",
      secret: secrets.pem,
      line: (s) => `-----BEGIN RSA PRIVATE KEY-----\n${s}\n${s}\n-----END RSA PRIVATE KEY-----`,
    },
  ];
  f.rosters.set(
    "thread",
    cases.map(({ runId }) =>
      task(runId, { outputFile: NodePath.join(f.projects, SLUG, "s", `${runId}.jsonl`) }),
    ),
  );
  for (const { runId, secret, line } of cases) {
    // The secret's line ends the file, so a cut inside it is delivered as a
    // partial first line rather than dropped.
    const text = `${line(secret)}\n`;
    await f.write(NodePath.join(f.projects, SLUG, "s", `${runId}.jsonl`), `${lines(400)}${text}`);
    const cutInside = text.length - text.indexOf(secret) - Math.floor(secret.length / 2);
    const tail = (await invoke("readTail", {
      runId,
      source: "output",
      maxBytes: cutInside,
    })) as AgentLogTail;
    expect(tail.truncated).toBe(true);
    expect(tail.contents).not.toBe("");
    for (let index = 0; index + 6 <= secret.length; index++)
      expect(tail.contents).not.toContain(secret.slice(index, index + 6));
    // The full tail keeps line structure, with the value replaced by the marker.
    const whole = (await invoke("readTail", { runId, source: "output" })) as AgentLogTail;
    const after = whole.contents.slice(whole.contents.lastIndexOf("line 399 "));
    expect(after).toContain("[REDACTED]");
    expect(after).not.toContain(secret.slice(0, 6));
    expect(after.split("\n").length).toBe(`line 399\n${text}`.split("\n").length);
  }
});

it("binds a run's handle to its own output, rejecting repoints to other runs", async () => {
  const f = await fixture();
  const transcript = (session: string, run: string) =>
    f.write(
      NodePath.join(f.projects, SLUG, session, "subagents", `agent-${run}.jsonl`),
      `${run}\n`,
    );
  const handle = (session: string, run: string) =>
    NodePath.join(f.tasks, SLUG, session, "tasks", `${run}.output`);
  await transcript("sess-a", "a");
  const otherRun = await transcript("sess-a", "b");
  const otherSession = await transcript("sess-b", "b2");
  // Same slug, same session, another run's transcript.
  await f.link(handle("sess-a", "a"), otherRun);
  // Same slug, another session's transcript.
  await f.link(handle("sess-a", "c"), otherSession);
  // A handle outside any session directory.
  const loose = await f.write(NodePath.join(f.projects, SLUG, "loose.jsonl"), "loose\n");
  const own = await f.link(handle("sess-a", "b"), otherRun);
  f.rosters.set("thread", [
    task("a", { outputFile: handle("sess-a", "a") }),
    task("c", { outputFile: handle("sess-a", "c") }),
    task("loose", { outputFile: loose }),
    task("b", { outputFile: own }),
  ]);
  const read = (runId: string) => f.call("readTail", { runId, source: "output" });
  for (const runId of ["a", "c", "loose"])
    await expect(read(runId)).rejects.toThrow("AgentLogsOutOfScope");
  expect(((await read("b")) as AgentLogTail).contents).toBe("b\n");
});

it("binds the session before resolving ancestors, so an aliased ancestor cannot rebind it", async () => {
  const f = await fixture();
  const sessionB = NodePath.join(f.tasks, SLUG, "sess-b", "tasks");
  await f.write(NodePath.join(sessionB, "a.output"), "SESSION-B-OUTPUT\n");
  const transcriptB = await f.write(
    NodePath.join(f.projects, SLUG, "sess-b", "subagents", "agent-c.jsonl"),
    "SESSION-B-TRANSCRIPT\n",
  );
  await f.link(NodePath.join(sessionB, "c.output"), transcriptB);
  // Session A's tasks directory is a stable alias of session B's.
  await f.link(NodePath.join(f.tasks, SLUG, "sess-a", "tasks"), sessionB);
  // So is a whole session directory under the transcript root.
  await f.link(
    NodePath.join(f.projects, SLUG, "sess-d"),
    NodePath.join(f.projects, SLUG, "sess-b"),
  );
  f.rosters.set("thread", [
    task("a", { outputFile: NodePath.join(f.tasks, SLUG, "sess-a", "tasks", "a.output") }),
    task("c", { outputFile: NodePath.join(f.tasks, SLUG, "sess-a", "tasks", "c.output") }),
    task("d", {
      outputFile: NodePath.join(f.projects, SLUG, "sess-d", "subagents", "agent-c.jsonl"),
    }),
    task("b", { outputFile: NodePath.join(sessionB, "c.output") }),
  ]);
  const read = (runId: string) => f.call("readTail", { runId, source: "output" });
  for (const runId of ["a", "c", "d"]) {
    const failure = await read(runId).then(
      (tail) => new Error(`delivered ${JSON.stringify(tail)}`),
      (error: unknown) => error as Error,
    );
    expect(failure.message, runId).toContain("AgentLogsOutOfScope");
    expect(JSON.stringify(failure), runId).not.toContain("SESSION-B");
  }
  // Session B's own handle still reads its own transcript.
  expect(((await read("b")) as AgentLogTail).contents).toBe("SESSION-B-TRANSCRIPT\n");
});

it("fails closed when an ancestor is swapped around the open, without leaking paths", async () => {
  for (const when of ["before-open", "after-open", "unlink-after-open"] as const) {
    let swap = async () => {};
    const f = await fixture({
      open: (async (path: string, flags: number) => {
        if (when === "before-open") await swap();
        const file = await NodeFSP.open(path, flags);
        if (when !== "before-open") await swap();
        return file;
      }) as typeof NodeFSP.open,
    });
    const session = NodePath.join(f.projects, SLUG, "s");
    const file = await f.write(NodePath.join(session, "a.jsonl"), "INSIDE\n");
    const outside = NodePath.join(f.tmp, "outside");
    await f.write(NodePath.join(outside, "a.jsonl"), "SECRET-OUTSIDE\n");
    swap =
      when === "unlink-after-open"
        ? () => NodeFSP.unlink(file)
        : async () => {
            await NodeFSP.rename(session, `${session}-moved`);
            await NodeFSP.symlink(outside, session);
          };
    f.rosters.set("thread", [task("a", { outputFile: file })]);
    const failure = (await f
      .call("readTail", { runId: "a", source: "output" })
      .catch((error: unknown) => error)) as Error;
    expect(failure.message, when).toContain("AgentLogsSourceChanged");
    expect(JSON.stringify(failure), when).not.toContain("SECRET-OUTSIDE");
    expect(failure.message, when).not.toContain(f.tmp);
    expect(JSON.stringify(failure), when).not.toContain(f.tmp);
  }
});

it("reports runs the roster's retention cap evicted", async () => {
  const f = await fixture();
  const file = await f.write(NodePath.join(f.projects, SLUG, "s", "a.jsonl"), "a\n");
  const newer = (index: number) =>
    `2026-09-26T00:00:${String(index % 60).padStart(2, "0")}.${String(index).padStart(3, "0")}Z`;
  const qualifying = Array.from({ length: 100 }, (_, index) =>
    task(`run-${index}`, { outputFile: file }, newer(index + 1)),
  );
  // The oldest row is the one evicted; whether it counts depends on its handle.
  f.rosters.set("thread", [task("oldest", { outputFile: file }, newer(0)), ...qualifying]);
  const capped = (await f.call("listRuns")) as AgentLogRuns;
  expect(capped.runs).toHaveLength(100);
  expect(capped.runs.map((run) => run.runId)).not.toContain("oldest");
  expect(capped.truncated).toBe(true);
  await expect(f.call("readTail", { runId: "oldest", source: "output" })).rejects.toThrow(
    "AgentLogsRunUnknown",
  );

  f.rosters.set("thread", [task("oldest", {}, newer(0)), ...qualifying]);
  expect(await f.call("listRuns")).toMatchObject({ truncated: false });
  expect(((await f.call("listRuns")) as AgentLogRuns).runs).toHaveLength(100);
});

it("applies the default line ceiling and a decoded byte budget", async () => {
  const f = await fixture();
  const newlines = await f.write(
    NodePath.join(f.projects, SLUG, "s", "n.jsonl"),
    "\n".repeat(1001),
  );
  // 8,191 ASCII bytes and a dangling UTF-8 lead byte decode to 8,194 bytes.
  const dangling = await f.write(
    NodePath.join(f.projects, SLUG, "s", "d.jsonl"),
    Buffer.concat([Buffer.alloc(8191, "a"), Buffer.from([0xe2])]),
  );
  f.rosters.set("thread", [
    task("n", { outputFile: newlines }),
    task("d", { outputFile: dangling }),
  ]);
  const n = (await f.call("readTail", { runId: "n", source: "output" })) as AgentLogTail;
  expect(n.contents).toBe("\n".repeat(1000));
  expect(n.truncated).toBe(true);
  const d = (await f.call("readTail", { runId: "d", source: "output" })) as AgentLogTail;
  expect(Buffer.byteLength(d.contents)).toBeLessThanOrEqual(8192);
  expect(d.truncated).toBe(true);
  expect(d.byteLength).toBe(8192);
  const small = (await f.call("readTail", {
    runId: "d",
    source: "output",
    maxBytes: 100,
  })) as AgentLogTail;
  expect(Buffer.byteLength(small.contents)).toBeLessThanOrEqual(100);
});
