import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/**
 * An "isolated project": a throwaway consumer project OUTSIDE the repository
 * tree, laid out the way bun's isolated linker (or pnpm) lays out a real
 * consumer — `alchemy` present in the project's `node_modules` (a symlink to
 * this package), and NONE of alchemy's own dependencies hoisted beside it —
 * whose `main.ts` re-exports a test fixture by absolute path.
 *
 * Every `main`-bundled platform (ECS, App Runner, Batch, EC2, Lambda,
 * Cloudflare Containers, Docker, Fly, Hetzner, Prisma, MicroVM, …) wraps the
 * user's program in a generated entry — a *virtual* rolldown module. A
 * virtual module has no directory, so rolldown resolves its bare imports
 * from the build `cwd`, i.e. the nearest `package.json` above `main`. Inside
 * this monorepo that is `packages/alchemy`, from which everything resolves —
 * so a fixture checked in next to its test can never reproduce the
 * consumer-side failure: when the generated entry imported alchemy's own
 * dependencies (`@distilled.cloud/*`, `@effect/platform-*`) directly, an
 * isolated install left them `[UNRESOLVED_IMPORT]`, external, and the
 * deployed process died at boot with `Cannot find module`. The entry is now
 * a shim importing only `alchemy/Runtime/Bootstrap/<Platform>` (resolvable
 * from any consumer) plus `main`; this harness pins that contract.
 *
 * Pointing a fixture's `main` at {@link IsolatedProject.main} makes the bundle
 * `cwd` this project. The fixture itself (and the user code it represents)
 * is reached through the absolute-path re-export, so its imports still
 * resolve from the repo as usual — only the generated entry's own imports
 * are exercised, exactly as for a real consumer.
 *
 * The location is deterministic (no nonce) and computed at module scope
 * because `main` is a prop of the fixture's declaration: it has to be known
 * when the fixture module is evaluated, at test collection, before any hook
 * runs. A plain `/tmp` prefix (not `os.tmpdir()`) keeps fixture modules free
 * of Node builtins — Worker/Durable Object bundles import the container
 * fixture for its class and run on workerd.
 */
export interface IsolatedProject {
  /** Unique project name; also the directory name under the shared root. */
  readonly name: string;
  /** Project directory (outside the repository). */
  readonly dir: string;
  /** The `main` to hand to the platform resource. */
  readonly main: string;
  /** Absolute path of the fixture module `main.ts` re-exports. */
  readonly fixture: string;
}

const ROOT = "/tmp/alchemy-test-isolated-projects";

/** `packages/alchemy` — this helper lives at `packages/alchemy/test/`. */
const ALCHEMY_PACKAGE_DIR = new URL("..", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

/**
 * Declare an isolated project for `fixture` (pass `import.meta.filename`).
 * Pure: nothing is written until {@link materializeIsolatedProject}.
 */
export const isolatedProject = (
  name: string,
  fixture: string,
): IsolatedProject => {
  const dir = `${ROOT}/${name}`;
  return { name, dir, main: `${dir}/main.ts`, fixture };
};

/**
 * Write the project to disk: a `package.json` (so the bundle `cwd` stops
 * here), `node_modules/alchemy` linked to this package (the consumer's one
 * direct dependency, as an isolated install lays it out — alchemy's own
 * dependencies are deliberately NOT reachable from here), and a `main.ts`
 * re-exporting the fixture's default export. Idempotent — safe to call at
 * the top of every test that deploys it.
 */
export const materializeIsolatedProject = (project: IsolatedProject) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${project.dir}/node_modules`, {
      recursive: true,
    });
    const alchemyLink = `${project.dir}/node_modules/alchemy`;
    yield* fs.remove(alchemyLink, { recursive: true }).pipe(Effect.ignore);
    yield* fs.symlink(ALCHEMY_PACKAGE_DIR, alchemyLink);
    yield* fs.writeFileString(
      `${project.dir}/package.json`,
      JSON.stringify({
        name: `alchemy-test-isolated-${project.name}`,
        private: true,
        type: "module",
      }),
    );
    yield* fs.writeFileString(
      project.main,
      `export { default } from ${JSON.stringify(project.fixture)};\n`,
    );
  });

/** Remove the project directory (ignores a missing directory). */
export const removeIsolatedProject = (project: IsolatedProject) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.remove(project.dir, { recursive: true })),
    Effect.ignore,
  );
