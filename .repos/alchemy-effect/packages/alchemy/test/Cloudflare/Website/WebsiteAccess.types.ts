/**
 * Type-level pin: the `access` prop is part of the shared Worker props and
 * must stay accepted by every `Cloudflare.Website.*` framework — a future
 * addition to a framework's `Omit<WorkerProps, ...>` list must not silently
 * drop it. Compile-only; never executed.
 */
import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";

const App = Cloudflare.Access.Application("TypesApp", {
  type: "self_hosted",
  policies: [{ decision: "allow", include: [{ emailDomain: "example.com" }] }],
});

// The shared-application form is the application itself — props are
// Input-wrapped, so the declaration Effect is accepted directly.
const access = App;

const dedicated = {
  policies: [
    { decision: "allow" as const, include: [{ emailDomain: "example.com" }] },
  ],
};

export const websites = Effect.gen(function* () {
  yield* Cloudflare.Website.Astro("AstroSite", { access });
  yield* Cloudflare.Website.Vite("ViteSite", { access: dedicated });
  yield* Cloudflare.Website.Nextjs("NextSite", { access });
  yield* Cloudflare.Website.Nuxt("NuxtSite", { access });
  yield* Cloudflare.Website.SvelteKit("SvelteSite", { access });
  yield* Cloudflare.Website.Waku("WakuSite", { access });
  yield* Cloudflare.Website.Octane("OctaneSite", { access });
  yield* Cloudflare.Website.Foldkit("FoldkitSite", { access });
  yield* Cloudflare.Website.StaticSite("StaticSite", {
    command: "bun run build",
    outdir: "dist",
    access,
  });
});
