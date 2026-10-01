import { makeRemoteBinding } from "../remote-bindings/RemoteBindings.ts";

export const remote = (binding: string, instanceName: string) =>
  makeRemoteBinding(
    {
      name: binding,
      type: "ai_search",
      instanceName,
    },
    (service) => ({
      name: binding,
      service,
    }),
  );

export const remoteNamespace = (binding: string, namespace: string) =>
  makeRemoteBinding(
    {
      name: binding,
      type: "ai_search_namespace",
      namespace,
    },
    (service) => ({
      name: binding,
      service,
    }),
  );
