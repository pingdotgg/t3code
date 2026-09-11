import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ProviderInstanceId } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { mergeProviderSnapshot } from "../Layers/ProviderRegistry.ts";
import { DevinDriver } from "./DevinDriver.ts";
import {
  makeDevinCli as makeHarness,
  devinTestLayer as layer,
  encodeDevinProviders as encodeProviders,
  encodeDevinSkills,
} from "../testUtils/devinCli.ts";
const threadId = ThreadId.make("devin-thread");
const instanceId = ProviderInstanceId.make("devin-account");
const driverLayer = layer.pipe(
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
);

it.effect("keeps skills discoverable when ACP commands arrive before the workspace probe", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ T3_DEVIN_AUTH_STATUS: "Logged in (via Devin)." });
    const instance = yield* DevinDriver.create({
      instanceId,
      displayName: "Devin test account",
      enabled: true,
      config: h.settings,
      environment: [],
    });
    yield* instance.snapshot.refresh;
    yield* instance.adapter.startSession({ threadId, cwd: h.root, runtimeMode: "full-access" });
    expect((yield* instance.snapshot.getSnapshot).workspaceSnapshots).toEqual([]);
    if (!instance.snapshotForCwd) throw new Error("Devin must expose workspace metadata.");
    const discovered = yield* instance.snapshotForCwd(h.root);
    expect(discovered.slashCommands.some((command) => command.name === "plan")).toBe(true);
    expect(discovered.workspaceSnapshots?.map((workspace) => workspace.cwd)).toEqual([h.root]);
  }).pipe(Effect.provide(driverLayer)),
);

it.effect(
  "replaces cached Devin variants with family models and clears account metadata after logout",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-devin-auth-" });
      const statusFile = path.join(root, "status.txt");
      const modelsFile = path.join(root, "models.json");
      yield* fs.writeFileString(statusFile, "Logged in (via Devin).");
      const catalog =
        '{"families":[{"slug":"devin-test","family_label":"Devin Test","variants":[{"model_uid":"devin-test-low","label":"Devin Test Low"},{"model_uid":"devin-test-high","label":"Devin Test High"}]}]}';
      yield* fs.writeFileString(modelsFile, catalog);
      const h = yield* makeHarness({
        T3_ACP_DEVIN: "1",
        T3_ACP_DEVIN_STALE_MODELS: "1",
        T3_DEVIN_AUTH_STATUS_FILE: statusFile,
        T3_DEVIN_MODELS_FILE: modelsFile,
      });
      const instance = yield* DevinDriver.create({
        instanceId,
        displayName: "Devin test account",
        enabled: true,
        config: { ...h.settings, customModels: ["custom-devin-model"] },
        environment: [],
      });
      if (!instance.snapshotForCwd) throw new Error("Devin must expose workspace metadata.");
      const snapshot = yield* instance.snapshot.refresh;
      expect(() => encodeProviders([snapshot])).not.toThrow();
      expect(snapshot.instanceId).toBe(instanceId);
      expect(snapshot.supportsTextGeneration).toBe(false);
      const skillsFile = path.join(h.root, "devin-test-skills.json");
      yield* fs.writeFileString(
        skillsFile,
        encodeDevinSkills([
          {
            name: "visual-check",
            description: "Check the browser.",
            display_name: "Visual check",
            base_dir: path.join(h.root, ".devin", "skills", "visual-check"),
            triggers: ["user"],
            errors: [],
          },
        ]),
      );
      const workspace = yield* instance.snapshotForCwd(h.root);
      expect(workspace.skills.map((skill) => skill.name)).toEqual(["visual-check"]);
      expect(yield* fs.exists(h.launchLog)).toBe(false);
      const cached = {
        ...snapshot,
        models: snapshot.models.map((model) => ({ ...model, slug: `${model.slug}-old` })),
      };
      expect(mergeProviderSnapshot(cached, snapshot).models).toEqual(snapshot.models);
      const withoutTraits = {
        ...snapshot,
        models: snapshot.models.map((model) => ({
          ...model,
          capabilities: { optionDescriptors: [] },
        })),
      };
      expect(mergeProviderSnapshot(snapshot, withoutTraits).models).toEqual(withoutTraits.models);
      const title = yield* instance.textGeneration
        .generateThreadTitle({
          cwd: h.root,
          message: "Title",
          modelSelection: { instanceId, model: "devin-test" },
        })
        .pipe(Effect.result);
      expect(title._tag).toBe("Failure");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "devin-test",
        "custom-devin-model",
      ]);
      yield* instance.adapter.startSession({
        threadId,
        cwd: h.root,
        runtimeMode: "approval-required",
      });
      const activeSnapshot = yield* instance.snapshotForCwd(h.root);
      expect(
        activeSnapshot.workspaceSnapshots?.find((entry) => entry.cwd === h.root)?.skills,
      ).toEqual(workspace.skills);
      expect(() => encodeProviders([activeSnapshot])).not.toThrow();
      expect(activeSnapshot.models).toEqual(snapshot.models);
      expect(
        activeSnapshot.slashCommands.find((command) => command.name === "plan")?.input?.hint,
      ).toBe("[prompt]");
      expect(
        (yield* instance.snapshotForCwd(h.root)).slashCommands.some(
          (command) => command.name === "plan",
        ),
      ).toBe(true);
      yield* fs.writeFileString(modelsFile, "invalid response");
      const failedRefresh = yield* instance.snapshot.refresh;
      expect(failedRefresh.status).toBe("warning");
      expect(failedRefresh.models).toEqual(snapshot.models);
      yield* fs.writeFileString(skillsFile, "[]");
      expect(
        (yield* instance.snapshot.refresh).workspaceSnapshots?.find((entry) => entry.cwd === h.root)
          ?.skills,
      ).toEqual([]);
      yield* fs.writeFileString(modelsFile, '{"families":[]}');
      expect((yield* instance.snapshot.refresh).models.map((model) => model.slug)).toEqual([
        "custom-devin-model",
      ]);
      yield* fs.writeFileString(modelsFile, catalog);
      expect((yield* instance.snapshot.refresh).models).toEqual(snapshot.models);
      yield* fs.writeFileString(statusFile, "Not logged in.");
      yield* instance.snapshot.refresh;
      const signedOut = yield* instance.snapshotForCwd(h.root);
      expect(signedOut.auth.status).toBe("unauthenticated");
      expect(mergeProviderSnapshot(snapshot, signedOut).models).toEqual(signedOut.models);
      expect(signedOut.models.map((model) => model.slug)).toEqual(["custom-devin-model"]);
      expect(signedOut.workspaceSnapshots).toEqual([]);
      expect(signedOut.slashCommands.some((command) => command.name === "plan")).toBe(false);
    }).pipe(Effect.provide(driverLayer)),
);
