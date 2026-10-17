import {
  AuthOrchestrationReadScope,
  EnvironmentId,
  IssueTrackerConnectionError,
  IssueTrackerKind,
  WS_METHODS,
  type IssueTrackerScopesInput,
} from "@t3tools/contracts";
import { EnvironmentRegistry, EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import { Persistence } from "@t3tools/client-runtime/platform";
import { createIssueTrackerEnvironmentAtoms } from "@t3tools/client-runtime/state/issue-trackers";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Session from "@t3tools/client-runtime/state/session";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, vi } from "vite-plus/test";

import {
  connectFailureMessage,
  connectionFailureDetail,
  packCredential,
} from "./IssueTrackerSettings.logic";

const fields = [
  { key: "site", label: "Site", secret: false },
  { key: "email", label: "Email", secret: false },
  { key: "token", label: "Token", secret: true },
];

it.effect.each([
  { connectionId: undefined, canRead: true },
  { connectionId: "B", canRead: true },
  { connectionId: "B", canRead: false },
])("reads scopes through the actual guarded RPC for %j", ({ connectionId, canRead }) =>
  Effect.gen(function* () {
    const environmentId = EnvironmentId.make("scope-test");
    const calls: IssueTrackerScopesInput[] = [];
    const page = { items: [{ key: "NEXT", name: "Next team" }], nextCursor: null };
    const session = {
      client: {
        [WS_METHODS.issueTrackersScopes]: (input: IssueTrackerScopesInput) =>
          Effect.sync(() => {
            calls.push(input);
            return page;
          }),
      },
    } as unknown as RpcSession;
    const supervisor = {
      target: { environmentId, label: "Scope test" },
      state: yield* SubscriptionRef.make({ phase: "connected" }),
      session: yield* SubscriptionRef.make(Option.some(session)),
    } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
    yield* Effect.promise(async () => {
      const environment = EnvironmentRegistry.EnvironmentRegistry.of({
        run: (_id, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        followStream: (_id, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
      const runtime = Atom.runtime(
        Layer.merge(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environment),
          Layer.succeed(
            Persistence.EnvironmentCacheStore,
            new Proxy({} as Persistence.EnvironmentCacheStore["Service"], {
              get: () => {
                throw new Error("Unexpected persistent cache access");
              },
            }),
          ),
        ),
      );
      const sessionAtom = Atom.make(
        AsyncResult.success({
          authenticated: true,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: [],
            sessionMethods: [],
            sessionCookieName: "test",
          },
          scopes: canRead ? [AuthOrchestrationReadScope] : [],
          permissions: canRead ? [AuthOrchestrationReadScope] : [],
        }),
      );
      const sessions = vi
        .spyOn(Session, "createEnvironmentSessionAtoms")
        .mockReturnValue({ sessionStateAtom: () => sessionAtom } as unknown as ReturnType<
          typeof Session.createEnvironmentSessionAtoms
        >);
      const atoms = createIssueTrackerEnvironmentAtoms(runtime);
      const registry = AtomRegistry.make();
      const input = {
        tracker: IssueTrackerKind.make("linear"),
        ...(connectionId === undefined ? {} : { connectionId }),
        cursor: "next-B",
        limit: 100,
      };
      try {
        const result = await executeAtomQuery(registry, atoms.scopes({ environmentId, input }), {
          reportFailure: false,
          reportDefect: false,
        });
        if (canRead) {
          expect(
            result._tag,
            result._tag === "Failure" ? String(squashAtomCommandFailure(result)) : undefined,
          ).toBe("Success");
          expect(result).toMatchObject({ _tag: "Success", value: page });
          expect(calls).toEqual([input]);
        } else {
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(String(squashAtomCommandFailure(result))).toContain("orchestration:read");
          expect(calls).toEqual([]);
        }
      } finally {
        registry.dispose();
        sessions.mockRestore();
      }
    });
  }),
);

describe("packCredential", () => {
  it("sends a single raw credential as typed, trimmed", () => {
    expect(packCredential(undefined, { "": "  lin_api_x " })).toBe("lin_api_x");
    expect(packCredential(undefined, { "": "   " })).toBeNull();
  });

  it("packs every declared field into one JSON credential", () => {
    expect(
      JSON.parse(
        packCredential(fields, { site: " acme.atlassian.net ", email: "a@b.c", token: "t" }) ?? "",
      ),
    ).toEqual({ site: "acme.atlassian.net", email: "a@b.c", token: "t" });
  });

  it("refuses to pack while any field is blank", () => {
    expect(packCredential(fields, { site: "acme.atlassian.net", token: "t" })).toBeNull();
    expect(packCredential(fields, { site: "acme", email: " ", token: "t" })).toBeNull();
  });
});

describe("connectFailureMessage", () => {
  const error = (reason: "rejected" | "failed") =>
    new IssueTrackerConnectionError({
      tracker: IssueTrackerKind.make("jira"),
      reason,
      detail: "Jira could not be reached.",
    });

  it("says a refused credential was rejected", () => {
    expect(connectFailureMessage(error("rejected"))).toBe(
      "Credential rejected. Jira could not be reached.",
    );
  });

  it("reports any other failure without calling the credential rejected", () => {
    expect(connectFailureMessage(error("failed"))).toBe("Jira could not be reached.");
    expect(connectFailureMessage(new Error("Socket closed"))).toBe("Socket closed");
    expect(connectFailureMessage(undefined)).toBe("The request failed.");
  });

  it("reports a refused binding by its detail alone", () => {
    expect(connectionFailureDetail(error("rejected"))).toBe("Jira could not be reached.");
  });
});

it("allows optional deployment and email fields while requiring site and token", () => {
  const nativeFields = [
    { key: "site", label: "Site", secret: false },
    { key: "deployment", label: "Deployment", secret: false, optional: true },
    { key: "email", label: "Email", secret: false, optional: true },
    { key: "token", label: "Token", secret: true },
  ];
  expect(
    JSON.parse(
      packCredential(nativeFields, { site: " https://tracker.example/Jira ", token: " token " })!,
    ),
  ).toEqual({ site: "https://tracker.example/Jira", token: "token" });
  expect(packCredential(nativeFields, { token: "token" })).toBeNull();
  expect(packCredential(nativeFields, { site: "https://tracker.example/Jira" })).toBeNull();
  expect(packCredential(fields, { site: "https://cloud.example", token: "token" })).toBeNull();
});
