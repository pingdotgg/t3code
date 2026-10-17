import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  WS_METHODS,
  type AuthSessionState,
  type IssueEvent,
  type IssueHistoryPage,
  type IssueCommentsPage,
  type IssueComment,
  type IssueHistoryInput,
} from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { createElement, useEffect } from "react";
import { expect, it, vi } from "vite-plus/test";
import type {
  EnvironmentSupervisor as Supervisor,
  EnvironmentRegistry as Registry,
} from "@t3tools/client-runtime/connection";

const rpc = vi.hoisted(() => ({
  read: vi.fn<
    (
      tag: string,
      input: { cursor?: string; order?: string; connectionId?: string },
    ) => IssueHistoryPage | IssueCommentsPage
  >(),
  write: vi.fn<() => void>(),
}));
vi.mock("../../../../packages/client-runtime/src/rpc/client.ts", async (importOriginal) => {
  const Effect = await import("effect/Effect");
  return {
    ...(await importOriginal<typeof import("@t3tools/client-runtime/rpc")>()),
    request: (tag: string, input: { cursor?: string }) => Effect.sync(() => rpc.read(tag, input)),
    requestGuarded: () => Effect.sync(() => rpc.write()),
  };
});

vi.mock("../connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const Option = await import("effect/Option");
  const Stream = await import("effect/Stream");
  const SubscriptionRef = await import("effect/SubscriptionRef");
  const { EnvironmentRegistry, EnvironmentSupervisor } =
    await import("@t3tools/client-runtime/connection");
  return {
    connectionAtomRuntime: Atom.runtime(
      Layer.effect(
        EnvironmentRegistry.EnvironmentRegistry,
        Effect.gen(function* () {
          const supervisor = {
            state: yield* SubscriptionRef.make({ phase: "connected" }),
            session: yield* SubscriptionRef.make(Option.some({})),
          } as unknown as Supervisor.EnvironmentSupervisor["Service"];
          return EnvironmentRegistry.EnvironmentRegistry.of({
            run: (_id, effect) =>
              Effect.provideService(
                effect,
                EnvironmentSupervisor.EnvironmentSupervisor,
                supervisor,
              ),
            followStream: (_id, stream) =>
              Stream.provideService(
                stream,
                EnvironmentSupervisor.EnvironmentSupervisor,
                supervisor,
              ),
          } as Registry.EnvironmentRegistry["Service"]);
        }),
      ),
    ),
  };
});
vi.mock("../hooks/useIssueViewRefresh", () => ({ useIssueViewRefresh: () => {} }));
vi.mock("../../../../packages/client-runtime/src/state/session.ts", async (importOriginal) => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const { AuthOrchestrationReadScope, AuthSourceControlWriteScope } =
    await import("@t3tools/contracts");
  const session = Atom.make(
    AsyncResult.success<AuthSessionState>({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthOrchestrationReadScope, AuthSourceControlWriteScope],
      permissions: [AuthOrchestrationReadScope, AuthSourceControlWriteScope],
    }),
  );
  return {
    ...(await importOriginal<typeof import("@t3tools/client-runtime/state/session")>()),
    createEnvironmentSessionAtoms: () => ({ sessionStateAtom: () => session }),
  };
});

import { appAtomRegistry } from "../rpc/atomRegistry";
import { issueEnvironment, useIssueComments, useIssueHistory, type IssuePagedView } from "./issues";

