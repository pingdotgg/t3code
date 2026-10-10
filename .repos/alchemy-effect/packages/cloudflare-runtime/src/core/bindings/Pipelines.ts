import { makeRemoteBinding } from "../remote-bindings/RemoteBindings.ts";

export const remote = (binding: string, pipeline: string) =>
  makeRemoteBinding(
    {
      name: binding,
      type: "pipelines",
      pipeline,
    },
    (service) => ({
      name: binding,
      service,
    }),
  );
