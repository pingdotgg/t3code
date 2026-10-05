declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
  export const waitUntil: (promise: Promise<unknown>) => void;
}

/**
 * The import seam for wrapping waku's server handler from a custom worker
 * entry (`Website.Waku`'s `main` prop): resolved by the waku integration's
 * server-entry plugin to waku's emitted server handler, in dev and build
 * alike. Convention shared with React Router's
 * `virtual:react-router/server-build`.
 */
declare module "virtual:waku/server-entry" {
  const handler: {
    fetch(
      request: Request,
      env: unknown,
      ctx: unknown,
    ): Response | Promise<Response>;
  };
  export default handler;
}
