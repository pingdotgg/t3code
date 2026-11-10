// A Worker that imports no assets, for the cases that deploy without `ASSETS`.
export default {
  fetch: (_request: Request, env: { ASSETS?: Fetcher }) =>
    Response.json({ assets: env.ASSETS !== undefined }),
};
