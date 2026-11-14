// @effect-diagnostics nodeBuiltinImport:off -- Builds the zip Azure returns and stands in for az writing it.
import * as NodeFS from "node:fs";
import * as NodeZlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import type { ProviderChangeRequest } from "@t3tools/source-control-core/server/PullRequestProvider";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsPullRequestCli from "./AzureDevOpsPullRequestCli.ts";
import * as AzureDevOpsPullRequestProvider from "./AzureDevOpsPullRequestProvider.ts";
import * as AzureDevOpsSourceControlProvider from "./AzureDevOpsSourceControlProvider.ts";
import { decodeAzureDevOpsPullRequestJson } from "./azureDevOpsPullRequests.ts";

const mockedExecute = vi.fn<AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]>();

const layer = it.layer(
  AzureDevOpsPullRequestCli.layer.pipe(
    Layer.provide(
      Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
        execute: mockedExecute,
      }),
    ),
    Layer.provide(NodeServices.layer),
  ),
);

function output(stdout: string) {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

const VCS_DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

function outputWithin(maxOutputBytes: number | undefined, response: string) {
  const ceiling = maxOutputBytes ?? VCS_DEFAULT_MAX_OUTPUT_BYTES;
  return ceiling >= Buffer.byteLength(response)
    ? output(response)
    : { ...output(response.slice(0, ceiling)), stdoutTruncated: true };
}

const json = (value: Record<string, unknown>) => JSON.stringify(value);

const pullRequestRow = {
  pullRequestId: 42,
  title: "Add the page",
  status: "active",
  sourceRefName: "refs/heads/feat/page",
  targetRefName: "refs/heads/main",
  creationDate: "2026-07-01T00:00:00Z",
  url: "https://dev.azure.com/acme/_apis/git/repositories/web/pullRequests/42",
  repository: { name: "web", project: { name: "platform" } },
};

const oneIteration = {
  value: [
    {
      id: 1,
      sourceRefCommit: { commitId: "a".repeat(40) },
      commonRefCommit: { commitId: "b".repeat(40) },
    },
  ],
};

function pullRequestRows(
  count: number,
  firstNumber: number,
): ReadonlyArray<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    pullRequestId: firstNumber + index,
    title: `Pull request ${firstNumber + index}`,
    status: "active",
    sourceRefName: "refs/heads/feat/page",
    targetRefName: "refs/heads/main",
    creationDate: "2026-07-01T00:00:00Z",
    repository: { name: "web", project: { name: "platform" } },
    url: `https://dev.azure.com/acme/_apis/git/repositories/web/pullRequests/${firstNumber + index}`,
  }));
}

function pullRequests(count: number, firstNumber: number): string {
  return JSON.stringify(pullRequestRows(count, firstNumber));
}

/** Entries as Azure streams them: data descriptors, with sizes only in the central directory. */
function streamedZip(
  entries: ReadonlyArray<{
    readonly name: string;
    readonly data: Uint8Array;
    readonly stored?: true;
  }>,
): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const method = entry.stored ? 0 : 8;
    const body = entry.stored ? Buffer.from(entry.data) : NodeZlib.deflateRawSync(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0x0008, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(name.length, 26);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(body.length, 8);
    descriptor.writeUInt32LE(entry.data.length, 12);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0008, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    parts.push(local, name, body, descriptor);
    directory.push(central, name);
    offset += local.length + name.length + body.length + descriptor.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralDirectory, end]);
}

function argsOfCall(index: number): ReadonlyArray<string> {
  const call = mockedExecute.mock.calls[index];
  assert.isDefined(call);
  return call[0].args;
}

function changeEntries(count: number): ReadonlyArray<Record<string, unknown>> {
  const commit = "c".repeat(40);
  return Array.from({ length: count }, (_, index) => {
    const path = `/apps/server/src/generated/module-${index}/persisted-projection-${index}.ts`;
    return {
      changeType: "edit",
      item: {
        path,
        objectId: "a".repeat(40),
        originalObjectId: "b".repeat(40),
        commitId: commit,
        gitObjectType: "blob",
        url: `https://dev.azure.com/acme/platform/_apis/git/repositories/6f9c9b7f-0000-0000-0000-000000000000/items${path}?versionType=Commit&version=${commit}`,
      },
    };
  });
}

const mockedRun = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>();

afterEach(() => {
  mockedExecute.mockReset();
  mockedRun.mockReset();
});

/** Both providers over one process, as the driver composes them. */
const driverServices = AzureDevOpsPullRequestCli.layer.pipe(
  Layer.provideMerge(AzureDevOpsCli.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      TestSourceControlHost.layer({ process: { run: mockedRun } }),
      NodeServices.layer,
    ),
  ),
);