it.each(["github", "gitlab"])(
  "loads a fresh shifted %s history tail after a successful write",
  async (tracker) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const environmentId = EnvironmentId.make(`history-${tracker}`);
    const reference = {
      projectId: ProjectId.make("project"),
      tracker: IssueTrackerKind.make(tracker),
      host: `${tracker}.com`,
      scope: "org/repo",
      key: "1",
    };
    let written = false;
    const reads: string[] = [];
    const event = (id: string): IssueEvent => ({
      id,
      kind: id === "closed" ? "closed" : "changed",
      actor: null,
      createdAt: "2026-10-15T00:00:00Z",
      detail: null,
    });
    rpc.read.mockReset().mockImplementation((tag, input) => {
      expect(tag).toBe(WS_METHODS.issuesHistory);
      reads.push(input.cursor ?? "first");
      return {
        items: [
          event(
            input.cursor === undefined
              ? written
                ? "closed"
                : "latest"
              : written
                ? "latest"
                : "old",
          ),
        ],
        nextCursor: input.cursor === undefined ? "tail" : null,
      };
    });
    rpc.write.mockReset().mockImplementation(() => {
      written = true;
    });
    let view!: IssuePagedView<IssueEvent>;
    function Probe() {
      const current = useIssueHistory(environmentId, reference);
      useEffect(() => {
        view = current;
      }, [current]);
      return null;
    }
    let root: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        root = create(
          createElement(RegistryContext.Provider, { value: appAtomRegistry }, createElement(Probe)),
        );
      });
      await act(async () => view.loadMore());
      expect(view.items.map((item) => item.id)).toEqual(["latest", "old"]);
      expect(reads).toEqual(["first", "tail"]);
      await act(async () => {
        expect(
          await issueEnvironment.setState.run(appAtomRegistry, {
            environmentId,
            input: { ...reference, state: "closed" },
          }),
        ).toMatchObject({ _tag: "Success" });
      });
      expect(view.items.map((item) => item.id)).toEqual(["closed"]);
      expect(view.hasMore).toBe(true);
      expect(reads).toEqual(["first", "tail", "first"]);
      await act(async () => view.loadMore());
      expect(view.items.map((item) => item.id)).toEqual(["closed", "latest"]);
      expect(reads).toEqual(["first", "tail", "first", "tail"]);
      expect(rpc.write).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root?.unmount());
      vi.unstubAllGlobals();
    }
  },
);

it.each(["history", "comments"] as const)(
  "resets %s pages when direction or selected account changes",
  async (kind) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const environmentId = EnvironmentId.make(`activity-order-${kind}`);
    const reference: IssueHistoryInput = {
      projectId: ProjectId.make("project"),
      tracker: IssueTrackerKind.make("linear"),
      host: "linear.app",
      scope: "acme/ENG",
      key: "ENG-7",
      connectionId: "ExactB",
      order: "desc",
    };
    const reads: Array<{ order?: string; connectionId?: string; cursor?: string }> = [];
    rpc.read.mockReset().mockImplementation((tag, input) => {
      expect(tag).toBe(kind === "history" ? WS_METHODS.issuesHistory : WS_METHODS.issuesComments);
      reads.push(input);
      const id = `${input.connectionId}:${input.order}:${input.cursor ?? "first"}`;
      const nextCursor = input.cursor === undefined ? "tail" : null;
      return kind === "history"
        ? {
            items: [
              { id, kind: "updated", actor: null, createdAt: "2026-10-16T00:00:00Z", detail: null },
            ],
            nextCursor,
          }
        : {
            comments: [
              {
                id,
                author: null,
                body: id,
                createdAt: "2026-10-16T00:00:00Z",
                editedAt: null,
                url: null,
              },
            ],
            nextCursor,
          };
    });
    let view!: IssuePagedView<IssueEvent | IssueComment>;
    function Probe({ input }: { input: IssueHistoryInput }) {
      const history = useIssueHistory(
        kind === "history" ? environmentId : null,
        kind === "history" ? input : null,
      );
      const comments = useIssueComments(
        kind === "comments" ? environmentId : null,
        kind === "comments" ? input : null,
      );
      const current = kind === "history" ? history : comments;
      useEffect(() => {
        view = current;
      }, [current]);
      return null;
    }
    const render = (input: IssueHistoryInput) =>
      createElement(
        RegistryContext.Provider,
        { value: appAtomRegistry },
        createElement(Probe, { input }),
      );
    let root: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        root = create(render(reference));
      });
      await act(async () => view.loadMore());
      expect(view.items.map((item) => item.id)).toEqual(["ExactB:desc:first", "ExactB:desc:tail"]);
      await act(async () => root!.update(render({ ...reference, order: "asc" })));
      expect(view.items.map((item) => item.id)).toEqual(["ExactB:asc:first"]);
      await act(async () =>
        root!.update(render({ ...reference, order: "asc", connectionId: "exactb" })),
      );
      expect(view.items.map((item) => item.id)).toEqual(["exactb:asc:first"]);
      expect(reads.map(({ connectionId, order, cursor }) => [connectionId, order, cursor])).toEqual(
        [
          ["ExactB", "desc", undefined],
          ["ExactB", "desc", "tail"],
          ["ExactB", "asc", undefined],
          ["exactb", "asc", undefined],
        ],
      );
    } finally {
      await act(async () => root?.unmount());
      vi.unstubAllGlobals();
    }
  },
);
