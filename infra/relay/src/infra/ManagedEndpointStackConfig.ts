export const MANAGED_ENDPOINT_ZONE = {
  zoneId: "fcea40a6915723b0f5c4a9480eb3507b",
  baseSubdomain: "tunnels",
} as const;

const relayPublicSubdomain = "t3code-relay";

export const RELAY_PUBLIC_SUBDOMAIN = relayPublicSubdomain;

export const relayPublicDomain = (zone: { readonly name: string }) =>
  `${relayPublicSubdomain}.${zone.name}`;

export const relayPublicOrigin = (zone: { readonly name: string }) =>
  `https://${relayPublicDomain(zone)}`;

export const managedEndpointBaseDomain = (zone: {
  readonly name: string;
  readonly baseSubdomain?: string;
}) => zone.name;

export function managedEndpointProvisionerTokenPolicies(input: {
  readonly accountId: string;
  readonly zoneId: string;
}) {
  return [
    {
      effect: "allow" as const,
      permissionGroups: ["Cloudflare Tunnel Read" as const, "Cloudflare Tunnel Write" as const],
      resources: {
        [`com.cloudflare.api.account.${input.accountId}`]: "*",
      },
    },
    {
      effect: "allow" as const,
      permissionGroups: ["DNS Read" as const, "DNS Write" as const],
      resources: {
        [`com.cloudflare.api.account.zone.${input.zoneId}`]: "*",
      },
    },
  ];
}

export function relayWorkerDomainDnsTokenPolicies(input: { readonly zoneId: string }) {
  return [
    {
      effect: "allow" as const,
      permissionGroups: [
        "DNS Read" as const,
        "DNS Write" as const,
        "Workers Routes Read" as const,
        "Workers Routes Write" as const,
      ],
      resources: {
        [`com.cloudflare.api.account.zone.${input.zoneId}`]: "*",
      },
    },
  ];
}