it.effect(
  "dates an old pull request by its latest activity and shares reads across providers",
  () =>
    Effect.gen(function* () {
      const pushedAt = "2026-07-10T12:00:00+02:00";
      const thread = (id: number, at: string, content: string, commentType = "text") => ({
        id,
        publishedDate: at,
        lastUpdatedDate: at,
        comments: [{ id: 1, content, commentType, publishedDate: at, lastUpdatedDate: at }],
      });
      const refUpdate = (at: string) =>
        thread(1, at, "The reference refs/heads/feat/page was updated.", "system");
      const comment = (at: string) => thread(2, at, "Looks good.");
      let shown = {
        ...pullRequestRow,
        creationDate: "2026-06-01T00:00:00Z",
        isDraft: false,
        lastMergeSourceCommit: { commitId: "a".repeat(40) },
      };
      let forks: ReadonlyArray<Record<string, unknown>> = [];
      let threads = json({ value: [refUpdate(pushedAt), comment("2026-07-10T10:30:00.1234567Z")] });
      let threadsAsked = yield* Deferred.make<void>();
      let threadsAnswer = yield* Deferred.make<void>();
      mockedRun.mockImplementation(({ args }) => {
        if (args.includes("pullRequestThreads")) {
          return Deferred.succeed(threadsAsked, undefined).pipe(
            Effect.andThen(Deferred.await(threadsAnswer)),
            Effect.as(output(threads)),
          );
        }
        if (args.includes("pullRequestIterations")) {
          const pushed = { ...oneIteration.value[0], createdDate: pushedAt, updatedDate: pushedAt };
          return Effect.succeed(output(json({ value: [pushed] })));
        }
        if (args.includes("pullRequestIterationChanges")) {
          return Effect.succeed(output(json({ changeEntries: [] })));
        }
        return Effect.succeed(
          output(JSON.stringify(args.includes("list") ? [shown, ...forks] : shown)),
        );
      });
      const threadReads = () =>
        mockedRun.mock.calls.filter(([call]) => call.args.includes("pullRequestThreads")).length;

      const provider = yield* AzureDevOpsPullRequestProvider.make;
      const sourceControl = yield* AzureDevOpsSourceControlProvider.make;
      const input = { cwd: "/w", repository: "platform/web", host: "dev.azure.com", number: 42 };
      const summary = provider.getChangeRequestSummary!(input).pipe(
        Effect.map((read) => read.updatedAt),
      );
      const reading = yield* Effect.forkChild(
        Effect.all(
          {
            summary,
            branch: sourceControl
              .getChangeRequest({ cwd: "/w", reference: "42" })
              .pipe(Effect.map((read) => Option.map(read.updatedAt, DateTime.formatIso))),
          },
          { concurrency: "unbounded" },
        ),
      );
      yield* Effect.raceFirst(Deferred.await(threadsAsked), Fiber.await(reading));
      yield* Deferred.succeed(threadsAnswer, undefined);

      const edited = "2026-07-10T10:30:00.123Z";
      expect(yield* Fiber.join(reading)).toEqual({
        summary: edited,
        branch: Option.some(edited),
      });
      expect(threadReads()).toBe(1);
      // Asking for the conversation itself always reads it, and the read dates the row as well.
      const activity = yield* provider.getChangeRequestActivity(input);
      expect(activity.comments.map((entry) => entry.body)).toEqual(["Looks good."]);
      expect(threadReads()).toBe(2);

      threads = json({ value: [refUpdate(pushedAt), comment("2026-07-10T11:00:00Z")] });
      expect(yield* summary).toBe(edited);
      yield* TestClock.adjust("61 seconds");
      expect(yield* summary).toBe("2026-07-10T11:00:00.000Z");
      expect(threadReads()).toBe(3);

      shown = { ...shown, lastMergeSourceCommit: { commitId: "c".repeat(40) } };
      threads = json({
        value: [refUpdate("2026-07-10T11:05:00Z"), comment("2026-07-10T11:00:00Z")],
      });
      const branchLookup = (state: "open" | "all") =>
        sourceControl
          .listChangeRequests({ cwd: "/w", headSelector: "feat/page", state, limit: 100 })
          .pipe(Effect.map((rows) => rows.map((row) => [row.number, row.isCrossRepository])));
      // Branch lookups list candidates, including forks' same-named branches, without dating them.
      forks = pullRequestRows(3, 100).map((row) => ({ ...row, forkSource: {} }));
      const candidates = [
        [42, false],
        [100, true],
        [101, true],
        [102, true],
      ];
      expect(yield* branchLookup("open")).toEqual(candidates);
      expect(yield* branchLookup("all")).toEqual(candidates);
      expect(threadReads()).toBe(3);
      forks = [];
      expect(yield* summary).toBe("2026-07-10T11:05:00.000Z");
      expect(threadReads()).toBe(4);

      threads = "not json";
      yield* TestClock.adjust("61 seconds");
      expect(yield* summary).toBe("2026-07-10T11:05:00.000Z");
      expect(threadReads()).toBe(5);

      // A push seen while an older read is out is not answered by that read.
      const pullRequests = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;
      const datedAt = (revision: string) =>
        pullRequests.activityAt({
          cwd: "/w",
          pullRequest: {
            number: 42,
            location: { project: "platform", repository: "web" },
            state: "open",
            revision,
            updatedAt: null,
          },
          maxAge: AzureDevOpsPullRequestCli.ACTIVITY_MAX_AGE,
        });
      threadsAsked = yield* Deferred.make<void>();
      threadsAnswer = yield* Deferred.make<void>();
      threads = json({
        value: [refUpdate("2026-07-10T11:05:00Z"), comment("2026-07-10T11:10:00Z")],
      });
      const beforePush = yield* Effect.forkChild(datedAt("before push"));
      yield* Deferred.await(threadsAsked);
      threads = json({
        value: [refUpdate("2026-07-10T11:20:00Z"), comment("2026-07-10T11:10:00Z")],
      });
      const afterPush = yield* Effect.forkChild(datedAt("after push"), { startImmediately: true });
      yield* Deferred.succeed(threadsAnswer, undefined);
      yield* Fiber.join(beforePush);
      expect(yield* Fiber.join(afterPush)).toBe("2026-07-10T11:20:00.000Z");
      expect(threadReads()).toBe(7);
      expect(yield* datedAt("after push")).toBe("2026-07-10T11:20:00.000Z");
      expect(threadReads()).toBe(7);

      // A refresh reaches a new comment at once, but only on the pull requests it names.
      threads = json({
        value: [refUpdate("2026-07-10T11:20:00Z"), comment("2026-07-10T11:30:00Z")],
      });
      yield* provider.forgetChangeRequestReads!({ repository: "acme/other" });
      yield* provider.forgetChangeRequestReads!({ repository: "platform/web", number: 43 });
      expect(yield* datedAt("after push")).toBe("2026-07-10T11:20:00.000Z");
      expect(threadReads()).toBe(7);
      yield* provider.forgetChangeRequestReads!({ repository: "Platform/Web", number: 42 });
      expect(yield* datedAt("after push")).toBe("2026-07-10T11:30:00.000Z");
      expect(threadReads()).toBe(8);

      // A read already out when a refresh comes cannot answer for it.
      yield* provider.forgetChangeRequestReads!({ repository: "platform/web" });
      threadsAsked = yield* Deferred.make<void>();
      threadsAnswer = yield* Deferred.make<void>();
      const beforeRefresh = yield* Effect.forkChild(datedAt("after push"));
      yield* Deferred.await(threadsAsked);
      threads = json({
        value: [refUpdate("2026-07-10T11:20:00Z"), comment("2026-07-10T11:40:00Z")],
      });
      yield* provider.forgetChangeRequestReads!();
      const afterRefresh = yield* Effect.forkChild(datedAt("after push"), {
        startImmediately: true,
      });
      yield* Deferred.succeed(threadsAnswer, undefined);
      yield* Fiber.join(beforeRefresh);
      expect(yield* Fiber.join(afterRefresh)).toBe("2026-07-10T11:40:00.000Z");
      expect(threadReads()).toBe(10);
      expect(yield* datedAt("after push")).toBe("2026-07-10T11:40:00.000Z");
      expect(threadReads()).toBe(10);

      // An action's reply is dated like a read, and nothing reads the pull request again.
      const shows = () =>
        mockedRun.mock.calls.filter(([call]) => call.args.includes("show")).length;
      const shownBefore = shows();
      shown = { ...shown, isDraft: true };
      const drafted = yield* provider.runAction({ ...input, action: "draft" });
      expect(drafted && drafted.updatedAt).toBe("2026-07-10T11:40:00.000Z");
      expect(threadReads()).toBe(11);
      expect(shows()).toBe(shownBefore);
    }).pipe(Effect.provide(driverServices)),
);

