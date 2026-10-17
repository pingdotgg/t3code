import {
  AuthSourceControlWriteScope,
  type AuthSessionState,
  type EnvironmentId,
  type IssueTrackerKind,
  type ProjectId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcClient from "../rpc/client.ts";
import * as Session from "./session.ts";
import { createIssueEnvironmentAtoms } from "./issues.ts";
import { executeAtomQuery } from "./runtime.ts";

it.effect.each(
  (["create", "setParent", "setDependency"] as const).flatMap((operation) =>
    [undefined, "ExactB"].map((connectionId) => ({ operation, connectionId })),
  ),
)(
  "refreshes mounted relation pages after $operation for $connectionId only",
  ({ operation, connectionId }) =>
    Effect.gen(function* () {
      const supervisor = {
        state: yield* SubscriptionRef.make({ phase: "connected" }),
        session: yield* SubscriptionRef.make(Option.some({})),
      } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
      yield* Effect.promise(async () => {
        const environment = EnvironmentRegistry.EnvironmentRegistry.of({
          run: (_id, effect) =>
            Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          followStream: (_id, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
        const runtime = Atom.runtime(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environment),
        );
        const session: AuthSessionState = {
          authenticated: true,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: [],
            sessionMethods: [],
            sessionCookieName: "test",
          },
          scopes: [AuthSourceControlWriteScope],
          permissions: [AuthSourceControlWriteScope],
        };
        const sessionAtom = Atom.make(AsyncResult.success(session));
        const sessions = vi
          .spyOn(Session, "createEnvironmentSessionAtoms")
          .mockReturnValue({ sessionStateAtom: () => sessionAtom } as unknown as ReturnType<
            typeof Session.createEnvironmentSessionAtoms
          >);
        const reads: string[] = [];
        let written = false;
        const refreshed = Promise.withResolvers<void>();
        const read = vi.spyOn(RpcClient, "request");
        read.mockImplementation(((_tag: string, input: { host: string; key: string }) =>
          Effect.sync(() => {
            reads.push(`${input.host}:${input.key}`);
            if (written && reads.length === 6) refreshed.resolve();
            return { parent: null, children: { items: [], nextCursor: null } };
          })) as unknown as Parameters<typeof read.mockImplementation>[0]);
        const write = vi.spyOn(RpcClient, "requestGuarded");
        write.mockImplementation((() =>
          Effect.sync(() => {
            written = true;
            return { key: "child", url: "https://github.com/org/repo/issues/2" };
          })) as unknown as Parameters<typeof write.mockImplementation>[0]);
        const atoms = createIssueEnvironmentAtoms(runtime);
        const registry = AtomRegistry.make();
        const environmentId = "environment" as EnvironmentId;
        const defaultReference = {
          projectId: "project" as ProjectId,
          tracker: "github" as IssueTrackerKind,
          host: "github.com",
          scope: "org/repo",
          key: "1",
        };
        const reference = {
          ...defaultReference,
          ...(connectionId === undefined ? {} : { connectionId }),
        };
        const targets = [
          reference,
          { ...reference, key: "2" },
          { ...reference, host: "other.example", key: "3" },
          {
            ...defaultReference,
            key: "3",
            ...(connectionId === undefined ? { connectionId: "ExactB" } : {}),
          },
        ];
        const query = (
          input: typeof reference,
        ): Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>> =>
          operation === "setDependency"
            ? atoms.dependencies({ environmentId, input: { ...input, direction: "blocks" } })
            : atoms.hierarchy({ environmentId, input });
        const releases = targets.map((input) => registry.mount(query(input)));
        try {
          await Promise.all(targets.map((input) => executeAtomQuery(registry, query(input))));
          const result =
            operation === "create"
              ? await atoms.create.run(registry, {
                  environmentId,
                  input: {
                    ...reference,
                    parentKey: "1",
                    title: "Child",
                    body: "",
                    labels: [],
                    assignees: [],
                  },
                })
              : operation === "setDependency"
                ? await atoms.setDependency.run(registry, {
                    environmentId,
                    input: {
                      ...reference,
                      direction: "blocked-by",
                      targetScope: "org/repo",
                      targetKey: "2",
                      linked: true,
                    },
                  })
                : await atoms.setParent.run(registry, {
                    environmentId,
                    input: { ...reference, parentKey: "2" },
                  });
          expect(result._tag).toBe("Success");
          await refreshed.promise;
          expect(reads.toSorted()).toEqual([
            "github.com:1",
            "github.com:1",
            "github.com:2",
            "github.com:2",
            "github.com:3",
            "other.example:3",
          ]);
          expect(write).toHaveBeenCalledExactlyOnceWith(
            operation === "create"
              ? WS_METHODS.issuesCreate
              : operation === "setParent"
                ? WS_METHODS.issuesSetParent
                : WS_METHODS.issuesSetDependency,
            expect.objectContaining({
              ...(connectionId === undefined ? {} : { connectionId }),
              ...(operation === "setDependency"
                ? { direction: "blocked-by", targetKey: "2", linked: true }
                : { parentKey: operation === "create" ? "1" : "2" }),
            }),
          );
        } finally {
          releases.forEach((release) => release());
          registry.dispose();
          read.mockRestore();
          write.mockRestore();
          sessions.mockRestore();
        }
      });
    }),
);
