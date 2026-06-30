import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  AsanaProvider,
  GithubIssuesProvider,
  JiraProvider,
  WorkSourceProviderRegistry,
  type WorkSourceProvider,
} from "../Services/WorkSourceProvider.ts";
import { WorkSourceProviderRegistryLive } from "./WorkSourceProviderRegistry.ts";

const makeStub = (name: "github" | "asana" | "jira"): WorkSourceProvider => ({
  provider: name,
  selectorSchema: Schema.Unknown,
  listPage: () => Effect.succeed({ items: [] }),
  getItem: () => Effect.succeed(null),
  viewer: () => Effect.succeed(null),
  toImportableView: () => ({ displayRef: "", container: "" }),
});

const githubStubLayer = Layer.succeed(GithubIssuesProvider, makeStub("github"));
const asanaStubLayer = Layer.succeed(AsanaProvider, makeStub("asana"));
const jiraStubLayer = Layer.succeed(JiraProvider, makeStub("jira"));

const testLayer = WorkSourceProviderRegistryLive.pipe(
  Layer.provide(Layer.mergeAll(githubStubLayer, asanaStubLayer, jiraStubLayer)),
);

const layer = it.layer(testLayer);

layer("WorkSourceProviderRegistry", (it) => {
  it.effect("get('github') returns the github provider", () =>
    Effect.gen(function* () {
      const registry = yield* WorkSourceProviderRegistry;
      const provider = registry.get("github");
      assert.equal(provider.provider, "github");
    }),
  );

  it.effect("get('asana') returns the asana provider", () =>
    Effect.gen(function* () {
      const registry = yield* WorkSourceProviderRegistry;
      const provider = registry.get("asana");
      assert.equal(provider.provider, "asana");
    }),
  );

  it.effect("get('jira') returns the jira provider", () =>
    Effect.gen(function* () {
      const registry = yield* WorkSourceProviderRegistry;
      const provider = registry.get("jira");
      assert.equal(provider.provider, "jira");
    }),
  );

  it.effect("Fix L8: get(<unknown provider>) throws instead of misrouting to asana", () =>
    Effect.gen(function* () {
      const registry = yield* WorkSourceProviderRegistry;
      // Simulate a future provider literal added to the contract union but not
      // wired into the registry. The exhaustive switch must FAIL FAST rather
      // than silently dispatch to the asana provider.
      assert.throws(() => registry.get("linear" as never), /Unknown work-source provider: linear/u);
    }),
  );
});
