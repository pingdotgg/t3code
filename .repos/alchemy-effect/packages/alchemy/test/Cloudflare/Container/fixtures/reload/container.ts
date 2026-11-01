import * as Cloudflare from "@/Cloudflare";
import * as pathe from "pathe";

/**
 * The build context lives at a FIXED path under the suite's `.tmp` dir; the
 * test materializes a Dockerfile + content there before deploying and
 * rewrites the files live to drive hot reload. A fixed path (rather than a
 * per-run temp clone) keeps the declaration static while the CONTENT stays
 * fully test-controlled.
 */
export const RELOAD_CONTEXT_DIR = pathe.resolve(
  import.meta.dirname,
  "../../../../.tmp/container-reload-context",
);

/** Must match the port baked into the Dockerfile the test writes. */
export const RELOAD_CONTAINER_PORT = 17362;

/**
 * User-supplied Dockerfile + build-context container (no `main`, no inline
 * content): the variant whose files are invisible to `bun --watch`, so its
 * hot reload rides the local worker runner's context watcher.
 */
export class ReloadContainer extends Cloudflare.Container<ReloadContainer>()(
  "ReloadContainer",
  {
    context: RELOAD_CONTEXT_DIR,
    observability: { logs: { enabled: true } },
  },
) {}
