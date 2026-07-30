// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
import * as WorkspaceProtectedPaths from "./WorkspaceProtectedPaths.ts";

const homeDir = NodeOS.homedir();
const protectedDocumentsPath = NodePath.join(homeDir, "Documents", "notes.txt");

const withDarwinPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, HostProcessPlatform, "darwin");

describe("WorkspaceProtectedPaths", () => {
  it.effect("defaults to enabled when the settings service is unavailable", () =>
    withDarwinPlatform(
      Effect.gen(function* () {
        const guard = yield* WorkspaceProtectedPaths.makeProtectedPathsGuard;
        expect(yield* guard.isEnabled).toBe(true);
        expect(yield* guard.isPathBlocked(protectedDocumentsPath)).toBe(true);
      }),
    ),
  );

  it.effect("blocks protected paths while the safety setting is enabled", () =>
    withDarwinPlatform(
      Effect.gen(function* () {
        const guard = yield* WorkspaceProtectedPaths.makeProtectedPathsGuard;
        expect(yield* guard.isPathBlocked(protectedDocumentsPath)).toBe(true);
        expect(yield* guard.isPathBlocked(NodePath.join(homeDir, "code", "repo"))).toBe(false);
      }).pipe(
        Effect.provide(
          serverSettingsLayerTest({ safety: { protectedFilesystemPathsEnabled: true } }),
        ),
      ),
    ),
  );

  it.effect("does not block protected paths when the safety setting is disabled", () =>
    withDarwinPlatform(
      Effect.gen(function* () {
        const guard = yield* WorkspaceProtectedPaths.makeProtectedPathsGuard;
        expect(yield* guard.isEnabled).toBe(false);
        expect(yield* guard.isPathBlocked(protectedDocumentsPath)).toBe(false);
        // The raw platform check ignores the toggle.
        expect(guard.isPathProtected(protectedDocumentsPath)).toBe(true);
      }).pipe(
        Effect.provide(
          serverSettingsLayerTest({ safety: { protectedFilesystemPathsEnabled: false } }),
        ),
      ),
    ),
  );

  it.effect("detects protected descendants only under ancestors of protected paths", () =>
    withDarwinPlatform(
      Effect.gen(function* () {
        const guard = yield* WorkspaceProtectedPaths.makeProtectedPathsGuard;
        expect(guard.hasProtectedDescendants(homeDir)).toBe(true);
        expect(guard.hasProtectedDescendants(NodePath.join(homeDir, "code"))).toBe(false);
      }),
    ),
  );

  it.effect("hasBlockedDescendants honors the safety toggle", () =>
    withDarwinPlatform(
      Effect.gen(function* () {
        const guard = yield* WorkspaceProtectedPaths.makeProtectedPathsGuard;
        expect(yield* guard.hasBlockedDescendants(homeDir)).toBe(true);
        expect(yield* guard.hasBlockedDescendants(NodePath.join(homeDir, "code"))).toBe(false);
      }).pipe(
        Effect.provide(
          serverSettingsLayerTest({ safety: { protectedFilesystemPathsEnabled: true } }),
        ),
      ),
    ),
  );

  it.effect("hasBlockedDescendants is false when the safety setting is disabled", () =>
    withDarwinPlatform(
      Effect.gen(function* () {
        const guard = yield* WorkspaceProtectedPaths.makeProtectedPathsGuard;
        expect(yield* guard.hasBlockedDescendants(homeDir)).toBe(false);
        // The raw descendant check ignores the toggle.
        expect(guard.hasProtectedDescendants(homeDir)).toBe(true);
      }).pipe(
        Effect.provide(
          serverSettingsLayerTest({ safety: { protectedFilesystemPathsEnabled: false } }),
        ),
      ),
    ),
  );

  it.effect("exposes protected directory names only for the home directory", () =>
    withDarwinPlatform(
      Effect.gen(function* () {
        const guard = yield* WorkspaceProtectedPaths.makeProtectedPathsGuard;
        const resolvePath = (value: string) => NodePath.resolve(value);
        expect(guard.protectedDirectoryNames(homeDir, resolvePath).has("Documents")).toBe(true);
        expect(
          guard.protectedDirectoryNames(NodePath.join(homeDir, "code"), resolvePath).size,
        ).toBe(0);
      }),
    ),
  );
});
