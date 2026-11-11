import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ContributorBundleLoader from "../project/ContributorBundleLoader.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ContributorBundle from "./ContributorBundleService.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const projectId = ProjectId.make("project:contributor-bundle");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;
const project = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  pinnedAt: null,
  archivedAt: null,
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deletedAt: null,
} as const;

const workshopBundle = {
  name: "T3 Workshop contributors",
  description: "Repo-aware Workshop seats.",
  orientation: {
    summary: "T3 Code wraps provider CLIs for web, desktop, and mobile.",
    map: [{ path: "apps/server", purpose: "Orchestration" }],
    guidance: "Run vp run check:changed before push.",
  },
  seats: [
    {
      id: "lead",
      title: "Workshop · Lead",
      roleBrief: "Coordinate Builder and QA.",
    },
    {
      id: "builder",
      title: "Workshop · Builder",
      roleBrief: "Implement the change.",
    },
    {
      id: "qa",
      title: "Workshop · QA",
      roleBrief: "Verify the user path.",
    },
  ],
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in contributor bundle tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

function makeHarness(bundle: typeof workshopBundle | null) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([adapter]);
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "contributor-bundle" },
    layerRegistry,
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest();
  const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(layerReceipts),
  );
  const layerProjects = Layer.succeed(ProjectService.ProjectService, {
    create: () => Effect.die("unused"),
    bootstrap: () => Effect.die("unused"),
    update: () => Effect.die("unused"),
    delete: () => Effect.die("unused"),
    listPage: () => Effect.die("unused"),
    getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
    getByWorkspaceRoot: () => Effect.succeedSome(project),
    workspaceScanDirectory: () => Effect.die("unused"),
    snapshot: Effect.die("unused"),
    getShell: () => Effect.die("unused"),
    listShells: () => Effect.die("unused"),
  });
  const layerBundleLoader = Layer.succeed(ContributorBundleLoader.ContributorBundleLoader, {
    load: () => Effect.succeed(bundle === null ? Option.none() : Option.some(bundle)),
  });
  const layerContributorBundle = ContributorBundle.layer.pipe(
    Layer.provide(
      Layer.mergeAll(layerProjects, layerBundleLoader, layerThreadManagement, IdAllocator.layer),
    ),
  );
  return Layer.mergeAll(
    layerContributorBundle,
    layerThreadManagement,
    layerRegistry,
    ProviderRegistryMock.layer(),
    layerDatabase,
  );
}

it.effect("installs pinned Workshop seats with project orientation in the lead prompt", () =>
  Effect.gen(function* () {
    const service = yield* ContributorBundle.ContributorBundleService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const result = yield* service.install({
      commandId: CommandId.make("command:contributor-bundle"),
      projectId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
    });

    assert.equal(result.name, "T3 Workshop contributors");
    assert.include(result.leadPrompt, "Project orientation");
    assert.include(result.leadPrompt, "apps/server: Orchestration");
    assert.include(result.leadPrompt, "Pinned teammates:");
    assert.deepEqual(
      result.seats.map((seat) => seat.seatId),
      ["lead", "builder", "qa"],
    );
    assert.include(result.seats[0]?.roleBrief ?? "", "Project orientation");

    for (const seat of result.seats) {
      const shell = yield* threads.getThreadShell(seat.threadId);
      assert.isNotNull(shell);
      assert.equal(shell?.projectId, projectId);
      assert.equal(shell?.title, seat.title);
      assert.isNotNull(shell?.pinnedAt);
      assert.equal(shell?.status, "idle");
    }
  }).pipe(Effect.provide(makeHarness(workshopBundle))),
);

it.effect("fails when the contributor bundle file is missing", () =>
  Effect.gen(function* () {
    const service = yield* ContributorBundle.ContributorBundleService;
    const error = yield* service
      .install({
        commandId: CommandId.make("command:missing-bundle"),
        projectId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      })
      .pipe(Effect.flip);
    assert.equal(error._tag, "OrchestrationV2InstallContributorBundleError");
    assert.match(error.message, /No valid t3\.contributor-bundle\.json/);
  }).pipe(Effect.provide(makeHarness(null))),
);

it.effect("fails when the project is missing", () =>
  Effect.gen(function* () {
    const service = yield* ContributorBundle.ContributorBundleService;
    const error = yield* service
      .install({
        commandId: CommandId.make("command:missing-project"),
        projectId: ProjectId.make("project:missing"),
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      })
      .pipe(Effect.flip);
    assert.equal(error._tag, "OrchestrationV2InstallContributorBundleError");
    assert.match(error.message, /Project not found/);
  }).pipe(Effect.provide(makeHarness(workshopBundle))),
);
