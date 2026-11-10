import { makeRemoteBinding } from "../remote-bindings/RemoteBindings.ts";

export const remote = (binding: string) =>
  makeRemoteBinding(
    {
      name: binding,
      type: "ai",
      raw: true,
    },
    (service) => ({
      name: binding,
      wrapped: {
        moduleName: "cloudflare-internal:ai-api",
        innerBindings: [
          {
            name: "fetcher",
            service,
          },
        ],
      },
    }),
  );
