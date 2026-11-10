import * as NodeModule from "node:module";
import { createHooks, type LoaderOptions } from "./hooks.ts";
import { leaseSourceMapSupport } from "./source-map.ts";

export { createHooks, type LoaderHooks, type LoaderOptions } from "./hooks.ts";
export { importNamespaced, namespaced, type NamespaceOptions } from "./namespace.ts";

export interface OxcLoader {
  unregister(): void;
}

const registrationKey = Symbol.for("@alchemy.run/node-utils/register-oxc");

/**
 * Installs the Oxc TypeScript loader process-wide. Alchemy starts every
 * Node process with `--import` of a file that calls this; in-process
 * callers (the dev exec child, tests) may call it again and get the same
 * registration back — a second copy of the hooks would only re-run the
 * chain. The marker lives on `globalThis` because a checkout can load this
 * module twice (src/ and lib/).
 *
 * Reloading one import graph in place is `watchImport` (../watch), which
 * layers a namespace over the same hooks.
 */
export const registerOxc = (options: LoaderOptions = {}): OxcLoader => {
  const registrations = globalThis as typeof globalThis & { [registrationKey]?: OxcLoader };
  const existing = registrations[registrationKey];
  if (existing !== undefined) return existing;

  const releaseSourceMaps = leaseSourceMapSupport();
  const hooks = NodeModule.registerHooks(createHooks(options));

  const loader: OxcLoader = {
    unregister() {
      hooks.deregister();
      if (registrations[registrationKey] === loader) delete registrations[registrationKey];
      releaseSourceMaps();
    },
  };
  registrations[registrationKey] = loader;
  return loader;
};
