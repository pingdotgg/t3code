import Module from "node:module";

// The harness runs vite in-process inside the playwright worker.
// `@tailwindcss/node`'s ESM build registers an async module-customization
// loader (`esm-cache.loader.mjs`) at import time; on node >= 24 that loader
// combined with playwright's own sync transform hooks makes subsequent
// `require()` calls from ESM-imported CJS modules fail with `Expected a
// string ... for the "source" from the "load" hook but got undefined/null`,
// killing every in-process vite build/dev server. Tailwind skips the
// registration under bun (it is purely a config-import cache), so dropping
// it is safe. Imported for its side effect from Playwright.ts so every
// playwright worker process is guarded before vite loads tailwind.
let installed = false;

export const installTailwindNodeCompat = (): void => {
  if (installed) return;
  installed = true;
  const originalRegister = Module.register.bind(Module);
  Module.register = ((specifier: unknown, ...rest: Array<never>) => {
    if (String(specifier).includes("esm-cache")) return;
    return (originalRegister as (...args: Array<unknown>) => unknown)(
      specifier,
      ...rest,
    );
  }) as typeof Module.register;
  // Propagate the patched `register` into the `node:module` ESM namespace —
  // tailwind calls it through an ESM named-import binding, which snapshots
  // builtin exports at namespace creation.
  Module.syncBuiltinESMExports();
};
