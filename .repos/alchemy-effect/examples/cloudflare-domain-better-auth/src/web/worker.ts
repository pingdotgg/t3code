interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

/**
 * The app's Worker: the foldkit build, plus `/api` (better-auth's routes and
 * the NotesApi) forwarded to the Notes Worker. One origin for both, so the
 * session cookie is first-party and reaches every call and watch.
 */
export default {
  fetch(request: Request, env: { readonly ASSETS: Fetcher; readonly NOTES: Fetcher }) {
    const { pathname } = new URL(request.url);
    return pathname.startsWith("/api") ? env.NOTES.fetch(request) : env.ASSETS.fetch(request);
  },
};
