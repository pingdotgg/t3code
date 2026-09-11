import { makeRemoteBinding } from "../remote-bindings/RemoteBindings.ts";

export interface RemoteVpcNetworkProps {
  readonly binding: string;
  readonly tunnelId?: string;
  readonly networkId?: string;
}

export const remote = (props: RemoteVpcNetworkProps) =>
  makeRemoteBinding(
    {
      name: props.binding,
      type: "vpc_network",
      tunnelId: props.tunnelId,
      networkId: props.networkId,
    },
    (service) => ({
      name: props.binding,
      service,
    }),
  );
