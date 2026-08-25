import * as Cloudflare from "alchemy/Cloudflare";

/**
 * The Flagship app under test. Binding it (effect-style via
 * `FlagshipApp.bind(App)`, or declaratively via `env: { FLAGS: App }`)
 * registers the resource with the stack and wires the Worker's `flagship`
 * binding to the app's id.
 */
export const App = Cloudflare.Flagship.App("FlagshipTestApp", {
  name: "alchemy-test-flagship-binding",
});
