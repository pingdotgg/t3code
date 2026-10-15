import { assert, it } from "@effect/vitest";
import {
  IssueTrackerKind,
  ProjectId,
  type IssueTrackerProjectBinding,
  type Project,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type StandaloneIssueTrackerApi,
} from "@t3tools/issue-tracker-core/server/IssueTracker";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as IssueTrackerBindings from "../persistence/IssueTrackerBindings.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as IssueTrackerConnections from "./IssueTrackerConnections.ts";
import * as IssueTrackerRegistry from "./IssueTrackerRegistry.ts";

const tracker = IssueTrackerKind.make("custom-tracker");
const projectId = ProjectId.make("project-1");
const project: Project = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/tmp/project",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-14T00:00:00Z",
  updatedAt: "2026-10-14T00:00:00Z",
  deletedAt: null,
};
const binding = { tracker, scope: "TEAM" };

const makeFixture = (input: {
  readonly stored: string | null;
  readonly projectExists: boolean;
  readonly probe: ReturnType<StandaloneIssueTrackerApi["probeCredential"]>;
  readonly probeForToken?: StandaloneIssueTrackerApi["probeCredential"];
  readonly host?: string | null;
  readonly getScope?: StandaloneIssueTrackerApi["getScope"];
  readonly credentialWriteFailure?: "before" | "after";
  readonly credentialRestoreFailure?: "before" | "after";
  readonly credentialReadFailure?: 2 | 3;
}) =>
  Effect.gen(function* () {
    const writes: Array<
      Parameters<IssueTrackerBindings.IssueTrackerBindingsRepository["Service"]["set"]>[0]
    > = [];
    const probed: string[] = [];
    const credentials: string[] = [];
    let stored = input.stored;
    let credentialReads = 0;
    let credentialWrites = 0;
    const saved = new Map<ProjectId, IssueTrackerProjectBinding>();
    const unused = () => Effect.die("Unexpected tracker operation");
    const api: StandaloneIssueTrackerApi = {
      kind: tracker,
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
        states: [],
        closeReasons: [],
      },
      getViewer: unused,
      listIssues: unused,
      getIssue: unused,
      getComments: unused,
      getViewerPermissions: unused,
      standalone: {
        tracker,
        displayName: "Tracker",
        host: input.host === undefined ? "tracker.example" : input.host,
        scopeNoun: "team",
        credential: { label: "Token", helpUrl: null },
      },
      probeCredential: (token) =>
        Effect.sync(() => {
          probed.push(token);
        }).pipe(Effect.andThen(input.probeForToken?.(token) ?? input.probe)),
      ...(input.getScope === undefined ? {} : { getScope: input.getScope }),
    };
    const service = yield* IssueTrackerConnections.IssueTrackerConnections.pipe(
      Effect.provide(
        IssueTrackerConnections.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(
                IssueTrackerRegistry.IssueTrackerRegistry,
                IssueTrackerRegistry.fromTrackers([api]),
              ),
              Layer.mock(ServerSecretStore.ServerSecretStore)({
                get: () =>
                  Effect.gen(function* () {
                    credentialReads++;
                    if (credentialReads === input.credentialReadFailure) {
                      return yield* new ServerSecretStore.SecretStoreReadError({
                        resource: "test-credential",
                        cause: new Error("Credential read failed."),
                      });
                    }
                    return stored === null
                      ? Option.none()
                      : Option.some(new TextEncoder().encode(stored));
                  }),
                remove: () =>
                  Effect.sync(() => {
                    stored = null;
                  }),
                set: (_name, bytes) =>
                  Effect.gen(function* () {
                    credentialWrites++;
                    if (
                      input.credentialWriteFailure === "before" ||
                      (credentialWrites > 1 && input.credentialRestoreFailure === "before")
                    ) {
                      return yield* new ServerSecretStore.SecretStorePersistError({
                        resource: "test-credential",
                        cause: new Error("Storage failed."),
                      });
                    }
                    stored = new TextDecoder().decode(bytes);
                    credentials.push(stored);
                    if (
                      (input.credentialWriteFailure === "after" && credentialWrites === 1) ||
                      (credentialWrites > 1 && input.credentialRestoreFailure === "after")
                    ) {
                      return yield* new ServerSecretStore.SecretStorePersistError({
                        resource: "test-credential",
                        cause: new Error("Storage failed after write."),
                      });
                    }
                  }),
              }),
              Layer.mock(IssueTrackerBindings.IssueTrackerBindingsRepository)({
                list: Effect.sync(() => new Map(saved)),
                set: (input) =>
                  Effect.sync(() => {
                    writes.push(input);
                    if (input.binding === null) saved.delete(input.projectId);
                    else saved.set(input.projectId, input.binding);
                  }),
                removeTracker: (tracker) =>
                  Effect.sync(() => {
                    for (const [projectId, binding] of saved)
                      if (binding.tracker === tracker) saved.delete(projectId);
                  }),
              }),
              Layer.mock(ProjectService.ProjectService)({
                getById: () =>
                  Effect.succeed(input.projectExists ? Option.some(project) : Option.none()),
              }),
            ),
          ),
        ),
      ),
    );
    return { service, writes, probed, saved, credentials };
  });

