import { makeRemoteBinding } from "../remote-bindings/RemoteBindings.ts";

export const remote = (binding: string, serviceId: string) =>
  makeRemoteBinding(
    {
      name: binding,
      type: "vpc_service",
      serviceId,
    },
    (service) => ({
      name: binding,
      service,
    }),
  );
