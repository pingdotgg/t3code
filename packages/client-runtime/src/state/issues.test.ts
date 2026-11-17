import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  type IssueListResult,
  type IssueComment,
  type IssueListEntry,
  type IssueListInput,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "@effect/vitest";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createIssueEnvironmentAtoms,
  createMergedIssueCandidatesAtoms,
  issueEntryKey,
  mergeIssueListPage,
  prependIssueComments,
} from "./issues.ts";

function entry(overrides: Partial<IssueListEntry> & { key: string }): IssueListEntry {
  return {
    tracker: "github" as IssueTrackerKind,
    host: "github.com",
    scope: "acme/app",
    displayKey: `#${overrides.key}`,
    title: `Issue ${overrides.key}`,
    url: `https://github.com/acme/app/issues/${overrides.key}`,
    author: null,
    state: { category: "open", name: "open" },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 0,
    projectId: "project-1" as ProjectId,
    projectTitle: "App",
    ...overrides,
  };
}

describe("mergeIssueListPage", () => {
  it("keeps rows from scopes the page did not continue and orders by update", () => {
    const held = [
      entry({ key: "1", updatedAt: "2026-10-03T00:00:00.000Z" }),
      entry({ key: "9", scope: "acme/other", updatedAt: "2026-10-02T00:00:00.000Z" }),
    ];
    const page = [entry({ key: "2", updatedAt: "2026-10-04T00:00:00.000Z" })];
    expect(mergeIssueListPage(held, page).map((row) => row.key)).toEqual(["2", "1", "9"]);
  });

  it("replaces a repeated row with the page's newer words", () => {
    const held = [entry({ key: "1", title: "Old title" })];
    const page = [
      entry({ key: "1", title: "New title", state: { category: "closed", name: "closed" } }),
    ];
    const merged = mergeIssueListPage(held, page);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.title).toBe("New title");
    expect(merged[0]?.state.category).toBe("closed");
  });

  it("keys rows case-insensitively by host and scope, exactly by key", () => {
    expect(issueEntryKey(entry({ key: "1", host: "GitHub.com", scope: "Acme/App" }))).toBe(
      issueEntryKey(entry({ key: "1" })),
    );
    expect(issueEntryKey(entry({ key: "ENG-1" }))).not.toBe(issueEntryKey(entry({ key: "eng-1" })));
  });
});

describe("prependIssueComments", () => {
  const comment = (id: string): IssueComment => ({
    id,
    author: null,
    body: id,
    createdAt: "2026-10-01T00:00:00.000Z",
    url: null,
  });

  it("puts older comments first and drops ones already shown", () => {
    const current = [comment("c3"), comment("c4")];
    const older = [comment("c1"), comment("c2"), comment("c3")];
    expect(prependIssueComments(current, older).map((c) => c.id)).toEqual(["c1", "c2", "c3", "c4"]);
  });
});

describe("createMergedIssueCandidatesAtoms", () => {
  it("retries only failed scopes that are not already reloading", () => {
    const registry = AtomRegistry.make();
    const target = (scope: string) => ({
      environmentId: EnvironmentId.make("issues"),
      input: {
        projectId: ProjectId.make(scope),
        tracker: IssueTrackerKind.make("github"),
        host: "github.com",
        scope,
      },
    });
    const targets = [target("acme/healthy"), target("acme/flaky")];
    const requests: string[] = [];
    const candidates = Atom.family((scope: string) =>
      Atom.make(
        Effect.suspend(() => {
          requests.push(scope);
          if (scope === "acme/healthy") {
            return Effect.succeed({ labels: [], assignees: [], truncated: false });
          }
          return requests.length === 2 ? Effect.fail("Repository unavailable") : Effect.never;
        }),
      ),
    );
    const merged = createMergedIssueCandidatesAtoms(
      (t) => candidates(t.input.scope),
      () => "Repository unavailable",
    );
    const view = merged.atom(targets);
    const unmount = registry.mount(view);
    try {
      expect(registry.get(view)).toMatchObject({
        error: "Repository unavailable",
        isPending: false,
      });

      merged.retry(registry, targets);
      expect(registry.get(view).isPending).toBe(true);
      merged.retry(registry, targets);

      expect(requests).toEqual(["acme/healthy", "acme/flaky", "acme/flaky"]);
    } finally {
      unmount();
      registry.dispose();
    }
  });
});

