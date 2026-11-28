// @effect-diagnostics nodeBuiltinImport:off - Exercises private Unix socket ownership and cleanup.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";
import { expect, vi } from "vite-plus/test";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as CodexManagedTokenBroker from "./CodexManagedTokenBroker.ts";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFSP>()),
}));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOS>()),
}));

type Parent =
  | "private"
  | "root-sticky"
  | "unmapped"
  | "writable"
  | "missing"
  | "read-only"
  | "long";
const cases: {
  name: string;
  runtime?: Parent | "relative";
  temp?: Parent;
  tmp: Parent;
  varTmp: Parent;
  home: Parent;
  selected: "runtime" | "temp" | "tmp" | "varTmp" | "home" | null;
}[] = [
  {
    name: "prefers a private XDG runtime directory",
    runtime: "private",
    tmp: "root-sticky",
    varTmp: "root-sticky",
    home: "private",
    selected: "runtime",
  },
  {
    name: "keeps root-owned sticky temp directories working",
    tmp: "root-sticky",
    varTmp: "missing",
    home: "missing",
    selected: "tmp",
  },
  {
    name: "keeps user-owned private temp directories working",
    tmp: "private",
    varTmp: "missing",
    home: "missing",
    selected: "tmp",
  },
  {
    name: "honors a usable OS temp directory before shared temp directories",
    temp: "private",
    tmp: "root-sticky",
    varTmp: "root-sticky",
    home: "private",
    selected: "temp",
  },
  {
    name: "falls back to tmp when a distinct OS temp directory is untrusted",
    temp: "unmapped",
    tmp: "root-sticky",
    varTmp: "missing",
    home: "missing",
    selected: "tmp",
  },
  {
    name: "uses var/tmp when shared tmp has an unmapped owner",
    tmp: "unmapped",
    varTmp: "root-sticky",
    home: "private",
    selected: "varTmp",
  },
  {
    name: "uses home when both shared temp directories have unmapped owners",
    tmp: "unmapped",
    varTmp: "unmapped",
    home: "private",
    selected: "home",
  },
  {
    name: "ignores relative XDG runtime directories",
    runtime: "relative",
    tmp: "private",
    varTmp: "missing",
    home: "missing",
    selected: "tmp",
  },
  {
    name: "rejects foreign-owned sticky runtime directories",
    runtime: "unmapped",
    tmp: "private",
    varTmp: "missing",
    home: "missing",
    selected: "tmp",
  },
  {
    name: "rejects user-owned group-writable runtime directories",
    runtime: "writable",
    tmp: "private",
    varTmp: "missing",
    home: "missing",
    selected: "tmp",
  },
  {
    name: "falls back from a missing runtime directory",
    runtime: "missing",
    tmp: "private",
    varTmp: "missing",
    home: "missing",
    selected: "tmp",
  },
  {
    name: "falls back from a read-only runtime directory",
    runtime: "read-only",
    tmp: "private",
    varTmp: "missing",
    home: "missing",
    selected: "tmp",
  },
  {
    name: "cleans overlong UTF-8 socket paths before falling back",
    runtime: "long",
    tmp: "private",
    varTmp: "missing",
    home: "missing",
    selected: "tmp",
  },
  {
    name: "uses home when var/tmp does not exist",
    tmp: "unmapped",
    varTmp: "missing",
    home: "private",
    selected: "home",
  },
  {
    name: "fails closed when every existing parent is untrusted",
    runtime: "writable",
    tmp: "unmapped",
    varTmp: "unmapped",
    home: "writable",
    selected: null,
  },
  {
    name: "fails closed when no candidate exists",
    runtime: "missing",
    tmp: "missing",
    varTmp: "missing",
    home: "missing",
    selected: null,
  },
];