it.effect.each(["before", "after"] as const)(
  "keeps the old credential and bindings when storage fails %s writing",
  (credentialWriteFailure) =>
    Effect.gen(function* () {
      const previous = {
        account: "Old account",
        accountId: "old-account",
        host: "old.example",
        scopes: [{ key: "TEAM", name: "Team" }],
      };
      const next = {
        ...previous,
        account: "New account",
        accountId: "new-account",
        host: "new.example",
      };
      const fixture = yield* makeFixture({
        stored: "old-token",
        projectExists: true,
        host: null,
        probe: Effect.succeed(next),
        probeForToken: (token) => Effect.succeed(token === "old-token" ? previous : next),
        credentialWriteFailure,
      });
      const oldBindings = new Map<ProjectId, IssueTrackerProjectBinding>([
        [projectId, { ...binding, host: "old.example" }],
        [ProjectId.make("project-2"), { tracker, scope: "OTHER", host: "old.example" }],
        [
          ProjectId.make("project-3"),
          {
            tracker: IssueTrackerKind.make("other-tracker"),
            scope: "KEEP",
            host: "other.example",
          },
        ],
      ]);
      for (const [projectId, binding] of oldBindings) fixture.saved.set(projectId, binding);
      assert.equal(
        (yield* fixture.service.connect({ tracker, token: "new-token" }).pipe(Effect.flip)).reason,
        "failed",
      );
      assert.deepEqual(fixture.saved, oldBindings);
      const current = yield* fixture.service.list;
      assert.equal(current.trackers[0]?.host, "old.example");
      assert.equal(current.trackers[0]?.account, "Old account");
      assert.deepEqual(
        fixture.credentials,
        credentialWriteFailure === "before" ? [] : ["new-token", "old-token"],
      );
    }),
);