describe("issue listings", () => {
  it.effect("reuses a fresh listing for the same labels selected in a different order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const environmentId = EnvironmentId.make("env");
        const target = new PrimaryConnectionTarget({
          environmentId,
          label: "Test environment",
          httpBaseUrl: "https://issues.example.test",
          wsBaseUrl: "wss://issues.example.test",
        });
        const answer: IssueListResult = {
          viewers: { "github.com": "octocat" },
          entries: [
            entry({
              key: "1",
              labels: [
                { name: "bug", color: null },
                { name: "p1", color: null },
              ],
            }),
          ],
          trackers: [],
          nextCursors: {},
          errors: [],
        };
        let reads = 0;
        const client = {
          [WS_METHODS.issuesList]: () =>
            Effect.sync(() => {
              reads += 1;
              return answer;
            }),
        };
        const supervisor = EnvironmentSupervisor.of({
          target,
          state: yield* SubscriptionRef.make<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            phase: "connected",
            network: "online",
            desired: true,
            generation: 1,
          }),
          session: yield* SubscriptionRef.make(Option.some({ client } as unknown as RpcSession)),
          prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
        const environment = EnvironmentRegistry.of({
          run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
          followStream: (_id, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor, supervisor),
        } as Pick<
          EnvironmentRegistry["Service"],
          "run" | "followStream"
        > as EnvironmentRegistry["Service"]);
        const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry, environment));
        const { list } = createIssueEnvironmentAtoms(runtime);
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        for (const labels of [
          ["bug", "p1"],
          ["p1", "bug"],
        ]) {
          const atom = list({ environmentId, input: { state: "open", labels } });
          yield* Effect.acquireRelease(
            Effect.sync(() => registry.mount(atom)),
            (closePicker) => Effect.sync(closePicker),
          ).pipe(
            Effect.andThen(AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true })),
            Effect.tap((value) =>
              Effect.sync(() => expect(value.entries.map((row) => row.key)).toEqual(["1"])),
            ),
            Effect.scoped,
          );
        }
        expect(reads, "Issue searches for the same selected labels").toBe(1);
      }),
    ),
  );

  it.effect("loads the next page using the search that produced its cursor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const environmentId = EnvironmentId.make("env");
        const target = new PrimaryConnectionTarget({
          environmentId,
          label: "Test environment",
          httpBaseUrl: "https://issues.example.test",
          wsBaseUrl: "wss://issues.example.test",
        });
        const cursors = { "github.com acme/app": "opaque-cursor" };
        const client = {
          [WS_METHODS.issuesList]: (input: IssueListInput) =>
            Effect.succeed({
              entries:
                input.cursors?.["github.com acme/app"] === cursors["github.com acme/app"] &&
                input.labels?.join(",") === "bug,p1"
                  ? [entry({ key: "2" })]
                  : [],
              viewers: {},
              trackers: [],
              nextCursors: {},
              errors: [],
            } satisfies IssueListResult),
        };
        const supervisor = EnvironmentSupervisor.of({
          target,
          state: yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE),
          session: yield* SubscriptionRef.make(Option.some({ client } as unknown as RpcSession)),
          prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
        const environment = EnvironmentRegistry.of({
          run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
        } as Pick<EnvironmentRegistry["Service"], "run"> as EnvironmentRegistry["Service"]);
        const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry, environment));
        const { listPage } = createIssueEnvironmentAtoms(runtime);
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const page = yield* Effect.promise(() =>
          listPage.run(registry, {
            environmentId,
            input: { state: "open", labels: ["p1", "bug"], cursors },
          }),
        );
        expect(page).toMatchObject({ _tag: "Success", value: { entries: [{ key: "2" }] } });
      }),
    ),
  );
});
