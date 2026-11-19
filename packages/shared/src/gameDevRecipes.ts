import type { GameEngineId } from "@t3tools/contracts";

/**
 * Reusable Game Development tasks. Each adapts to the active engine and ends with a test the
 * agent can run through the bridge (`continuum_game_run_tests`), so "done" is checkable.
 */
export interface GameRecipeEngineVariant {
  readonly prompt: string;
  /** The test the agent writes and runs, in the engine's own framework. */
  readonly test: { readonly framework: string; readonly path: string; readonly filter: string };
}

export interface GameRecipe {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  /** Text the user fills in, such as the error to fix. Null when the recipe needs none. */
  readonly input: { readonly label: string; readonly placeholder: string } | null;
  readonly engines: Record<GameEngineId, GameRecipeEngineVariant>;
}

const COMMON_CLOSE =
  "Before you finish: make a Game Project Checkpoint, inspect the scene through the bridge, run the test with continuum_game_run_tests and show its result, then start a playtest and read the logs for errors.";

export const GAME_RECIPES: ReadonlyArray<GameRecipe> = [
  {
    id: "inventory",
    title: "Build a working inventory",
    summary: "Data model, add/remove/stack logic, and a simple on-screen list.",
    input: null,
    engines: {
      roblox: {
        prompt:
          "Build a working inventory for this Roblox place. Put the logic in a ModuleScript `ReplicatedStorage.Inventory` (add, remove, stack up to a max per item, count, list), keep authoritative state on the server, and show the player's items in a ScreenGui list that updates on change. Write a spec at `ServerScriptService.Tests.Inventory.spec` that covers adding, stacking, removing to zero, and refusing to remove more than held.",
        test: { framework: "Continuum Luau specs", path: "ServerScriptService.Tests.Inventory.spec", filter: "Inventory" },
      },
      unity: {
        prompt:
          "Build a working inventory for this Unity project. Add a plain C# `Inventory` class (add, remove, stack up to a max per item, count, list, change event) in `Assets/Scripts/Inventory`, a `MonoBehaviour` that owns one, and a minimal UI list bound to it. Add an Edit Mode test assembly at `Assets/Tests/EditMode` with tests for adding, stacking, removing to zero, and refusing to remove more than held.",
        test: { framework: "Unity Test Framework (Edit Mode)", path: "Assets/Tests/EditMode/InventoryTests.cs", filter: "InventoryTests" },
      },
      unreal: {
        prompt:
          "Build a working inventory for this Unreal project. Add a `UInventoryComponent` (C++ if the project has a Source folder, otherwise a Blueprint component) with add, remove, stack up to a max per item, count, and an OnInventoryChanged delegate, and a simple UMG list bound to it. Add an automation test `Project.Inventory` covering adding, stacking, removing to zero, and refusing to remove more than held.",
        test: { framework: "Unreal Automation", path: "Source/<Project>/Tests/InventoryTest.cpp", filter: "Project.Inventory" },
      },
    },
  },
  {
    id: "fix-playtest-error",
    title: "Fix this playtest error",
    summary: "Reproduce the error in a playtest, fix the cause, and prove it is gone.",
    input: { label: "Error or log line", placeholder: "Paste the error from the playtest logs" },
    engines: {
      roblox: {
        prompt:
          "Fix this playtest error in the Roblox place: {input}\n\nStart a playtest and read the Output logs to reproduce it, find the cause in the scripts, fix it, and add a spec under `ServerScriptService.Tests` that fails without the fix.",
        test: { framework: "Continuum Luau specs", path: "ServerScriptService.Tests", filter: "" },
      },
      unity: {
        prompt:
          "Fix this Play Mode error in the Unity project: {input}\n\nEnter Play Mode and read the console through the bridge to reproduce it, find the cause, fix it, and add a test (Edit Mode where possible, Play Mode otherwise) that fails without the fix. Check there are no compiler errors.",
        test: { framework: "Unity Test Framework", path: "Assets/Tests", filter: "" },
      },
      unreal: {
        prompt:
          "Fix this Play In Editor error in the Unreal project: {input}\n\nStart PIE and read the log through the bridge to reproduce it, find the cause, fix it (build C++ if needed and check for compile errors), and add an automation test that fails without the fix.",
        test: { framework: "Unreal Automation", path: "Source/<Project>/Tests", filter: "Project." },
      },
    },
  },
  {
    id: "save-system",
    title: "Create a basic save system",
    summary: "Save and load player progress with versioned data and a round-trip test.",
    input: null,
    engines: {
      roblox: {
        prompt:
          "Create a basic save system for this Roblox place: a ModuleScript `ServerScriptService.SaveService` that saves and loads a versioned player profile (coins, level, inventory) through DataStoreService with retries and a session lock, plus serialization functions that do not touch DataStores. Write `ServerScriptService.Tests.SaveService.spec` covering serialize → deserialize round trips, defaults for missing fields, and migrating version 1 data. Note in your report that live DataStores need Studio API access enabled.",
        test: { framework: "Continuum Luau specs", path: "ServerScriptService.Tests.SaveService.spec", filter: "SaveService" },
      },
      unity: {
        prompt:
          "Create a basic save system for this Unity project: a versioned `SaveData` class (coins, level, inventory), a `SaveSystem` that writes JSON to `Application.persistentDataPath` atomically and loads it with defaults and migration from version 1. Add Edit Mode tests covering a round trip through a temporary folder, missing fields, and version migration.",
        test: { framework: "Unity Test Framework (Edit Mode)", path: "Assets/Tests/EditMode/SaveSystemTests.cs", filter: "SaveSystemTests" },
      },
      unreal: {
        prompt:
          "Create a basic save system for this Unreal project: a `USaveGame` subclass with a version field (coins, level, inventory) and a subsystem that saves and loads a slot asynchronously, with defaults and migration from version 1. Add an automation test `Project.SaveSystem` covering a round trip and migration.",
        test: { framework: "Unreal Automation", path: "Source/<Project>/Tests/SaveSystemTest.cpp", filter: "Project.SaveSystem" },
      },
    },
  },
];

export function recipePrompt(recipe: GameRecipe, engine: GameEngineId, input: string): string {
  const variant = recipe.engines[engine];
  const body = variant.prompt.replace("{input}", input.trim() === "" ? "(no error text given; find it in the latest playtest logs)" : input.trim());
  return `${body}\n\nTest to run: ${variant.test.framework}${variant.test.filter ? ` (filter \`${variant.test.filter}\`)` : ""} at \`${variant.test.path}\`.\n${COMMON_CLOSE}`;
}