it.effect.each([
  { credentialReadFailure: 2, credentialRestoreFailure: undefined, restored: true },
  { credentialReadFailure: undefined, credentialRestoreFailure: "after", restored: true },
  { credentialReadFailure: undefined, credentialRestoreFailure: "before", restored: false },
  { credentialReadFailure: 3, credentialRestoreFailure: "after", restored: false },
] as const)("restores bindings only with a recovered old credential: %j", (scenario) =>
  Effect.gen(function* () {
    const previous = {
      account: "Old account",
      accountId: "old-account",
      host: "shared.example",
      scopes: [{ key: "TEAM", name: "Team" }],
    };
    const next = { ...previous, account: "New account", accountId: "new-account" };
    const fixture = yield* makeFixture({
      stored: "old-token",
      projectExists: true,
      probe: Effect.succeed(next),
      probeForToken: (token) => Effect.succeed(token === "old-token" ? previous : next),
      credentialWriteFailure: "after",
      ...(scenario.credentialReadFailure === undefined
        ? {}
        : { credentialReadFailure: scenario.credentialReadFailure }),
      ...(scenario.credentialRestoreFailure === undefined
        ? {}
        : { credentialRestoreFailure: scenario.credentialRestoreFailure }),
    });
    const previousBinding = { ...binding, host: "shared.example" };
    fixture.saved.set(projectId, previousBinding);
    assert.equal(
      (yield* fixture.service.connect({ tracker, token: "new-token" }).pipe(Effect.flip)).reason,
      "failed",
    );
    assert.deepEqual(fixture.saved.get(projectId), scenario.restored ? previousBinding : undefined);
    assert.deepEqual(
      fixture.credentials,
      scenario.credentialRestoreFailure === "before" ? ["new-token"] : ["new-token", "old-token"],
    );
    if (scenario.restored)
      assert.equal((yield* fixture.service.list).trackers[0]?.account, "Old account");
  }),
);

it.effect("clears same-account bindings when replacement and rollback both fail", () =>
  Effect.gen(function* () {
    const identity = {
      account: "Account",
      accountId: "account",
      host: "shared.example",
      scopes: [{ key: "TEAM", name: "Team" }],
    };
    const fixture = yield* makeFixture({
      stored: "old-token",
      projectExists: true,
      probe: Effect.succeed(identity),
      credentialWriteFailure: "after",
      credentialRestoreFailure: "before",
    });
    fixture.saved.set(projectId, { ...binding, host: "shared.example" });
    const otherProject = ProjectId.make("other-project");
    const otherBinding = { tracker: IssueTrackerKind.make("other"), scope: "OTHER" };
    fixture.saved.set(otherProject, otherBinding);
    assert.equal(
      (yield* fixture.service.connect({ tracker, token: "new-token" }).pipe(Effect.flip)).reason,
      "failed",
    );
    assert.deepEqual(fixture.saved, new Map([[otherProject, otherBinding]]));
    assert.deepEqual(fixture.credentials, ["new-token"]);
  }),
);

it.effect("removes a partially stored credential when the first connection fails", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture({
      stored: null,
      projectExists: true,
      probe: Effect.succeed({ account: "New account", host: "new.example", scopes: [] }),
      credentialWriteFailure: "after",
    });
    assert.equal(
      (yield* fixture.service.connect({ tracker, token: "new-token" }).pipe(Effect.flip)).reason,
      "failed",
    );
    assert.isFalse((yield* fixture.service.list).trackers[0]?.connected);
    assert.equal(fixture.saved.size, 0);
  }),
);

it.effect("rejects unavailable credentials, scopes, and projects without saving a binding", () =>
  Effect.gen(function* () {
    const valid = Effect.succeed({ account: "account", scopes: [{ key: "TEAM", name: "Team" }] });
    const rejected = Effect.fail(
      new IssueTrackerError({
        tracker,
        operation: "probe",
        reason: "unauthenticated",
        detail: "Credential rejected.",
      }),
    );
    for (const scenario of [
      { stored: null, projectExists: true, probe: valid, probes: 0 },
      { stored: "", projectExists: true, probe: valid, probes: 0 },
      { stored: "test-token", projectExists: true, probe: rejected, probes: 1 },
      {
        stored: "test-token",
        projectExists: true,
        probe: Effect.succeed({ account: "account", scopes: [{ key: "OTHER", name: "Other" }] }),
        probes: 1,
      },
      { stored: "test-token", projectExists: false, probe: valid, probes: 0 },
    ]) {
      const fixture = yield* makeFixture(scenario);
      assert.equal(
        (yield* fixture.service.bindProject({ projectId, binding }).pipe(Effect.flip)).reason,
        "rejected",
      );
      assert.deepEqual(fixture.writes, []);
      assert.equal(fixture.probed.length, scenario.probes);
    }
  }),
);

