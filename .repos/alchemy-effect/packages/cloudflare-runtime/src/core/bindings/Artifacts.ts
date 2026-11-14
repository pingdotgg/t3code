import { makeRemoteBinding } from "../remote-bindings/RemoteBindings.ts";

export const remote = (binding: string, namespace: string) =>
  makeRemoteBinding({ name: binding, type: "artifacts", namespace }, (service) => ({
    name: binding,
    service,
  }));
