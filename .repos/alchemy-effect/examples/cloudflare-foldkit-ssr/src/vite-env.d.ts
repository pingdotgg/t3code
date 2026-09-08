/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * The deployment this bundle belongs to, compiled in by
   * `@foldkit/vite-plugin` from its `buildId` option or the
   * `FOLDKIT_BUILD_ID` environment variable. Not optional: both entries
   * require one, and `vite.config.ts` is what guarantees a build always has
   * it.
   */
  readonly FOLDKIT_BUILD_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