it.effect("disconnect waits for an in-flight binding and clears it", () =>
  Effect.gen(function* () {
    const probeStarted = yield* Deferred.make<void>();
    const probeRelease = yield* Deferred.make<void>();
    const disconnectStarted = yield* Deferred.make<void>();
    const fixture = yield* makeFixture({
      stored: "test-token",
      projectExists: true,
      probe: Deferred.succeed(probeStarted, undefined).pipe(
        Effect.andThen(Deferred.await(probeRelease)),
        Effect.as({ account: "account", scopes: [{ key: "TEAM", name: "Team" }] }),
      ),
    });
    const bindingFiber = yield* fixture.service
      .bindProject({ projectId, binding })
      .pipe(Effect.forkChild);
    yield* Deferred.await(probeStarted);
    const disconnectFiber = yield* Deferred.succeed(disconnectStarted, undefined).pipe(
      Effect.andThen(fixture.service.connect({ tracker, token: null })),
      Effect.forkChild,
    );
    yield* Deferred.await(disconnectStarted);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(probeRelease, undefined);
    yield* Fiber.join(bindingFiber);
    yield* Fiber.join(disconnectFiber);
    assert.isFalse(fixture.saved.has(projectId));
  }),
);

it.effect("probes the stored credential once before saving an available scope", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture({
      stored: "test-token",
      projectExists: true,
      probe: Effect.succeed({ account: "account", scopes: [{ key: "TEAM", name: "Team" }] }),
    });
    yield* fixture.service.bindProject({ projectId, binding });
    assert.deepEqual(fixture.probed, ["test-token"]);
    assert.equal(fixture.writes.length, 1);
    assert.deepEqual(fixture.writes[0]?.binding, { ...binding, host: "tracker.example" });
    assert.equal(fixture.writes[0]?.projectId, projectId);
  }),
);

it.effect("saves the verified host and rejects a scope with no verified host", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture({
      stored: "test-token",
      projectExists: true,
      host: null,
      probe: Effect.succeed({
        account: "account",
        host: "tenant.example",
        scopesTruncated: true,
        scopes: [{ key: "TEAM", name: "Team" }],
      }),
    });
    yield* fixture.service.bindProject({
      projectId,
      binding: { ...binding, host: "other.example" },
    });
    assert.deepEqual(fixture.writes[0]?.binding, { ...binding, host: "tenant.example" });
    const missingHost = yield* makeFixture({
      stored: "test-token",
      projectExists: true,
      host: null,
      probe: Effect.succeed({ account: "account", scopes: [{ key: "TEAM", name: "Team" }] }),
    });
    assert.equal(
      (yield* missingHost.service.bindProject({ projectId, binding }).pipe(Effect.flip)).reason,
      "rejected",
    );
    assert.deepEqual(missingHost.writes, []);
  }),
);

it.effect("unbinds a project without a credential, probe, or live project", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture({
      stored: null,
      projectExists: false,
      probe: Effect.die("Unexpected credential probe"),
    });
    yield* fixture.service.bindProject({ projectId, binding: null });
    assert.deepEqual(fixture.probed, []);
    assert.equal(fixture.writes.length, 1);
    assert.isNull(fixture.writes[0]?.binding);
  }),
);

it.effect("reports the verified site on connect and status for a tracker with no fixed host", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture({
      stored: null,
      projectExists: true,
      host: null,
      probe: Effect.succeed({
        account: "Alex",
        accountId: "native-1",
        host: "tenant.example",
        scopesTruncated: true,
        scopes: [{ key: "TEAM", name: "Team" }],
      }),
    });
    const connected = yield* fixture.service.connect({ tracker, token: "new-token" });
    assert.equal(connected.host, "tenant.example");
    assert.isTrue(connected.scopesTruncated);
    assert.deepEqual(fixture.credentials, ["new-token"]);
    const listed = yield* fixture.service.list;
    assert.equal(listed.trackers[0]?.host, "tenant.example");
    assert.isTrue(listed.trackers[0]?.scopesTruncated);
  }),
);

