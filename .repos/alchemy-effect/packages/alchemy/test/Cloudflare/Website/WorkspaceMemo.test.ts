import {
  Artifacts,
  createArtifactStore,
  makeScopedArtifacts,
} from "@/Artifacts.ts";
import {
  makeSourceContext,
  type SourceHash,
  type SourceServices,
} from "@/Cloudflare/Workers/Source.ts";
import {
  hashViteInput,
  makeViteSource,
} from "@/Cloudflare/Workers/Sources/Vite.ts";
import type { WorkerProps } from "@/Cloudflare/Workers/Worker.ts";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";

// ─────────────────────────────────────────────────────────────────────
// Workspace-aware input-hash memoization (no cloud, no build)
//
// The `fixtures/monorepo-workspace` fixture mirrors ct's
// `fixtures/monorepo-workspace`: `app/` is the Vite root and `lib/` is a
// sibling directory (its own package.json, NOT a package-manager
// workspace member) that `app/src` imports by relative path. At build
// time the toolchain discovers `lib/` from the module graph and reports
// it as an external workspace; alchemy persists it (relative to the
// root) in `hash.additionalWorkspaces` and folds it into `hash.input` —
// the rebuild-deciding memo signal.
//
// These tests pin the memo machinery itself — `hashViteInput` and the
// vite source's `hash()` slots — without deploying or building:
// cross-workspace-boundary edits MUST bust the memo, while untouched
// recomputes stay memoized. The live deploy-level behavior is covered by
// "Vite: edits in a sibling workspace package bust the build memo" in
// Vite.test.ts.
// ─────────────────────────────────────────────────────────────────────

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "fixtures/monorepo-workspace",
);

// Explicit include globs, same discipline as the live Vite tests: the
// hash stays pinned to fixture sources. The lib workspace is hashed with
// the default (whole-directory) scope, exactly like auto-discovered
// workspaces in production.
const memoInclude = ["src/**", "vite.config.ts", "package.json"];

const provide = <A, E>(effect: Effect.Effect<A, E, SourceServices>) =>
  effect.pipe(
    Effect.provideService(
      Artifacts,
      makeScopedArtifacts(createArtifactStore(), "test"),
    ),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
  );

/** Clone the two-directory fixture into a temp dir (outside the repo, so
 * no ancestor gitignore/lockfile leaks into the hash) and return paths. */
const setup = Effect.gen(function* () {
  const path = yield* Path.Path;
  const dir = yield* cloneFixture(fixtureDir, {
    prefix: "alchemy-ws-memo-",
    entries: ["app", "lib"],
  });
  return {
    dir,
    appDir: path.join(dir, "app"),
    libGreeting: path.join(dir, "lib", "src", "greeting.ts"),
    appServer: path.join(dir, "app", "src", "server.ts"),
  };
});

const editLib = (libGreeting: string, marker: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      libGreeting,
      `export const LIB_VERSION = "1.0.0";\n\nexport const greeting = (name: string): string =>\n  ${JSON.stringify(marker)} + name;\n`,
    );
  });

