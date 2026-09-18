/**
 * Front-door worker for the single-origin deployment: the SPA, the API,
 * the auth routes, and the git wire protocol all live on ONE host. API and
 * wire requests are forwarded to the GitHost over a private service
 * binding; everything else is served from the Vite static assets.
 *
 * One origin matters beyond aesthetics: the session cookie Better Auth
 * sets is first-party for the SPA, clone URLs shown in the UI are
 * same-host, and nothing needs CORS.
 */

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  /** Service binding to the GitHost (REST, auth, and wire planes). */
  GIT: Fetcher;
  /** The Vite-built static assets. */
  ASSETS: Fetcher;
}

/** `/api/v1/**` (REST), `/api/v3/**` (GitHub facade), `/api/auth/**` (Better Auth). */
const API_PREFIX = /^\/api\//;

/**
 * The git smart-HTTP wire endpoints: `/:owner/:repo[.git]/info/refs`,
 * `git-upload-pack`, `git-receive-pack`.
 */
const WIRE_PATH =
  /^\/[^/]+\/[^/]+\/(?:info\/refs$|git-upload-pack$|git-receive-pack$)/;

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (API_PREFIX.test(pathname) || WIRE_PATH.test(pathname)) {
      // Forwarded verbatim: the Host header stays this origin, so the
      // GitHost derives same-host clone/remote URLs and Better Auth scopes
      // its cookie to it, and push bodies stream through the binding
      // untouched.
      return env.GIT.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
