import { managedCapabilityDenial, type ServerConfig } from "@t3tools/contracts";

export function canShareWithGuest(
  permitted: boolean,
  config:
    | {
        readonly settings: Pick<ServerConfig["settings"], "guestSharingEnabled">;
        readonly managedPolicy?: ServerConfig["managedPolicy"];
      }
    | undefined,
) {
  return (
    permitted &&
    config?.settings.guestSharingEnabled === true &&
    managedCapabilityDenial(config.managedPolicy, "connect") === undefined
  );
}
