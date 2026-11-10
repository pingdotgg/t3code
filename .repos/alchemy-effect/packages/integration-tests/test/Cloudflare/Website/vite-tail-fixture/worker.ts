interface Env {
  ASSETS: Fetcher;
}

export default {
  fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname === "/api/log") {
      console.log("vite-tail-marker");
      return new Response("logged");
    }
    return env.ASSETS.fetch(request);
  },
};