it.effect(
  "keeps bindings only when a replacement credential has the same verified site and account",
  () =>
    Effect.gen(function* () {
      const next = {
        account: "Alex",
        accountId: "native-1",
        host: "tenant.example",
        scopes: [{ key: "TEAM", name: "Team" }],
      };
      const failure = new IssueTrackerError({
        tracker,
        operation: "probe",
        reason: "unauthenticated",
        detail: "Old credential expired.",
      });
      for (const previous of [
        { probe: Effect.succeed(next), kept: true },
        { probe: Effect.succeed({ ...next, host: "other.example" }), kept: false },
        { probe: Effect.succeed({ ...next, accountId: "native-2" }), kept: false },
        { probe: Effect.fail(failure), kept: false },
      ]) {
        const fixture = yield* makeFixture({
          stored: "old-token",
          projectExists: true,
          host: null,
          probe: Effect.succeed(next),
          probeForToken: (token) => (token === "old-token" ? previous.probe : Effect.succeed(next)),
        });
        fixture.saved.set(projectId, { ...binding, host: "tenant.example" });
        yield* fixture.service.connect({ tracker, token: "new-token" });
        assert.equal(fixture.saved.has(projectId), previous.kept);
        assert.deepEqual(fixture.probed, ["new-token", "old-token"]);
        assert.deepEqual(fixture.credentials, ["new-token"]);
      }
    }),
);

it.effect.each([
  { previousId: undefined, nextId: undefined },
  { previousId: undefined, nextId: "Alex" },
  { previousId: "Alex", nextId: undefined },
] as const)("clears bindings when either account ID is missing: %j", ({ previousId, nextId }) =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture({
      stored: "old-token",
      projectExists: true,
      probe: Effect.die("Unexpected credential probe"),
      probeForToken: (token) => {
        const accountId = token === "old-token" ? previousId : nextId;
        return Effect.succeed({
          account: "Alex",
          ...(accountId === undefined ? {} : { accountId }),
          scopes: [],
        });
      },
    });
    fixture.saved.set(projectId, binding);
    yield* fixture.service.connect({ tracker, token: "new-token" });
    assert.isFalse(fixture.saved.has(projectId));
    assert.deepEqual(fixture.credentials, ["new-token"]);
  }),
);

it.effect("refuses a credential whose driver does not provide its actual site", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture({
      stored: null,
      projectExists: true,
      host: null,
      probe: Effect.succeed({ account: "Alex", scopes: [] }),
    });
    assert.equal(
      (yield* fixture.service.connect({ tracker, token: "new-token" }).pipe(Effect.flip)).reason,
      "rejected",
    );
    assert.deepEqual(fixture.credentials, []);
  }),
);

it.effect("validates a missing scope with one native lookup only when the catalog is partial", () =>
  Effect.gen(function* () {
    for (const truncated of [true, false]) {
      const lookups: string[] = [];
      const fixture = yield* makeFixture({
        stored: "test-token",
        projectExists: true,
        probe: Effect.succeed({ account: "Alex", scopes: [], scopesTruncated: truncated }),
        getScope: (token, scope) =>
          Effect.sync(() => {
            lookups.push(`${token} ${scope}`);
            return { key: "ENG", name: "Engineering" };
          }),
      });
      const requested = { projectId, binding: { tracker, scope: "eng" } };
      if (truncated) {
        yield* fixture.service.bindProject(requested);
        assert.deepEqual(fixture.writes[0]?.binding, {
          tracker,
          scope: "ENG",
          host: "tracker.example",
        });
        assert.deepEqual(lookups, ["test-token eng"]);
      } else {
        assert.equal(
          (yield* fixture.service.bindProject(requested).pipe(Effect.flip)).reason,
          "rejected",
        );
        assert.deepEqual(lookups, []);
        assert.deepEqual(fixture.writes, []);
      }
    }
  }),
);
