// Atlas-added Vite env vars. Ambient (no imports/exports) so it merges with
// vite/client's ImportMetaEnv via declaration merging. Keeps `vp run typecheck`
// green without editing the upstream vite-env.d.ts.
interface ImportMetaEnv {
  /** Browser-facing base URL of Vector's FastAPI (see @atlas/backend). */
  readonly VITE_ATLAS_API_URL?: string;
  /** App display-name override (e.g. "Atlas Vector"); baked at web build time. */
  readonly VITE_ATLAS_APP_NAME?: string;
  /** "1" enables auto-pairing (skips the T3 /pair screen) for local dev. */
  readonly VITE_ATLAS_AUTOPAIR?: string;
}
