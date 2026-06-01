import * as Cloudflare from "alchemy/Cloudflare";

// This should be pulled from the Alchemy authenticated cloudflare account
export const CLOUDFLARE_ACCOUNT_ID = "1468bbd99811cdaccfbb707dc725421a";

// We should only need to specify one of these after Alchemy have a CloudflareZone resource: https://github.com/alchemy-run/alchemy-effect/pull/493
export const MANAGED_ENDPOINT_ZONE_ID = "fcea40a6915723b0f5c4a9480eb3507b";
export const MANAGED_ENDPOINT_ZONE_NAME = "ineededadomain.com";

export const RELAY_PUBLIC_DOMAIN = `t3code-relay.${MANAGED_ENDPOINT_ZONE_NAME}`;
export const RELAY_PUBLIC_ORIGIN = `https://${RELAY_PUBLIC_DOMAIN}`;

export const ManagedEndpointProvisionerToken = Cloudflare.AccountApiToken(
  "ManagedEndpointProvisionerToken",
  {
    name: "t3-code-relay-managed-endpoint-provisioner",
    policies: [
      {
        effect: "allow" as const,
        permissionGroups: ["Cloudflare Tunnel Read" as const, "Cloudflare Tunnel Write" as const],
        resources: {
          [`com.cloudflare.api.account.${CLOUDFLARE_ACCOUNT_ID}`]: "*",
        },
      },
      {
        effect: "allow" as const,
        permissionGroups: ["DNS Read" as const, "DNS Write" as const],
        resources: {
          [`com.cloudflare.api.account.zone.${MANAGED_ENDPOINT_ZONE_ID}`]: "*",
        },
      },
    ],
  },
);
