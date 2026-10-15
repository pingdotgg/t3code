import { describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  EnvironmentSupervisor,
} from "@t3tools/client-runtime/connection";
import { createIssueEnvironmentAtoms } from "@t3tools/client-runtime/state/issues";
import * as RpcClient from "../../../../../packages/client-runtime/src/rpc/client";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  type IssueTemplate,
  type IssueTemplateList,
  type IssueTemplatesInput,
} from "@t3tools/contracts";
import type { IssueCreateScope } from "./issueList";
import {
  fillIssueTemplate,
  issueTemplateBodyRead,
  issueTemplateCatalogRead,
  selectedIssueTemplate,
} from "./issueTemplate";

const scope: IssueCreateScope = {
  environmentId: EnvironmentId.make("environment"),
  projectTitle: "Project",
  templates: true,
  scope: {
    projectId: ProjectId.make("project"),
    tracker: IssueTrackerKind.make("gitlab"),
    host: "gitlab.example",
    scope: "group/app",
  },
};

const template = (key: string, patch: Partial<IssueTemplate> = {}): IssueTemplate => ({
  key,
  name: key,
  about: "",
  title: `${key} title`,
  body: `${key} body`,
  labels: [`${key}-label`],
  assignees: ["7"],
  ...patch,
});

const deferred = (key: string) =>
  template(key, { title: "", body: "", labels: [], assignees: [], contentDeferred: true });

const serve = (answer: (input: IssueTemplatesInput) => IssueTemplateList | Error) =>
  Effect.gen(function* () {
    const supervisor = {
      state: yield* SubscriptionRef.make({
        ...AVAILABLE_CONNECTION_STATE,
        phase: "connected" as const,
      }),
      session: yield* SubscriptionRef.make(Option.some({})),
    } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
    const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
      run: (_id, effect) =>
        Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      followStream: (_id, stream) =>
        Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
    const atoms = createIssueEnvironmentAtoms(
      Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry)),
    );
    const registry = AtomRegistry.make();
    yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
    const calls: IssueTemplatesInput[] = [];
    const request = vi.spyOn(RpcClient, "request");
    request.mockImplementation(((_tag: string, input: IssueTemplatesInput) =>
      Effect.suspend(() => {
        calls.push(input);
        const value = answer(input);
        return value instanceof Error ? Effect.fail(value) : Effect.succeed(value);
      })) as unknown as Parameters<typeof request.mockImplementation>[0]);
    yield* Effect.addFinalizer(() => Effect.sync(() => request.mockRestore()));
    const read = (
      target: { readonly environmentId: EnvironmentId; readonly input: IssueTemplatesInput } | null,
      refresh = false,
    ) =>
      Effect.gen(function* () {
        if (target === null) return { data: null, error: null, isPending: false };
        const atom = atoms.templates(target);
        registry.mount(atom);
        if (refresh) registry.refresh(atom);
        yield* Effect.ignore(AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }));
        const result = registry.get(atom);
        return {
          data: Option.getOrNull(AsyncResult.value(result)),
          error: result._tag === "Failure" ? "read failed" : null,
          isPending: result.waiting,
        };
      });
    const open = (templateKey: string, refresh = false) =>
      Effect.gen(function* () {
        const catalog = yield* read(issueTemplateCatalogRead(scope));
        const selected = yield* read(
          issueTemplateBodyRead(scope, catalog.data, templateKey),
          refresh,
        );
        return selectedIssueTemplate(templateKey, catalog, selected);
      });
    return { calls, open };
  });

describe("lazy issue templates", () => {
  it.effect("reads one bounded catalog and only the chosen body, then reuses both", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serve((input) =>
          input.templateKey === undefined
            ? { templates: [deferred("bug"), deferred("feature")], blankIssuesEnabled: true }
            : { templates: [template(input.templateKey)], blankIssuesEnabled: true },
        );
        expect(yield* server.open("")).toEqual({ template: null, blocked: null, retry: false });
        expect(yield* server.open("bug")).toEqual({
          template: template("bug"),
          blocked: null,
          retry: false,
        });
        yield* server.open("bug");
        expect(server.calls).toEqual([
          { ...scope.scope, metadataOnly: true },
          { ...scope.scope, templateKey: "bug" },
        ]);
      }),
    ),
  );

  it.effect("uses an older server's inline template without a second read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serve(() => ({
          templates: [template("bug")],
          blankIssuesEnabled: true,
        }));
        expect((yield* server.open("bug")).template).toEqual(template("bug"));
        expect(server.calls).toEqual([{ ...scope.scope, metadataOnly: true }]);
      }),
    ),
  );

  it.effect("blocks creation on a failed body read until a retry supplies it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let fail = true;
        const server = yield* serve((input) =>
          input.templateKey === undefined
            ? { templates: [deferred("bug")], blankIssuesEnabled: true }
            : fail
              ? new Error("body read failed")
              : { templates: [template("bug")], blankIssuesEnabled: true },
        );
        expect(yield* server.open("bug")).toEqual({
          template: null,
          blocked: "The selected template could not be read.",
          retry: true,
        });
        fail = false;
        expect((yield* server.open("bug", true)).template).toEqual(template("bug"));
      }),
    ),
  );

  it.effect(
    "rejects a body answer for another key or one still deferred, and accepts an empty body",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* serve((input) =>
            input.templateKey === undefined
              ? { templates: [deferred("bug"), deferred("empty")], blankIssuesEnabled: true }
              : input.templateKey === "bug"
                ? { templates: [template("feature"), deferred("bug")], blankIssuesEnabled: true }
                : { templates: [template("empty", { body: "" })], blankIssuesEnabled: true },
          );
          expect(yield* server.open("bug")).toMatchObject({ template: null, retry: true });
          expect(yield* server.open("empty")).toEqual({
            template: template("empty", { body: "" }),
            blocked: null,
            retry: false,
          });
        }),
      ),
  );

  it("keys each body read by its full scope and template", () => {
    const catalog = { templates: [deferred("bug")], blankIssuesEnabled: true };
    const other = { ...scope, scope: { ...scope.scope, host: "gitlab.other" } };
    expect(issueTemplateBodyRead(other, catalog, "bug")?.input).toEqual({
      ...other.scope,
      templateKey: "bug",
    });
    expect(issueTemplateBodyRead(scope, catalog, "feature")).toBeNull();
    expect(issueTemplateBodyRead({ ...scope, templates: false }, catalog, "bug")).toBeNull();
  });

  it("keeps fields the writer changed while the body loaded, including a cleared title", () => {
    expect(
      fillIssueTemplate({ title: false, body: true }, template("bug"), { title: "", body: "" }),
    ).toEqual({ title: "", body: "bug body", labels: ["bug-label"], assignees: ["7"] });
    expect(
      fillIssueTemplate({ title: true, body: false }, template("bug"), {
        title: "",
        body: "mine",
      }),
    ).toMatchObject({ title: "bug title", body: "mine" });
  });
});
