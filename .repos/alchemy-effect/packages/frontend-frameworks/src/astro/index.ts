import { layer } from "./Astro.ts";

export {
  layer,
  make,
  makeAstroInlineConfig,
  type AstroConfigInputs,
  type AstroFrameworkOptions,
} from "./Astro.ts";
export { NODE_ENVIRONMENTS } from "./environments.ts";
export {
  DEFAULT_TARGET_SPECIFIER,
  isAstroTarget,
  type AstroTarget,
  type AstroTargetInput,
} from "./Target.ts";

/**
 * The slice of the e2e harness's options this factory reads, structurally
 * (this package deliberately does not depend on the harness): the
 * target-scoped cloudflare carriage with the deprecated top-level `vite`
 * alias as fallback.
 */
interface HarnessOptions {
  readonly target?:
    | { readonly cloudflare?: { readonly worker?: unknown } | undefined }
    | undefined;
  readonly vite?: unknown;
}

/**
 * The e2e-harness framework factory contract: default-export a
 * `(options) => Layer<Framework>` factory. Reads the harness's cloudflare
 * worker configuration (`options.target?.cloudflare?.worker`, falling back to
 * the deprecated `options.vite` alias) and hands it — opaquely — to the
 * default Cloudflare target module as its config.
 */
const framework = (options?: HarnessOptions) =>
  layer({
    targetConfig: {
      worker: options?.target?.cloudflare?.worker ?? options?.vite,
    },
  });

export default framework;
