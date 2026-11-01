export default {
  fetch(
    request: Request,
    env: { WEBSITE: { fetch(request: Request): Promise<Response> } },
  ) {
    return env.WEBSITE.fetch(request);
  },
};
