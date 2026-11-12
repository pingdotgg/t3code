interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

/**
 * The app's Worker: the client build, plus `/api` forwarded to the bank over
 * a service binding. One origin for both, so the session cookie is
 * first-party and reaches every call and every live read's WebSocket.
 */
export default {
  fetch(request: Request, env: { readonly ASSETS: Fetcher; readonly BANK: Fetcher }) {
    const { pathname } = new URL(request.url);
    return pathname.startsWith("/api") ? env.BANK.fetch(request) : env.ASSETS.fetch(request);
  },
};
