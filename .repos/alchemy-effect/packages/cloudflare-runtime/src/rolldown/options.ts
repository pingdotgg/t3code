export interface BasePluginOptions {
  /**
   * The main entry point to use.
   * Defaults to the one from your Rolldown configuration.
   * @default undefined
   */
  main?: string;
  /**
   * The compatibility date to use. This is optional, but should be defined to avoid unexpected behavior.
   * @default undefined
   */
  compatibilityDate?: string;
  /**
   * The compatibility flags to enable.
   * @default []
   * @example
   * ```ts
   * cloudflare({ compatibilityDate: "2026-04-01", compatibilityFlags: ["nodejs_compat"] });
   * ```
   */
  compatibilityFlags?: Array<string>;
  /**
   * The exports to include in the bundle.
   * By default, all exports are included. However, if you only want to include certain exports, you can use this option.
   * @example
   * ```ts
   * cloudflare({ exports: ["default"] });
   * ```
   */
  exports?: Array<string>;
  /**
   * Which Vite environment hosts the Worker, and any child environments it
   * loads at runtime. Defaults to the single `ssr` environment.
   *
   * `@vitejs/plugin-rsc` apps run the Worker in the `rsc` environment (resolved
   * with the `react-server` condition) and load the `ssr` environment from it,
   * so they set `{ name: "rsc", childEnvironments: ["ssr"] }`. Every named
   * environment is given the Worker treatment (workerd resolve conditions,
   * dependency pre-bundling) and a module runner in dev.
   *
   * @default { entry: "ssr", children: [] }
   */
  viteEnvironments?: {
    entry?: string;
    children?: Array<string>;
  };
  /**
   * Vite environment names that must be left untouched by the Cloudflare
   * plugins. Frameworks can add Node-side server environments to the same dev
   * server or builder (e.g. Astro's `astro` and `prerender` environments), and
   * applying the Worker treatment (unenv polyfills, workerd resolve
   * conditions, dependency pre-bundling) to them breaks their Node runtime.
   *
   * The `client` environment is always excluded and does not need to be
   * listed here.
   *
   * @default []
   * @example
   * ```ts
   * cloudflare({ viteEnvironments: { entry: "ssr" }, skipEnvironments: ["astro", "prerender"] });
   * ```
   */
  skipEnvironments?: Array<string>;
}

/**
 * Whether the named Vite environment must be left untouched by the Cloudflare
 * plugins — the browser `client` environment, plus anything the user listed in
 * {@link BasePluginOptions.skipEnvironments}.
 */
export const isSkippedEnvironment = (
  options: BasePluginOptions,
  name: string,
): boolean =>
  name === "client" || (options.skipEnvironments?.includes(name) ?? false);

export const parseViteEnvironments = (
  options: BasePluginOptions,
): [string, ...Array<string>] => {
  const entry = options.viteEnvironments?.entry ?? "ssr";
  if (entry === "client") {
    throw new Error(
      'The "client" environment cannot be used as a worker environment because it is reserved for the browser.',
    );
  }
  const children = (options.viteEnvironments?.children ?? []).map(
    (name, index, self) => {
      if (name === "client") {
        throw new Error(
          'The "client" environment cannot be used as a worker environment because it is reserved for the browser.',
        );
      } else if (self.indexOf(name) !== index) {
        throw new Error(
          `The name "${name}" appears more than once in the Vite environment list. Worker environment names must be unique.`,
        );
      } else if (name === entry) {
        throw new Error(
          `The child environment "${name}" cannot have the same name as the entry environment "${entry}".`,
        );
      }
      return name;
    },
  );
  for (const name of options.skipEnvironments ?? []) {
    if (name === entry || children.includes(name)) {
      throw new Error(
        `The environment "${name}" cannot be both a worker environment and listed in "skipEnvironments".`,
      );
    }
  }
  return [entry, ...children];
};
