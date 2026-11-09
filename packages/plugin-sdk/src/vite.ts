// @effect-diagnostics nodeBuiltinImport:off
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import { HOST_ATOM_EXPORTS, HOST_ATOM_REACT_EXPORTS, HOST_UI_EXPORTS } from "./web.ts";

const HOST_PREFIX = "\0t3-plugin-host:";

const HOST_MODULES: Readonly<Record<string, string>> = {
  react: "react",
  "react-dom": "reactDom",
  "react/jsx-runtime": "jsxRuntime",
  "@t3tools/plugin-sdk/atom": "atom",
  "@t3tools/plugin-sdk/atom-react": "atomReact",
  "@t3tools/plugin-sdk/ui": "ui",
};

const FIXED_EXPORTS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "@t3tools/plugin-sdk/atom": HOST_ATOM_EXPORTS,
  "@t3tools/plugin-sdk/atom-react": HOST_ATOM_REACT_EXPORTS,
  "@t3tools/plugin-sdk/ui": HOST_UI_EXPORTS,
};

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

// React's export list depends on its version, so it is read from the plugin's own install.
const installedExports = (root: string, specifier: string) => {
  try {
    return Object.keys(NodeModule.createRequire(NodePath.join(root, "package.json"))(specifier));
  } catch (cause) {
    throw new Error(
      `The plugin imports ${specifier}, which isn't installed in ${root}. Install react and react-dom as dev dependencies: the bundle uses T3's own copies at runtime, but the build reads their export lists.`,
      { cause },
    );
  }
};

export interface T3PluginWebOptions {
  /** The web entry, relative to the Vite root. Defaults to `web.tsx`. */
  readonly entry?: string;
  /** Where `web.js` is written, relative to the Vite root. Defaults to `dist`. */
  readonly outDir?: string;
}

/**
 * Builds a plugin's web half as the single-file ESM bundle T3 loads. React, react-dom, the JSX
 * runtime and the SDK's `atom`, `atom-react` and `ui` modules become reads from
 * `globalThis.__t3PluginHost`, so the bundle uses T3's copies instead of shipping its own.
 * Point the manifest's `web` at `<outDir>/web.js`.
 */
export function t3PluginWeb(options: T3PluginWebOptions = {}) {
  let root = NodePath.resolve();
  return {
    name: "t3-plugin-web",
    enforce: "pre" as const,
    config: () => ({
      // The host shares only the production JSX runtime, so development builds must not use jsxDEV.
      oxc: { jsx: { runtime: "automatic" as const, importSource: "react", development: false } },
      build: {
        lib: {
          entry: options.entry ?? "web.tsx",
          formats: ["es" as const],
          fileName: () => "web.js",
          // Named so the stylesheet check below explains itself, not Vite's package.json error.
          cssFileName: "web",
        },
        outDir: options.outDir ?? "dist",
        // T3 loads only `web.js`, so `import()` and `React.lazy` modules must stay inside it.
        rolldownOptions: { output: { codeSplitting: false } },
      },
    }),
    configResolved: (config: { readonly root: string }) => {
      root = config.root;
    },
    // T3 loads only `web.js`, so a stylesheet Vite writes beside it would never apply. Runs last,
    // after Vite's own CSS step has added it.
    generateBundle: {
      order: "post" as const,
      handler(
        this: { readonly error: (message: string) => never },
        _options: unknown,
        bundle: Readonly<Record<string, { readonly fileName: string }>>,
      ) {
        const stylesheet = Object.values(bundle).find((output) => output.fileName.endsWith(".css"));
        if (stylesheet === undefined) return;
        this.error(
          `The build wrote ${stylesheet.fileName}, which T3 never loads. Import the CSS with \`?inline\`, as in \`import css from "./web.css?inline"\`, and pass it to \`api.injectStyles(css)\` in \`activate\`.`,
        );
      },
    },
    resolveId: (source: string) => (source in HOST_MODULES ? HOST_PREFIX + source : undefined),
    load: (id: string) => {
      if (!id.startsWith(HOST_PREFIX)) return undefined;
      const specifier = id.slice(HOST_PREFIX.length);
      const names = FIXED_EXPORTS[specifier] ?? installedExports(root, specifier);
      const exported = names.filter((name) => name !== "default" && IDENTIFIER.test(name));
      // Pure reads let the bundler drop every export the plugin does not use.
      return [
        `const host = globalThis.__t3PluginHost.${HOST_MODULES[specifier]};`,
        "const read = (name) => host[name];",
        "export default host;",
        ...exported.map(
          (name) => `export const ${name} = /* @__PURE__ */ read(${JSON.stringify(name)});`,
        ),
      ].join("\n");
    },
  };
}