it.live.each(cases)("$name", (testCase) =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    const uid = yield* HostProcess.UserId;
    const root = yield* Effect.acquireRelease(
      Effect.promise(async () => NodeFSP.realpath(await NodeFSP.mkdtemp("/tmp/t3-ipc-test-"))),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    const parents = {
      runtime: NodePath.join(root, testCase.runtime === "long" ? "é".repeat(40) : "runtime"),
      temp: NodePath.join(root, "os-temp"),
      tmp: NodePath.join(root, "tmp"),
      varTmp: NodePath.join(root, "var-tmp"),
      home: NodePath.join(root, "home"),
    };
    yield* Effect.promise(() =>
      Promise.all(Object.values(parents).map((parent) => NodeFSP.mkdir(parent, { mode: 0o700 }))),
    );
    const policies = new Map(
      Object.entries(parents).map(([name, parent]) => [
        parent,
        testCase[name as keyof typeof parents],
      ]),
    );
    const realpath = NodeFSP.realpath;
    const lstat = NodeFSP.lstat;
    const mkdtemp = NodeFSP.mkdtemp;
    using _tmpdir = vi
      .spyOn(NodeOS, "tmpdir")
      .mockReturnValue(testCase.temp ? parents.temp : "/tmp");
    using _realpath = vi.spyOn(NodeFSP, "realpath").mockImplementation((async (target: string) => {
      const parent =
        target === "/tmp" ? parents.tmp : target === "/var/tmp" ? parents.varTmp : target;
      if (policies.get(parent) === "missing") throw new Error("ENOENT");
      return realpath(parent);
    }) as typeof NodeFSP.realpath);
    using _lstat = vi.spyOn(NodeFSP, "lstat").mockImplementation((async (target: string) => {
      const stat = await lstat(target);
      switch (policies.get(target)) {
        case "unmapped":
          return Object.assign(stat, { uid: 65534, mode: 0o41777 });
        case "root-sticky":
          return Object.assign(stat, { uid: 0, mode: 0o41777 });
        case "writable":
          return Object.assign(stat, { uid, mode: 0o40770 });
        default:
          return stat;
      }
    }) as typeof NodeFSP.lstat);
    using _mkdtemp = vi.spyOn(NodeFSP, "mkdtemp").mockImplementation((async (prefix: string) => {
      if (policies.get(NodePath.dirname(prefix)) === "read-only") throw new Error("EROFS");
      return mkdtemp(prefix);
    }) as typeof NodeFSP.mkdtemp);
    const result = yield* Effect.gen(function* () {
      const broker = yield* CodexManagedTokenBroker.CodexManagedTokenBroker;
      const endpoint = yield* broker.endpoint;
      expect(testCase.selected).not.toBeNull();
      expect(NodePath.dirname(NodePath.dirname(endpoint))).toBe(parents[testCase.selected!]);
      expect(Buffer.byteLength(endpoint)).toBeLessThanOrEqual(100);
      const directory = yield* Effect.promise(() => lstat(NodePath.dirname(endpoint)));
      expect(directory.uid).toBe(uid);
      expect(directory.mode & 0o777).toBe(0o700);
      const socket = yield* Effect.promise(() => lstat(endpoint));
      expect(socket.isSocket()).toBe(true);
      expect(socket.mode & 0o777).toBe(0o600);
      return endpoint;
    }).pipe(
      Effect.provide(CodexManagedTokenBroker.layer),
      Effect.provideService(HostProcess.Environment, {
        XDG_RUNTIME_DIR:
          testCase.runtime === "relative"
            ? "relative/runtime"
            : testCase.runtime
              ? parents.runtime
              : undefined,
      }),
      Effect.provideService(HostProcess.HomeDirectory, parents.home),
      Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(
          EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
        ),
      }),
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ServerSecretStore.ServerSecretStore)({}),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Unexpected token request")),
          ),
          NodeCrypto.layer,
        ),
      ),
      Effect.scoped,
      Effect.result,
    );
    expect(result._tag).toBe(testCase.selected === null ? "Failure" : "Success");
    if (result._tag === "Failure") expect(result.failure._tag).toBe("ManagedTokenBrokerStartError");
    for (const parent of Object.values(parents))
      expect(yield* Effect.promise(() => NodeFSP.readdir(parent))).toEqual([]);
  }).pipe(Effect.scoped),
);
