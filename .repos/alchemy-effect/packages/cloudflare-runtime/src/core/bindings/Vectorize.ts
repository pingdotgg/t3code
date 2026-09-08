import { makeRemoteBinding } from "../remote-bindings/RemoteBindings.ts";

export const remote = (binding: string, indexName: string) =>
  makeRemoteBinding(
    {
      name: binding,
      type: "vectorize",
      indexName,
      raw: true,
    },
    (service) => ({
      name: binding,
      wrapped: {
        moduleName: "cloudflare-internal:vectorize-api",
        innerBindings: [
          {
            name: "fetcher",
            service,
          },
          {
            name: "indexId",
            text: indexName,
          },
          {
            name: "indexVersion",
            text: "v2",
          },
          {
            name: "useNdJson",
            json: "true",
          },
        ],
      },
    }),
  );
