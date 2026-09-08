interface Env {
  proxyClient: Fetcher;
}

export default function makeBinding(env: Env): DispatchNamespace {
  return {
    get(
      name: string,
      args?: { [key: string]: unknown },
      options?: DynamicDispatchOptions,
    ): Fetcher {
      const metadata = JSON.stringify({ name, args, options });
      return {
        fetch(input: RequestInfo | URL, init?: RequestInit) {
          const request = new Request(input, init);
          const headers = new Headers(request.headers);
          headers.set("MF-Dispatch-Namespace-Options", metadata);
          return env.proxyClient.fetch(new Request(request, { headers }));
        },
        connect() {
          throw new Error("DispatchNamespace.get().connect() is not supported");
        },
      } as Fetcher;
    },
  } satisfies DispatchNamespace;
}
