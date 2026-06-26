import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type {
  ProjectRecipeDiscovered,
  ProjectRecipeRenderContext,
  ProjectRecipeVisibilityResult,
} from "@t3tools/project-recipes";

import { discoverProjectRecipeModuleAtPath } from "./t3work-projectRecipeDiscoveryModule.ts";
import {
  decodeRawProjectRecipeManifest,
  normalizeRecipeManifest,
  resolveWithinRoot,
  type RawProjectRecipeManifest,
} from "./t3work-projectRecipeDiscoveryShared.ts";
import { evaluateVisibility } from "./t3work-projectRecipeDiscoveryVisibility.ts";
import {
  renderMaybeExpression,
  renderTemplateString,
} from "./t3work-projectRecipeDiscoveryTemplate.ts";

export function sortRecipes(left: ProjectRecipeDiscovered, right: ProjectRecipeDiscovered): number {
  if (left.rank !== right.rank) {
    return right.rank - left.rank;
  }
  return left.displayName.localeCompare(right.displayName);
}

export const discoverProjectRecipeAtPath = Effect.fn("discoverProjectRecipeAtPath")(
  function* (input: {
    readonly workspaceRoot: string;
    readonly recipePath: string;
    readonly context: ProjectRecipeRenderContext;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;

    // Prefer a typed `recipe.ts` module when present (Epic 16); the legacy `recipe.json` +
    // `{{ }}`-expression path below remains for recipes that ship it. The two coexist additively
    // and a directory with both resolves to the typed module.
    const modulePath = pathService.join(input.recipePath, "recipe.ts");
    if (yield* fileSystem.exists(modulePath).pipe(Effect.orElseSucceed(() => false))) {
      return yield* discoverProjectRecipeModuleAtPath({
        workspaceRoot: input.workspaceRoot,
        recipePath: input.recipePath,
        modulePath,
        context: input.context,
      });
    }

    const manifestPath = pathService.join(input.recipePath, "recipe.json");
    if (!(yield* fileSystem.exists(manifestPath).pipe(Effect.orElseSucceed(() => false)))) {
      return Option.none<ProjectRecipeDiscovered>();
    }

    const manifest = normalizeRecipeManifest(
      (yield* fileSystem
        .readFileString(manifestPath)
        .pipe(Effect.flatMap(decodeRawProjectRecipeManifest))) as RawProjectRecipeManifest,
    );
    if (!manifest.surfaces.includes(input.context.surface)) {
      return Option.none<ProjectRecipeDiscovered>();
    }

    const visibility = yield* evaluateVisibility({
      manifest,
      workspaceRoot: input.workspaceRoot,
      recipePath: input.recipePath,
      context: input.context,
    }).pipe(
      Effect.catch(() =>
        Effect.succeed({ visible: false } satisfies ProjectRecipeVisibilityResult),
      ),
    );
    if (!visibility.visible) {
      return Option.none<ProjectRecipeDiscovered>();
    }

    const promptPath = resolveWithinRoot(pathService, input.recipePath, manifest.prompt);
    const actionViewPath =
      typeof manifest.actionView === "string" && manifest.actionView.trim().length > 0
        ? resolveWithinRoot(pathService, input.recipePath, manifest.actionView)
        : undefined;
    const workflowPath =
      typeof manifest.workflow === "string" && manifest.workflow.trim().length > 0
        ? resolveWithinRoot(pathService, input.recipePath, manifest.workflow)
        : undefined;
    const prompt = renderTemplateString(
      yield* fileSystem.readFileString(promptPath),
      input.context,
    );
    const actionViewSource = actionViewPath
      ? yield* fileSystem.readFileString(actionViewPath)
      : undefined;
    const manifestRank = renderMaybeExpression(manifest.rank, input.context);
    const renderedDisplayName = renderTemplateString(manifest.displayName, input.context);
    const renderedShortDescription = renderTemplateString(manifest.shortDescription, input.context);
    const renderedIcon = renderMaybeExpression(manifest.icon, input.context);

    return Option.some({
      id: manifest.id,
      version: manifest.version,
      source: "project-local",
      displayName: renderedDisplayName,
      shortDescription: renderedShortDescription,
      ...(typeof renderedIcon === "string" && renderedIcon.length > 0
        ? { icon: renderedIcon }
        : {}),
      surfaces: manifest.surfaces,
      rank:
        visibility.rank ??
        (typeof manifestRank === "number" ? manifestRank : Number(manifestRank) || 0),
      ...(visibility.reason ? { reason: visibility.reason } : {}),
      prompt,
      ...(manifest.kickoff ? { kickoff: manifest.kickoff } : {}),
      sourcePath: manifestPath,
      promptPath,
      recipePath: input.recipePath,
      ...(actionViewPath ? { actionViewPath } : {}),
      ...(actionViewSource ? { actionViewSource } : {}),
      ...(workflowPath ? { workflowPath } : {}),
      allowedToolGroups: manifest.allowedToolGroups ?? [],
    } satisfies ProjectRecipeDiscovered);
  },
);
