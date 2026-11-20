import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { IssueTrackerKind } from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueTrackerCredential,
  type StandaloneIssueTrackerApi,
} from "@t3tools/source-control-core/server/IssueTracker";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as IssueTrackerBindings from "../persistence/IssueTrackerBindings.ts";
import * as IssueTrackerConnections from "./IssueTrackerConnections.ts";
import { decodeIssueTrackerCredential } from "./IssueTrackerHostLive.ts";
import * as IssueTrackerRegistry from "./IssueTrackerRegistry.ts";

const JIRA = IssueTrackerKind.make("jira");
const SITE = { site: "acme.atlassian.net" };

function harness(options: { readonly environmentLogin?: boolean; readonly refuse?: boolean }) {
  const saved = new Map<string, Uint8Array>();
  const probed: IssueTrackerCredential[] = [];
  const unexpected = () => Effect.die("Unexpected call");
  const tracker: StandaloneIssueTrackerApi = {
    kind: JIRA,
    capabilities: {
      create: false,
      edit: false,
      comment: false,
      labels: false,
      assignees: false,
      reactions: false,
      templates: false,
      linkedPullRequests: false,
      events: false,
      search: false,
    },
    standalone: {
      tracker: JIRA,
      displayName: "Jira",
      host: "atlassian.net",
      scopeNoun: "project",
      credential: {
        label: "API token",
        helpUrl: null,
        fields: [
          { key: "site", label: "Site", placeholder: null },
          { key: "email", label: "Account email", placeholder: null },
        ],
      },
      ...(options.environmentLogin === false
        ? {}
        : {
            environmentLogin: {
              label: "TWG",
              description: "Run twg login first.",
              fields: [{ key: "site", label: "Site", placeholder: null }],
            },
          }),
    },
    getViewer: unexpected,
    listIssues: unexpected,
    getIssue: unexpected,
    getComments: unexpected,
    probeCredential: (credential) => {
      probed.push(credential);
      return options.refuse === true
        ? Effect.fail(
            new IssueTrackerError({
              tracker: JIRA,
              operation: "probeCredential",
              reason: "unauthenticated",
              detail: "TWG is signed out.",
            }),
          )
        : Effect.succeed({ account: "Sam Rivera", scopes: [{ key: "ENG", name: "Engineering" }] });
    },
  };
  const layer = IssueTrackerConnections.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          IssueTrackerRegistry.IssueTrackerRegistry,
          IssueTrackerRegistry.fromTrackers([tracker]),
        ),
        Layer.succeed(ServerSecretStore.ServerSecretStore, {
          get: (name) => Effect.sync(() => Option.fromUndefinedOr(saved.get(name))),
          set: (name, value) => Effect.sync(() => void saved.set(name, value)),
          remove: (name) => Effect.sync(() => void saved.delete(name)),
          create: unexpected,
          getOrCreateRandom: unexpected,
        }),
        Layer.succeed(IssueTrackerBindings.IssueTrackerBindingsRepository, {
          list: Effect.succeed(new Map()),
          set: () => Effect.void,
          removeTracker: () => Effect.void,
        }),
      ),
    ),
  );
  return { saved, probed, layer };
}

describe("IssueTrackerConnections environment login", () => {
  it.effect("stores a vetted environment login with no secret, then disconnects it", () => {
    const h = harness({});
    return Effect.gen(function* () {
      const service = yield* IssueTrackerConnections.IssueTrackerConnections;
      const connection = yield* service.connect({
        tracker: JIRA,
        authentication: "environment",
        fields: { ...SITE, email: "not asked for" },
      });
      expect(connection).toMatchObject({ authentication: "environment", account: "Sam Rivera" });
      expect(h.probed).toEqual([{ authentication: "environment", token: "", fields: SITE }]);
      expect([...h.saved.values()].map(decodeIssueTrackerCredential)).toEqual(h.probed);
      expect((yield* service.list).trackers[0]).toMatchObject({
        authentication: "environment",
        fields: SITE,
      });
      expect((yield* service.connect({ tracker: JIRA, token: null })).connected).toBe(false);
      expect(h.saved.size).toBe(0);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect.each([
    { name: "no token", input: { tracker: JIRA, fields: SITE } },
    { name: "no site", input: { tracker: JIRA, authentication: "environment" as const } },
    {
      name: "a token beside an environment login",
      input: {
        tracker: JIRA,
        authentication: "environment" as const,
        token: "pasted-by-mistake",
        fields: SITE,
      },
    },
  ])("refuses $name before asking the tracker", ({ input }) => {
    const h = harness({});
    return Effect.gen(function* () {
      const service = yield* IssueTrackerConnections.IssueTrackerConnections;
      expect((yield* service.connect(input).pipe(Effect.flip)).reason).toBe("rejected");
      expect(h.probed).toEqual([]);
      expect(h.saved.size).toBe(0);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect.each([
    { name: "a tracker without one", environmentLogin: false, refuse: false },
    { name: "a login the tracker refuses", environmentLogin: true, refuse: true },
  ])("stores no environment login for $name", (options) => {
    const h = harness(options);
    return Effect.gen(function* () {
      const service = yield* IssueTrackerConnections.IssueTrackerConnections;
      const error = yield* service
        .connect({ tracker: JIRA, authentication: "environment", fields: SITE })
        .pipe(Effect.flip);
      expect(error.reason).toBe("rejected");
      expect(h.saved.size).toBe(0);
    }).pipe(Effect.provide(h.layer));
  });
});
