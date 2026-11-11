interface Env {
  ASSETS: Fetcher;
}

let scheduledCount = 0;

export default {
  fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname === "/api/scheduled") {
      return Response.json({ scheduledCount });
    }
    return env.ASSETS.fetch(request);
  },
  scheduled() {
    scheduledCount += 1;
  },
};