describe("workspace-aware input-hash memo", () => {
  it.effect(
    "cross-workspace edits bust the memo; untouched recomputes stay memoized",
    () =>
      provide(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { appDir, libGreeting, appServer } = yield* setup;
          const original = yield* fs.readFileString(libGreeting);

          // `additionalWorkspaces` is persisted relative to the Vite root
          // (see the live test's "../shared") — feed it back the same way
          // the WorkerProvider does from `output.hash.additionalWorkspaces`.
          const hash = () =>
            hashViteInput(
              appDir,
              { include: memoInclude },
              Effect.succeed(["../lib"]),
            );

          const h1 = yield* hash();
          expect(h1.hash).toBeDefined();
          expect(h1.workspaces).toEqual(["../lib"]);

          // Untouched recompute ⇒ identical hash ⇒ the deploy memo holds.
          const h2 = yield* hash();
          expect(h2.hash).toEqual(h1.hash);

          // Edit ONLY the sibling workspace — nothing under the Vite root
          // changes — and the input hash must still bust.
          yield* editLib(libGreeting, "ws-memo-edit-1");
          const h3 = yield* hash();
          expect(h3.hash).not.toEqual(h1.hash);

          // The hash is content-derived: restoring the original bytes
          // restores the original hash (machine/path independence).
          yield* fs.writeFileString(libGreeting, original);
          const h4 = yield* hash();
          expect(h4.hash).toEqual(h1.hash);

          // Build↔diff parity: at build time workspaces are discovered as
          // ABSOLUTE paths from the module graph; at diff time the
          // persisted ROOT-RELATIVE spelling is fed back. Both spellings
          // of the same directory must hash identically or the
          // rebuild-free diff could never report "unchanged".
          const path = yield* Path.Path;
          const absolute = yield* hashViteInput(
            appDir,
            { include: memoInclude },
            Effect.succeed([path.resolve(appDir, "../lib")]),
          );
          expect(absolute.hash).toEqual(h1.hash);
          expect(absolute.workspaces).toEqual(["../lib"]);

          // Root edits keep busting the memo too, independently of the
          // workspace slot.
          const server = yield* fs.readFileString(appServer);
          yield* fs.writeFileString(
            appServer,
            server.replace("/api/greeting", "/api/greeting-v2"),
          );
          const h5 = yield* hash();
          expect(h5.hash).not.toEqual(h1.hash);
        }),
      ),
  );

  it.effect(
    "without the workspace in the hash set, cross-boundary edits are invisible (control)",
    () =>
      provide(
        Effect.gen(function* () {
          const { appDir, libGreeting } = yield* setup;

          const hash = () =>
            hashViteInput(appDir, { include: memoInclude }, Effect.succeed([]));

          const before = yield* hash();
          yield* editLib(libGreeting, "ws-memo-control-edit");
          const after = yield* hash();

          // The control proves the signal in the test above comes from
          // folding `../lib` into the hash — not from anything under the
          // Vite root.
          expect(after.hash).toEqual(before.hash);
          expect(after.workspaces).toEqual([]);
        }),
      ),
  );

  it.effect(
    "an explicit memo.workspaces array pins the workspace set and still busts on edits",
    () =>
      provide(
        Effect.gen(function* () {
          const { appDir, libGreeting } = yield* setup;

          const hash = () =>
            hashViteInput(
              appDir,
              {
                include: memoInclude,
                workspaces: [{ cwd: "../lib" }],
              },
              // With an explicit workspace list the auto-discovered set is
              // ignored entirely.
              Effect.succeed(["../does-not-exist"]),
            );

          const before = yield* hash();
          // Pinned workspaces don't persist an auto-discovery list.
          expect(before.workspaces).toBeUndefined();

          yield* editLib(libGreeting, "ws-memo-pinned-edit");
          const after = yield* hash();
          expect(after.hash).not.toEqual(before.hash);
        }),
      ),
  );

  it.effect(
    "the vite source's hash() slots carry the persisted workspaces through diff",
    () =>
      provide(
        Effect.gen(function* () {
          const { appDir, libGreeting } = yield* setup;

          const vite = { rootDir: appDir, memo: { include: memoInclude } };
          const source = makeViteSource(vite);
          const props: WorkerProps = { vite };
          const ctx = makeSourceContext({
            id: "MonorepoApp",
            workerName: "stack-monorepoapp-test-abc123",
            props,
            compatibility: { date: "2024-09-23", flags: [] },
            stack: { name: "stack", stage: "test" },
          });

          // `previous` is `output.hash` from state: a prior build
          // discovered `../lib` from the module graph and persisted it.
          const previous: SourceHash = {
            bundle: undefined,
            assets: undefined,
            input: undefined,
            additionalWorkspaces: ["../lib"],
          };

          const slots1 = yield* source.hash(ctx, previous);
          expect(slots1.input).toBeDefined();
          expect(slots1.additionalWorkspaces).toEqual(["../lib"]);

          // Same recipe as calling the machinery directly.
          const direct = yield* hashViteInput(
            appDir,
            vite.memo,
            Effect.succeed(["../lib"]),
          );
          expect(slots1.input).toEqual(direct.hash);

          // A cross-boundary edit changes the recomputed input slot — the
          // WorkerProvider's `slots.input !== output.hash.input` diff then
          // reports the update that triggers the rebuild.
          yield* editLib(libGreeting, "ws-memo-source-edit");
          const slots2 = yield* source.hash(ctx, previous);
          expect(slots2.input).not.toEqual(slots1.input);

          // Without persisted workspaces (fresh state) the hash set is
          // just the root — documented by a differing input slot.
          const slotsNoWs = yield* source.hash(ctx, undefined);
          expect(slotsNoWs.additionalWorkspaces).toEqual([]);
          expect(slotsNoWs.input).not.toEqual(slots2.input);
        }),
      ),
  );
});