layer("AzureDevOpsPullRequestCli.layer", (it) => {
  it.effect("replaces a read interrupted before its process starts", () =>
    Effect.gen(function* () {
      const readingClock = yield* Deferred.make<void>();
      const baseClock = yield* Clock.Clock;
      let clockReads = 0;
      const clock = {
        ...baseClock,
        currentTimeMillis: Effect.sync(() => {
          clockReads += 1;
          if (clockReads === 2) Deferred.doneUnsafe(readingClock, Effect.void);
          return baseClock.currentTimeMillisUnsafe();
        }),
      };
      mockedExecute.mockReturnValue(Effect.succeed(output(json({ value: [] }))));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;
      const read = cli.activityAt({
        cwd: "/interrupted",
        pullRequest: {
          number: 42,
          location: { project: "platform", repository: "web" },
          state: "open",
          revision: "r",
          updatedAt: null,
        },
        maxAge: AzureDevOpsPullRequestCli.ACTIVITY_MAX_AGE,
      });
      const owner = yield* Effect.forkChild(read.pipe(Effect.provideService(Clock.Clock, clock)));
      yield* Effect.raceFirst(Deferred.await(readingClock), Fiber.await(owner));
      yield* Fiber.interrupt(owner);
      const replacement = yield* Effect.forkChild(read, { startImmediately: true });
      expect(mockedExecute).toHaveBeenCalledTimes(1);
      expect(yield* Fiber.join(replacement)).toBeNull();
    }),
  );

  it.effect(
    "reads a conversation queued behind a long list at once, and shares one already out",
    () =>
      Effect.gen(function* () {
        const fourStarted = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let started = 0;
        mockedExecute.mockImplementation(({ args }) =>
          Effect.gen(function* () {
            started += 1;
            if (started === 4) yield* Deferred.succeed(fourStarted, undefined);
            if (!args.includes("pullRequestId=5")) yield* Deferred.await(release);
            return output(json({ value: [] }));
          }),
        );
        const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;
        const location = { project: "platform", repository: "web" };
        const pullRequest = (number: number) => ({ cwd: "/queue", location, number });
        const dated = (number: number) =>
          cli.activityAt({
            cwd: "/queue",
            pullRequest: { number, location, state: "open", revision: "r", updatedAt: null },
            maxAge: AzureDevOpsPullRequestCli.ACTIVITY_MAX_AGE,
          });

        const list = yield* Effect.forkChild(
          Effect.forEach([1, 2, 3, 4], dated, { concurrency: "unbounded" }),
        );
        yield* Deferred.await(fourStarted);
        const queued = yield* Effect.forkChild(dated(5), { startImmediately: true });
        const shared = yield* Effect.forkChild(cli.listThreads(pullRequest(1)), {
          startImmediately: true,
        });

        expect(yield* cli.listThreads(pullRequest(5))).toEqual([]);
        expect(started).toBe(5);
        expect(yield* Fiber.join(queued)).toBeNull();
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(list);
        expect(yield* Fiber.join(shared)).toEqual([]);
        expect(started).toBe(5);
      }),
  );

  it.effect("answers a list before dating its rows, then dates each once", () =>
    Effect.gen(function* () {
      const fourStarted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const commentedAt = (number: number) => `2026-07-1${number}T09:00:00.000Z`;
      const threads = (number: number) =>
        json({
          value: [
            {
              id: 1,
              publishedDate: commentedAt(number),
              lastUpdatedDate: commentedAt(number),
              comments: [{ id: 1, content: "Looks good.", commentType: "text" }],
            },
          ],
        });
      const threadReads: number[] = [];
      mockedExecute.mockImplementation(({ args }) =>
        Effect.gen(function* () {
          if (!args.includes("pullRequestThreads")) {
            if (args.includes("list")) return output(pullRequests(6, 1));
            return output(json(pullRequestRows(1, Number(args[args.indexOf("--id") + 1]))[0]!));
          }
          const number = Number(/pullRequestId=(\d+)/u.exec(args.join(" "))?.[1]);
          threadReads.push(number);
          if (threadReads.length === 4) yield* Deferred.succeed(fourStarted, undefined);
          if (number !== 6) yield* Deferred.await(release);
          return output(number === 3 ? "not json" : threads(number));
        }),
      );
      const provider = yield* AzureDevOpsPullRequestProvider.make;
      const list = provider.listChangeRequests({
        cwd: "/listed",
        repository: "platform/web",
        host: "dev.azure.com",
        state: "open",
        involvement: "all",
        viewer: "bilal@acme.dev",
        limit: 6,
      });
      const rows = (page: { readonly items: ReadonlyArray<ProviderChangeRequest> }) =>
        page.items.map(({ number, updatedAt, updatedAtState }) => ({
          number,
          updatedAt,
          ...(updatedAtState === undefined ? {} : { updatedAtState }),
        }));

      const first = yield* Effect.raceFirst(
        Effect.asSome(list),
        Deferred.await(fourStarted).pipe(Effect.as(Option.none())),
      );
      assert.isTrue(Option.isSome(first), "the list waited for its rows' activity");
      const page = Option.getOrThrow(first);
      expect(threadReads).toEqual([]);
      expect(rows(page)).toEqual(
        [1, 2, 3, 4, 5, 6].map((number) => ({
          number,
          updatedAt: "2026-07-01T00:00:00.000Z",
          updatedAtState: "pending",
        })),
      );

      const settling = yield* Effect.forkChild(page.settleUpdatedAt!);
      yield* Deferred.await(fourStarted);
      expect(threadReads).toEqual([1, 2, 3, 4]);
      const sourceControl = yield* AzureDevOpsSourceControlProvider.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
              getPullRequest: () =>
                Effect.succeed(
                  Result.getOrThrow(
                    decodeAzureDevOpsPullRequestJson(JSON.stringify(pullRequestRows(1, 6)[0])),
                  ),
                ),
            }),
            TestSourceControlHost.layer(),
          ),
        ),
      );
      const reference = yield* Effect.forkChild(
        sourceControl.getChangeRequest({ cwd: "/listed", reference: "6" }),
        { startImmediately: true },
      );
      expect(threadReads).toEqual([1, 2, 3, 4, 6]);
      expect(Option.map((yield* Fiber.join(reference)).updatedAt, DateTime.formatIso)).toEqual(
        Option.some(commentedAt(6)),
      );
      // Opening a pull request still queued behind the list reads it at once.
      const summary = yield* provider.getChangeRequestSummary!({
        cwd: "/listed",
        repository: "platform/web",
        host: "dev.azure.com",
        number: 6,
      });
      expect(summary.updatedAt).toBe(commentedAt(6));
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(settling)).toBe(true);
      expect(threadReads.toSorted()).toEqual([1, 2, 3, 4, 5, 6]);

      const dated = yield* list;
      expect(rows(dated)).toEqual(
        [1, 2, 3, 4, 5, 6].map((number) =>
          number === 3
            ? { number, updatedAt: "2026-07-01T00:00:00.000Z", updatedAtState: "unavailable" }
            : { number, updatedAt: commentedAt(number) },
        ),
      );
      expect(dated.settleUpdatedAt).toBeUndefined();
      expect(threadReads).toHaveLength(6);

      const action = yield* provider.runAction({
        cwd: "/listed",
        repository: "platform/web",
        host: "dev.azure.com",
        number: 3,
        action: "draft",
      });
      expect(action).toMatchObject({
        updatedAt: "2026-07-01T00:00:00.000Z",
        updatedAtState: "unavailable",
      });

      // Old dates are shown while they are read again, which needs no refresh when none moved.
      yield* provider.forgetChangeRequestReads!();
      const forgotten = yield* list;
      expect(rows(forgotten)).toEqual(rows(dated));
      expect(yield* forgotten.settleUpdatedAt!).toBe(false);
      expect(threadReads).toHaveLength(12);
      yield* TestClock.adjust("31 seconds");
      const stale = yield* list;
      expect(rows(stale)).toEqual(rows(dated));
      expect(yield* stale.settleUpdatedAt!).toBe(false);
      expect(threadReads).toHaveLength(18);
    }),
  );

  it.effect("keeps the dates of a list larger than its cache, so it settles once", () =>
    Effect.gen(function* () {
      const count = AzureDevOpsPullRequestCli.ACTIVITY_CACHE_CAPACITY + 1;
      let threadReads = 0;
      mockedExecute.mockImplementation(({ args }) => {
        if (!args.includes("pullRequestThreads")) {
          return Effect.succeed(output(pullRequests(count, 1)));
        }
        threadReads += 1;
        return Effect.succeed(
          output(
            json({
              value: [{ id: 1, publishedDate: "2026-07-20T00:00:00Z", comments: [{ id: 1 }] }],
            }),
          ),
        );
      });
      const provider = yield* AzureDevOpsPullRequestProvider.make;
      const list = provider.listChangeRequests({
        cwd: "/crowded",
        repository: "platform/web",
        host: "dev.azure.com",
        state: "open",
        involvement: "all",
        viewer: "bilal@acme.dev",
        limit: count,
      });

      const cold = yield* list;
      expect(cold.items.filter((row) => row.updatedAtState === "pending")).toHaveLength(count);
      expect(yield* cold.settleUpdatedAt!).toBe(true);
      expect(threadReads).toBe(count);

      const settled = yield* list;
      expect(settled.settleUpdatedAt).toBeUndefined();
      expect(settled.items.filter((row) => row.updatedAtState !== undefined)).toEqual([]);
      expect(new Set(settled.items.map((row) => row.updatedAt))).toEqual(
        new Set(["2026-07-20T00:00:00.000Z"]),
      );
      expect(threadReads).toBe(count);

      yield* provider.forgetChangeRequestReads!({ repository: "platform/web" });
      yield* (yield* list).settleUpdatedAt!;
      expect(threadReads).toBe(count * 2);
    }),
  );

  it.effect("reports the latest pushed source commit even while the trial merge is stale", () =>
    Effect.gen(function* () {
      const previousHead = "a".repeat(40);
      const latestHead = "c".repeat(40);
      mockedExecute.mockImplementation(({ args }) => {
        if (args.includes("pullRequestIterations")) {
          return Effect.succeed(
            output(
              json({
                value: [
                  {
                    id: 2,
                    sourceRefCommit: { commitId: latestHead },
                    commonRefCommit: { commitId: "b".repeat(40) },
                  },
                  ...oneIteration.value,
                ],
              }),
            ),
          );
        }
        if (args.includes("pullRequestIterationChanges")) {
          return Effect.succeed(output(json({ changeEntries: [] })));
        }
        if (args.includes("policy")) return Effect.succeed(output("[]"));
        if (args.includes("pullRequestThreads")) return Effect.succeed(output(json({ value: [] })));
        return Effect.succeed(
          output(json({ ...pullRequestRow, lastMergeSourceCommit: { commitId: previousHead } })),
        );
      });
      const provider = yield* AzureDevOpsPullRequestProvider.make;
      const detail = yield* provider.getChangeRequest({
        cwd: "/w",
        repository: "platform/web",
        host: "dev.azure.com",
        number: 42,
      });

      expect(detail.headSha).toBe(latestHead);
      const changes = mockedExecute.mock.calls.find(([call]) =>
        call.args.includes("pullRequestIterationChanges"),
      );
      expect(changes?.[0].args).toContain("iterationId=2");
      expect(mockedExecute).toHaveBeenCalledTimes(5);
    }),
  );

  it.effect("reads an Azure pull request page larger than the VCS default output limit", () =>
    Effect.gen(function* () {
      const rows = pullRequestRows(100, 1).map((row) => ({
        ...row,
        description: "x".repeat(10_000),
      }));
      const response = JSON.stringify(rows);
      expect(Buffer.byteLength(response)).toBeGreaterThan(1_000_000);

      mockedExecute.mockImplementationOnce((input) =>
        Effect.succeed(outputWithin(input.maxOutputBytes, response)),
      );
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "web",
        state: "merged",
        involvement: "all",
        viewer: "bilal@acme.dev",
        limit: 99,
      });

      assert.strictEqual(batch.items.length, 99);
      assert.isTrue(batch.truncated);
    }),
  );

  it.effect("steps over what it has already handed over, which is all Azure can be told", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequests(3, 1))));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "web",
        state: "open",
        involvement: "all",
        viewer: "bilal@acme.dev",
        limit: 10,
        cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: 20 },
      });

      const args = argsOfCall(0);
      expect(args).toContain("--skip");
      assert.strictEqual(args[args.indexOf("--skip") + 1], "20");
      expect(args).not.toContain("2026-07-02T00:00:00Z");
    }),
  );

  it.effect("asks Azure for the author's pull requests by creator", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequests(1, 1))));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "web",
        state: "open",
        involvement: "reviewing",
        viewer: "bilal@acme.dev",
        limit: 10,
        author: "ana@acme.dev",
      });

      const args = argsOfCall(0);
      assert.strictEqual(args[args.indexOf("--creator") + 1], "ana@acme.dev");
      assert.strictEqual(args[args.indexOf("--reviewer") + 1], "bilal@acme.dev");
    }),
  );

  it.effect("advances by malformed raw rows and keeps reading until the page is full", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              JSON.stringify([
                { pullRequestId: "malformed" },
                pullRequestRows(1, 1)[0],
                { pullRequestId: "also malformed" },
              ]),
            ),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output(pullRequests(2, 2))));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "web",
        state: "open",
        involvement: "all",
        viewer: "bilal@acme.dev",
        limit: 2,
      });

      expect(batch.items.map((item) => item.number)).toEqual([1, 2]);
      assert.isTrue(batch.truncated);
      assert.strictEqual(batch.cursorAdvance, 4);
      const secondArgs = argsOfCall(1);
      assert.strictEqual(secondArgs[secondArgs.indexOf("--skip") + 1], "3");
      assert.strictEqual(secondArgs[secondArgs.indexOf("--top") + 1], "2");
    }),
  );

  it.effect("reads the signed-in account, which az reports as a bare value", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(JSON.stringify({ name: "bilal@acme.dev", type: "user" }))),
      );
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const viewer = yield* cli.getViewer({ cwd: "/w" });

      assert.strictEqual(viewer, "bilal@acme.dev");
      expect(argsOfCall(0)).toEqual([
        "account",
        "show",
        "--query",
        "user",
        "--only-show-errors",
        "--output",
        "json",
      ]);
    }),
  );

  it.effect("names a token sign-in by the viewer's own pull request", () =>
    Effect.gen(function* () {
      const notLoggedIn = new AzureDevOpsCli.AzureDevOpsCliAuthenticationError({
        operation: "execute",
        command: "az",
        cwd: "/w",
        argumentCount: 7,
        cause: new Error("Please run 'az login' to setup account."),
      });
      mockedExecute
        .mockReturnValueOnce(Effect.fail(notLoggedIn))
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              JSON.stringify([{ ...pullRequestRow, createdBy: { uniqueName: "bilal@acme.dev" } }]),
            ),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output("")))
        .mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      assert.strictEqual(yield* cli.getViewer({ cwd: "/w" }), "bilal@acme.dev");
      expect(argsOfCall(1)).toEqual(expect.arrayContaining(["--creator", "me", "--top", "1"]));
      const error = yield* Effect.flip(cli.getViewer({ cwd: "/w" }));
      assert.strictEqual(error._tag, "AzureDevOpsViewerUnavailableError");
    }),
  );

  it.effect("fails when no sign-in can read pull requests", () =>
    Effect.gen(function* () {
      const signedOut = new AzureDevOpsCli.AzureDevOpsCliAuthenticationError({
        operation: "execute",
        command: "az",
        cwd: "/w",
        argumentCount: 7,
        cause: new Error("signed out"),
      });
      mockedExecute.mockReturnValue(Effect.fail(signedOut));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const error = yield* Effect.flip(cli.getViewer({ cwd: "/w" }));

      assert.strictEqual(error._tag, "AzureDevOpsCliAuthenticationError");
    }),
  );

  const policyRow = (name: string, status: string) => ({
    status,
    configuration: {
      url: "https://dev.azure.com/acme/platform/_apis/policy/configurations/54",
      isBlocking: true,
      type: { id: "0609b952-1397-4640-95ec-e00a01b2c241" },
      settings: { displayName: name },
    },
  });

  it.effect("follows every page of policies and puts failures first", () =>
    Effect.gen(function* () {
      const fullPage = Array.from({ length: 100 }, () => policyRow("Lint", "approved"));
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(JSON.stringify(fullPage))))
        .mockReturnValueOnce(
          Effect.succeed(output(JSON.stringify([policyRow("Tests", "rejected")]))),
        );
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;
      const checks = yield* cli.listPolicyChecks({ cwd: "/w", number: 42, isDraft: false });
      assert.deepStrictEqual(argsOfCall(1).slice(0, 12), [
        "repos",
        "pr",
        "policy",
        "list",
        "--detect",
        "true",
        "--id",
        "42",
        "--top",
        "100",
        "--skip",
        "100",
      ]);
      assert.strictEqual(checks.length, 101);
      assert.strictEqual(checks[0]?.name, "Tests");
    }),
  );

  it.effect.each([
    { name: "cut off", result: { ...output("[]"), stdoutTruncated: true } },
    { name: "unreadable", result: output(JSON.stringify([{ status: 7 }])) },
  ])("fails rather than report a $name policy page as complete", ({ result }) =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(result));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;
      const error = yield* Effect.flip(
        cli.listPolicyChecks({ cwd: "/w", number: 42, isDraft: false }),
      );
      assert.strictEqual(error._tag, "AzureDevOpsPullRequestReadError");
    }),
  );

  it.effect("sends a description that starts with a dash as one value, not as a flag", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      yield* cli.updatePullRequest({
        cwd: "/w",
        number: 42,
        body: "- rewrote the page\n- kept the rest",
      });

      expect(argsOfCall(0)).toContain("--description=- rewrote the page\n- kept the rest");
    }),
  );

  it.effect("names the head's blob as what a cleared file was cleared at", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              JSON.stringify({
                pullRequestId: 42,
                title: "Add the page",
                status: "active",
                sourceRefName: "refs/heads/feat/page",
                targetRefName: "refs/heads/main",
                creationDate: "2026-07-01T00:00:00Z",
                url: "https://dev.azure.com/acme/_apis/git/repositories/web/pullRequests/42",
                repository: { name: "web", project: { name: "platform" } },
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              JSON.stringify({
                value: [
                  {
                    id: 1,
                    sourceRefCommit: { commitId: "a".repeat(40) },
                    commonRefCommit: { commitId: "b".repeat(40) },
                  },
                  {
                    id: 2,
                    sourceRefCommit: { commitId: "c".repeat(40) },
                    commonRefCommit: { commitId: "b".repeat(40) },
                  },
                ],
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              JSON.stringify({
                changeEntries: [
                  { changeType: "edit", item: { path: "/README.md", objectId: "8f80" } },
                  { changeType: "add", item: { path: "/DEMO.md", objectId: "0ca4" } },
                ],
              }),
            ),
          ),
        );
      const provider = yield* AzureDevOpsPullRequestProvider.make;

      assert.strictEqual(provider.capabilities.viewedFiles, "environment");
      assert.isDefined(provider.getFileRevisions);
      const answer = yield* provider.getFileRevisions({
        cwd: "/w",
        repository: "web",
        host: "dev.azure.com",
        number: 42,
        paths: ["README.md"],
      });

      expect(argsOfCall(2)).toContain("iterationId=2");
      expect([...answer.revisions]).toEqual([["README.md", "8f80"]]);
    }),
  );

  it.effect(
    "answers for a marked file the pull request no longer changes as the empty version",
    () =>
      Effect.gen(function* () {
        mockedExecute
          .mockReturnValueOnce(
            Effect.succeed(
              output(
                json({
                  pullRequestId: 42,
                  title: "Add the page",
                  status: "active",
                  sourceRefName: "refs/heads/feat/page",
                  targetRefName: "refs/heads/main",
                  creationDate: "2026-07-01T00:00:00Z",
                  url: "https://dev.azure.com/acme/_apis/git/repositories/web/pullRequests/42",
                  repository: { name: "web", project: { name: "platform" } },
                }),
              ),
            ),
          )
          .mockReturnValueOnce(
            Effect.succeed(
              output(
                json({
                  value: [
                    {
                      id: 1,
                      sourceRefCommit: { commitId: "a".repeat(40) },
                      commonRefCommit: { commitId: "b".repeat(40) },
                    },
                  ],
                }),
              ),
            ),
          )
          .mockReturnValueOnce(Effect.succeed(output('{"changeEntries":[]}')));
        const provider = yield* AzureDevOpsPullRequestProvider.make;
        assert.isDefined(provider.getFileRevisions);

        const answer = yield* provider.getFileRevisions({
          cwd: "/w",
          repository: "web",
          host: "dev.azure.com",
          number: 42,
          paths: ["GONE.md"],
        });

        expect([...answer.revisions]).toEqual([["GONE.md", ""]]);
      }),
  );

  it.effect("says nothing about the files past the end of a change it gave up following", () =>
    Effect.gen(function* () {
      const entries = (from: number, count: number) =>
        Array.from({ length: count }, (_, index) => ({
          changeType: "edit",
          item: { path: `/src/f${from + index}.ts`, objectId: `blob-${from + index}` },
        }));
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                pullRequestId: 42,
                title: "Add the page",
                status: "active",
                sourceRefName: "refs/heads/feat/page",
                targetRefName: "refs/heads/main",
                creationDate: "2026-07-01T00:00:00Z",
                url: "https://dev.azure.com/acme/_apis/git/repositories/web/pullRequests/42",
                repository: { name: "web", project: { name: "platform" } },
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                value: [
                  {
                    id: 1,
                    sourceRefCommit: { commitId: "a".repeat(40) },
                    commonRefCommit: { commitId: "b".repeat(40) },
                  },
                ],
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(output(json({ changeEntries: entries(0, 5_000), nextSkip: 5_000 }))),
        )
        .mockReturnValueOnce(
          Effect.succeed(output(json({ changeEntries: entries(5_000, 5_000), nextSkip: 10_000 }))),
        );
      const provider = yield* AzureDevOpsPullRequestProvider.make;
      assert.isDefined(provider.getFileRevisions);

      const answer = yield* provider.getFileRevisions({
        cwd: "/w",
        repository: "web",
        host: "dev.azure.com",
        number: 42,
        paths: ["src/f1.ts", "src/f5001.ts", "src/past-the-cut.ts"],
      });

      expect(argsOfCall(3)).toContain("$skip=5000");
      expect([...answer.revisions]).toEqual([
        ["src/f1.ts", "blob-1"],
        ["src/f5001.ts", "blob-5001"],
      ]);
    }),
  );

  it.effect("stops following pages by what Azure counts, not by what survives decoding", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                pullRequestId: 42,
                title: "Add the page",
                status: "active",
                sourceRefName: "refs/heads/feat/page",
                targetRefName: "refs/heads/main",
                creationDate: "2026-07-01T00:00:00Z",
                url: "https://dev.azure.com/acme/_apis/git/repositories/web/pullRequests/42",
                repository: { name: "web", project: { name: "platform" } },
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                value: [
                  {
                    id: 1,
                    sourceRefCommit: { commitId: "a".repeat(40) },
                    commonRefCommit: { commitId: "b".repeat(40) },
                  },
                ],
              }),
            ),
          ),
        )
        .mockImplementation((command) => {
          const skip = command.args.find((arg) => arg.startsWith("$skip="));
          const from = Number(skip?.slice("$skip=".length) ?? 0);
          return Effect.succeed(
            output(
              json({
                changeEntries: [{ changeType: "add", item: { path: "/src", isFolder: true } }],
                nextSkip: from + 2_000,
              }),
            ),
          );
        });
      const provider = yield* AzureDevOpsPullRequestProvider.make;
      assert.isDefined(provider.getFileRevisions);

      const answer = yield* provider.getFileRevisions({
        cwd: "/w",
        repository: "web",
        host: "dev.azure.com",
        number: 42,
        paths: ["src/page.ts"],
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 7);
      assert.strictEqual(answer.revisions.size, 0);
    }),
  );

  it.effect("leaves one file the host would not hand over listed without its hunks", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(json(pullRequestRow))))
        .mockReturnValueOnce(Effect.succeed(output(json(oneIteration))))
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                changeEntries: [
                  { changeType: "add", item: { path: "/huge.bin", objectId: "8f80" } },
                  { changeType: "add", item: { path: "/DEMO.md", objectId: "0ca4" } },
                ],
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.fail(
            new AzureDevOpsCli.AzureDevOpsCommandFailedError({
              operation: "execute",
              command: "az",
              cwd: "/w",
              argumentCount: 1,
              cause: "the blob is past what the route will carry",
            }),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output(json({ content: "hello\n" }))));
      const provider = yield* AzureDevOpsPullRequestProvider.make;

      const slice = yield* provider.getDiff({
        cwd: "/w",
        repository: "web",
        host: "dev.azure.com",
        number: 42,
      });

      assert.isTrue(slice.truncated);
      expect(slice.patch).toContain("diff --git a/huge.bin b/huge.bin");
      expect(slice.patch).toContain("+hello");
    }),
  );

  it.effect("fails the whole read when it is the connection that would not answer", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(json(pullRequestRow))))
        .mockReturnValueOnce(Effect.succeed(output(json(oneIteration))))
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                changeEntries: [
                  { changeType: "add", item: { path: "/DEMO.md", objectId: "0ca4" } },
                ],
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.fail(
            new AzureDevOpsCli.AzureDevOpsCliRateLimitError({
              operation: "execute",
              command: "az",
              cwd: "/w",
              argumentCount: 1,
              cause: "429",
            }),
          ),
        );
      const provider = yield* AzureDevOpsPullRequestProvider.make;

      const error = yield* Effect.flip(
        provider.getDiff({ cwd: "/w", repository: "web", host: "dev.azure.com", number: 42 }),
      );

      assert.strictEqual(error.reason, "rate-limited");
    }),
  );

  it.effect("takes Azure's own word on a file it will not spell out", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                pullRequestId: 42,
                title: "Add the page",
                status: "active",
                sourceRefName: "refs/heads/feat/page",
                targetRefName: "refs/heads/main",
                creationDate: "2026-07-01T00:00:00Z",
                url: "https://dev.azure.com/acme/_apis/git/repositories/web/pullRequests/42",
                repository: { name: "web", project: { name: "platform" } },
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                value: [
                  {
                    id: 1,
                    sourceRefCommit: { commitId: "a".repeat(40) },
                    commonRefCommit: { commitId: "b".repeat(40) },
                  },
                ],
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                changeEntries: [
                  { changeType: "add", item: { path: "/logo.png", objectId: "8f80" } },
                ],
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(json({ content: "iVBORw0KGgo=", contentMetadata: { isBinary: true } })),
          ),
        );
      const provider = yield* AzureDevOpsPullRequestProvider.make;

      const slice = yield* provider.getDiff({
        cwd: "/w",
        repository: "web",
        host: "dev.azure.com",
        number: 42,
      });

      expect(argsOfCall(3)).toContain("includeContentMetadata=true");
      expect(slice.patch).toContain("Binary files a/logo.png and b/logo.png differ");
      assert.isTrue(slice.truncated);
    }),
  );

  it.effect("stops following pages when one of them does not move the cursor on", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                pullRequestId: 42,
                title: "Add the page",
                status: "active",
                sourceRefName: "refs/heads/feat/page",
                targetRefName: "refs/heads/main",
                creationDate: "2026-07-01T00:00:00Z",
                url: "https://dev.azure.com/acme/_apis/git/repositories/web/pullRequests/42",
                repository: { name: "web", project: { name: "platform" } },
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                value: [
                  {
                    id: 1,
                    sourceRefCommit: { commitId: "a".repeat(40) },
                    commonRefCommit: { commitId: "b".repeat(40) },
                  },
                ],
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                changeEntries: [{ changeType: "edit", item: { path: "/a.ts", objectId: "8f80" } }],
                nextSkip: 2_000,
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                changeEntries: [{ changeType: "edit", item: { path: "/b.ts", objectId: "0ca4" } }],
                nextSkip: 2_000,
              }),
            ),
          ),
        );
      const provider = yield* AzureDevOpsPullRequestProvider.make;
      assert.isDefined(provider.getFileRevisions);

      const answer = yield* provider.getFileRevisions({
        cwd: "/w",
        repository: "web",
        host: "dev.azure.com",
        number: 42,
        paths: ["a.ts", "b.ts", "unlisted.ts"],
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 4);
      expect([...answer.revisions]).toEqual([
        ["a.ts", "8f80"],
        ["b.ts", "0ca4"],
      ]);
    }),
  );

  it.effect("reads a full page of change entries, which is past the default output limit", () =>
    Effect.gen(function* () {
      const response = json({ changeEntries: changeEntries(2_000) });
      expect(Buffer.byteLength(response)).toBeGreaterThan(VCS_DEFAULT_MAX_OUTPUT_BYTES);
      mockedExecute.mockImplementationOnce((input) =>
        Effect.succeed(outputWithin(input.maxOutputBytes, response)),
      );
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const page = yield* cli.listIterationChanges({
        cwd: "/w",
        location: { project: "platform", repository: "web" },
        number: 42,
        iterationId: 1,
      });

      assert.strictEqual(page.changes.length, 2_000);
      assert.isFalse(page.truncated);
    }),
  );

  it.effect("reads a file whose JSON envelope is past the default output limit", () =>
    Effect.gen(function* () {
      const file = "const value = 1;\n".repeat(57_000);
      const response = json({ content: file });
      expect(Buffer.byteLength(file)).toBeLessThan(VCS_DEFAULT_MAX_OUTPUT_BYTES);
      expect(Buffer.byteLength(response)).toBeGreaterThan(VCS_DEFAULT_MAX_OUTPUT_BYTES);
      mockedExecute.mockImplementationOnce((input) =>
        Effect.succeed(outputWithin(input.maxOutputBytes, response)),
      );
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const item = yield* cli.readItemContent({
        cwd: "/w",
        location: { project: "platform", repository: "web" },
        path: "src/generated/schema.ts",
        commit: "a".repeat(40),
      });

      assert.strictEqual(item.contents, file);
      assert.isFalse(item.isBinary);
    }),
  );

  it.effect(
    "reads a batch of files from one blobs zip, keeping only what Azure's read would say",
    () =>
      Effect.gen(function* () {
        const id = (digit: string) => digit.repeat(40);
        const utf8 = (text: string) => new TextEncoder().encode(text);
        let sent = "";
        mockedExecute.mockImplementationOnce((input) =>
          Effect.sync(() => {
            const flag = (name: string) => input.args[input.args.indexOf(name) + 1] ?? "";
            sent = NodeFS.readFileSync(flag("--in-file"), "utf8");
            NodeFS.writeFileSync(
              flag("--out-file"),
              streamedZip([
                { name: id("a"), data: utf8("plain text\n") },
                { name: id("b"), data: utf8("\uFEFFcafé ✓\n") },
                { name: id("c"), data: Uint8Array.of(0x89, 0x50, 0x00, 0x01) },
                // Windows-1252 "café" and UTF-16: Azure decodes these itself.
                { name: id("d"), data: Uint8Array.of(0x63, 0x61, 0x66, 0xe9) },
                { name: id("e"), data: Uint8Array.of(0xff, 0xfe, 0x68, 0x00) },
                { name: id("f"), data: utf8("stored\n"), stored: true },
                { name: id("9"), data: utf8("never asked for\n") },
              ]),
            );
            return output("");
          }),
        );
        const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

        const blobs = yield* cli.readBlobs({
          cwd: "/w",
          location: { project: "platform", repository: "web" },
          objectIds: [id("A"), id("b"), id("C"), id("d"), id("e"), id("f"), id("a"), "../etc"],
        });

        expect(JSON.parse(sent)).toEqual([id("A"), id("b"), id("C"), id("d"), id("e"), id("f")]);
        expect(argsOfCall(0)).toEqual(
          expect.arrayContaining(["blobs", "POST", "application/zip", "project=platform"]),
        );
        expect(Object.fromEntries(blobs)).toEqual({
          [id("a")]: { contents: "plain text\n", isBinary: false },
          [id("b")]: { contents: "café ✓\n", isBinary: false },
          [id("c")]: { contents: "", isBinary: true },
          [id("f")]: { contents: "stored\n", isBinary: false },
        });
      }),
  );

  it.effect("leaves blobs past the batch's total size to per-file reads", () =>
    Effect.gen(function* () {
      const ids = ["1", "2", "3", "4", "5", "6"].map((digit) => digit.repeat(40));
      // Compresses to a few KiB each, so only the inflated total can bound memory.
      const blob = new Uint8Array(3 * 1024 * 1024).fill(0x61);
      mockedExecute.mockImplementationOnce((input) =>
        Effect.sync(() => {
          NodeFS.writeFileSync(
            input.args[input.args.indexOf("--out-file") + 1] ?? "",
            streamedZip(ids.map((name) => ({ name, data: blob }))),
          );
          return output("");
        }),
      );
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const blobs = yield* cli.readBlobs({
        cwd: "/w",
        location: { project: "platform", repository: "web" },
        objectIds: ids,
      });

      expect([...blobs.keys()]).toEqual(ids.slice(0, 5));
    }),
  );

  it.effect("escapes characters in a file path that would cut the query string", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(json({ content: "x" }))));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      yield* cli.readItemContent({
        cwd: "/w",
        location: { project: "platform", repository: "web" },
        path: "docs/C#/a&b.md",
        commit: "a".repeat(40),
      });

      expect(mockedExecute.mock.calls.at(-1)?.[0].args).toContain("path=%2Fdocs%2FC%23%2Fa%26b.md");
    }),
  );

  it.effect("reports a pull request it cannot place as its own outcome", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              pullRequestId: 42,
              title: "Add the page",
              sourceRefName: "refs/heads/feat/page",
              targetRefName: "refs/heads/main",
              creationDate: "2026-07-01T00:00:00Z",
            }),
          ),
        ),
      );
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const error = yield* Effect.flip(cli.getPullRequest({ cwd: "/w", number: 42 }));

      assert.strictEqual(error._tag, "AzureDevOpsPullRequestIncompleteError");
    }),
  );

  it.effect("refuses a reviewer az would read as a flag, before running anything", () =>
    Effect.gen(function* () {
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const error = yield* Effect.flip(
        cli.setPullRequestReviewers({
          cwd: "/w",
          number: 42,
          reviewers: ["--query"],
          requested: true,
        }),
      );

      assert.strictEqual(error._tag, "AzureDevOpsReviewerNameError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );
});
