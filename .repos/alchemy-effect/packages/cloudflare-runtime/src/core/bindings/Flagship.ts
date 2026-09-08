import { makeRemoteBinding } from "../remote-bindings/RemoteBindings.ts";

export const remote = (binding: string, appId: string) =>
  makeRemoteBinding(
    {
      name: binding,
      type: "flagship",
      appId,
    },
    (service) => ({
      name: binding,
      service,
    }),
  );
