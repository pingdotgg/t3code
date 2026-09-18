/**
 * The git-service example: a git host embedded in the app's own API, plus
 * a GitHub-style web UI, on one origin.
 *
 * - `src/api/` — the backend, one file per piece: `auth.ts` (Better Auth
 *   and who a user is), `middleware.ts` (who may call what), `routes.ts`
 *   (the app's own routes), `api.ts` (the git routes plus ours behind the
 *   middleware), `git.ts` (the `alchemy/Git` block assembly), and
 *   `host.ts` (the `Cloudflare.Worker` that serves it).
 * - `src/ui/` — the Vite SPA, a plain-fetch client of the API.
 * - `src/worker.ts` — the website's Worker: forwards `/api/**` and the git
 *   wire paths to the GitHost over a service binding and serves the SPA for
 *   everything else, so clone URLs and the session cookie are same-host.
 *
 * ```sh
 * bun run deploy
 * ```
 *
 * Open the printed `webUrl`, sign up, mint an API key on the settings page,
 * and it is the password of your git remote:
 *
 * ```sh
 * git remote add origin "https://x:<key>@<host>/<you>/web.git"
 * git push origin main
 * ```
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import GitHost from "./src/api/host.ts";

export default Alchemy.Stack(
  "GitServiceExample",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const git = yield* GitHost;

    const web = yield* Cloudflare.Website.Vite("Web", {
      main: "src/worker.ts",
      assets: {
        notFoundHandling: "single-page-application",
        runWorkerFirst: true,
      },
      env: {
        GIT: GitHost,
      },
    });

    return { url: git.url.as<string>(), webUrl: web.url };
  }),
);
