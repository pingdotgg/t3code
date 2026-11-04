import * as Cloudflare from "@alchemy.run/cloudflare";

/**
 * Shared Artifacts namespace bound by both the effect-style and async-style
 * test workers. `Cloudflare.Artifacts.Namespace(...)` returns an Effect resolving to the
 * namespace marker (`{ kind, name, namespace }`); both workers bind this same
 * namespace so they operate over one shared repo namespace.
 *
 * Namespace name is deterministic and constant per the test conventions —
 * never `Date.now()`. It uses mixed case, `.` and `_` so the deploy covers the
 * full documented naming rule.
 */
export const Repos = Cloudflare.Artifacts.Namespace("ArtifactsBindingRepos", {
  namespace: "Alchemy.Artifacts_Binding-Test",
});
