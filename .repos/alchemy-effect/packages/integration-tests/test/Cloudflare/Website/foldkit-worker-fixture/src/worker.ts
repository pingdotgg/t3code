type Env = {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  GREETING: string;
};

/**
 * The custom Worker entry a Foldkit deployment can carry alongside its
 * client build: it answers an API route from a binding and hands every
 * other request to the assets binding, where `notFoundHandling` still
 * applies — so deep links keep falling back to `index.html` and the
 * Foldkit router boots.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/hello") {
      return Response.json({ greeting: env.GREETING });
    }

    return env.ASSETS.fetch(request);
  },
};
