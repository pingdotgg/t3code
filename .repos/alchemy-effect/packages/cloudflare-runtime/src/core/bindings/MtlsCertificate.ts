import { makeRemoteBinding } from "../remote-bindings/RemoteBindings.ts";

export const remote = (binding: string, certificateId: string) =>
  makeRemoteBinding(
    {
      name: binding,
      type: "mtls_certificate",
      certificateId,
    },
    (service) => ({
      name: binding,
      service,
    }),
  );
