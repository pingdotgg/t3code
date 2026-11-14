interface Env {
  ASSETS: Fetcher;
}

export default {
  fetch: (request: Request, env: Env) => env.ASSETS.fetch(request),
};
