import * as Cloudflare from "@/Cloudflare/index.ts";

/**
 * Shared Artifacts namespace bound by both the effect-style and async-style
 * test workers. `Cloudflare.Artifacts.Namespace(...)` returns an Effect resolving to the
 * namespace marker (`{ kind, name, namespace }`); both workers bind this same
 * namespace so they operate over one shared repo namespace.
 *
 * Namespace name is deterministic and constant (lowercase, 3–63 chars) per the
 * test conventions — never `Date.now()`.
 */
export const Repos = Cloudflare.Artifacts.Namespace("ArtifactsBindingRepos", {
  namespace: "alchemy-artifacts-binding-test",
});
