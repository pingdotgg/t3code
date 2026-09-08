export default {
  async fetch(request: Request) {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/node-env":
        return new Response(process.env.NODE_ENV ?? "undefined");
      case "/global-node-env":
        return new Response(global.process.env.NODE_ENV ?? "undefined");
      case "/globalthis-node-env":
        return new Response(globalThis.process.env.NODE_ENV ?? "undefined");
      case "/typeof-process":
        return new Response(typeof process);
      case "/user-agent":
        return new Response(navigator.userAgent);
      default:
        return new Response("ok");
    }
  },
};
