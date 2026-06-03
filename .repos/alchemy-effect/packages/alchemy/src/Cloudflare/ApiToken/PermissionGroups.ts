/**
 * Static catalog of Cloudflare API token permission groups, copied from the
 * upstream `alchemy` repo so we can offer typed permission-group names without
 * a network round-trip on every token create/update.
 *
 * @see https://developers.cloudflare.com/fundamentals/api/reference/permissions/
 */

export interface PermissionGroup {
  id: string;
  name: string;
  description: string;
  scopes: readonly string[];
}

export const PERMISSION_GROUPS = [
  {
    id: "19637fbb73d242c0a92845d8db0b95b1",
    name: "AI Audit Read",
    description: "Grants access to reading AI Audit",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "1ba6ab4cacdb454b913bbb93e1b8cb8c",
    name: "AI Audit Write",
    description: "Grants access to reading and editing AI Audit",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "4dc8917b4b40457d88d3035d5dadb054",
    name: "AI Gateway Read",
    description: "Grants access to reading AI Gateways",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "9e9b428a0bcd46fd80e580b46a69963c",
    name: "AI Search Index Engine",
    description: "Grants access to run AI Search Index Engine",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "644535f4ed854494a59cb289d634b257",
    name: "AI Gateway Run",
    description: "Grants access to run AI Gateways",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "6c8a3737f07f46369c1ea1f22138daaf",
    name: "AI Gateway Write",
    description: "Grants access to reading and editing AI Gateways",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "eb258a38ea634c86a0c89da6b27cb6b6",
    name: "Access: Apps and Policies Read",
    description: "Grants read access to Cloudflare Access zone resources",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "7ea222f6d5064cfa89ea366d7c1fee89",
    name: "Access: Apps and Policies Read",
    description:
      "Grants read access to Cloudflare Access applications and policies",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "6db4e222e21248ac96a3f4c2a81e3b41",
    name: "Access: Apps and Policies Revoke",
    description:
      "Grants ability to revoke all tokens to Cloudflare Access zone resources",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "6c9d1cfcfc6840a987d1b5bfb880a841",
    name: "Access: Apps and Policies Revoke",
    description:
      "Grants ability to revoke Cloudflare Access application tokens",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "959972745952452f8be2452be8cbb9f2",
    name: "Access: Apps and Policies Write",
    description: "Grants write access to Cloudflare Access zone resources",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "1e13c5124ca64b72b1969a67e8829049",
    name: "Access: Apps and Policies Write",
    description:
      "Grants write access to Cloudflare Access applications and policies",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "b05b28e839c54467a7d6cba5d3abb5a3",
    name: "Access: Audit Logs Read",
    description: "Grants read access to Cloudflare Access audit logs",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "08e61dabe81a422dab0dea6fdef1a98a",
    name: "Access: Custom Pages Read",
    description: "Grants read access to Cloudflare Access Custom Pages",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "4e5fd8ac327b4a358e48c66fcbeb856d",
    name: "Access: Custom Pages Write",
    description: "Grants write access to Cloudflare Access Custom Pages",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "0f4841f80adb4bada5a09493300e7f8d",
    name: "Access: Device Posture Read",
    description: "Grants read access to Cloudflare Access Device Posture",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "2fc1072ee6b743828db668fcb3f9dee7",
    name: "Access: Device Posture Write",
    description: "Grants write access to Cloudflare Access Device Posture",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "4f3196a5c95747b6ad82e34e1d0a694f",
    name: "Access: Mutual TLS Certificates Read",
    description: "Grants read access to Cloudflare Access mTLS certificates",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "29d3afbfd4054af9accdd1118815ed05",
    name: "Access: Mutual TLS Certificates Write",
    description: "Grants write access to Cloudflare Access mTLS certificates",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "26bc23f853634eb4bff59983b9064fde",
    name: "Access: Organizations, Identity Providers, and Groups Read",
    description: "Grants read access to Cloudflare Access account resources",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "7121a0c7e9ed46e3829f9cca2bb572aa",
    name: "Access: Organizations, Identity Providers, and Groups Revoke",
    description:
      "Grants ability to revoke user sessions to Cloudflare Access account resources",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "bfe0d8686a584fa680f4c53b5eb0de6d",
    name: "Access: Organizations, Identity Providers, and Groups Write",
    description: "Grants write access to Cloudflare Access account resources",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "b8b7514ce5364cd8ac0455f3eb16eb5f",
    name: "Access: Policy Test Read",
    description: "Grants read access to Cloudflare Access Policy Tests",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "6d23f290472f4e6fad5c4398c057c356",
    name: "Access: Policy Test Write",
    description: "Grants full access to Cloudflare Access Policy Tests",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "de99c87e48d642ce8c985d027905b475",
    name: "Access: Population Read",
    description: "Grants read access to Cloudflare Access Populations",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "bc783549a3a741aaa10556faf8b485bb",
    name: "Access: Population Write",
    description: "Grants write access to Cloudflare Access Populations",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "e985ca9351db460faebbe8681c48e560",
    name: "Access: SCIM logs read",
    description: "Grants read access to SCIM audit logs",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "99ff99e4e30247a99d3777a8c4c18541",
    name: "Access: SSH Auditing Read",
    description:
      "Grants read access to Cloudflare Access SSH certificate authorities (CAs)",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "d30c9ad8b5224e7cb8d41bcb4757effc",
    name: "Access: SSH Auditing Write",
    description:
      "Grants write access to Cloudflare Access SSH certificate authorities (CAs)",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "91f7ce32fa614d73b7e1fc8f0e78582b",
    name: "Access: Service Tokens Read",
    description: "Grants read access to Cloudflare Access Service Tokens",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "a1c0fec57cf94af79479a6d827fa518c",
    name: "Access: Service Tokens Write",
    description: "Grants write access to Cloudflare Access Service Tokens",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "5e5d3e8efeec49f3afb67bafecbcd511",
    name: "Account API Gateway",
    description:
      "Grants full access to API-Gateway Management (including API Shield) across the whole account",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "05a2a65760a546439ed29762b163cece",
    name: "Account API Gateway Read",
    description:
      "Grants read access to API-Gateway Management (including API Shield) across the whole account",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "eb56a6953c034b9d97dd838155666f06",
    name: "Account API Tokens Read",
    description: "Grants read access to account API Tokens",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "5bc3f8b21c554832afc660159ab75fa4",
    name: "Account API Tokens Write",
    description: "Grants write access to account API Tokens",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "b89a480218d04ceb98b4fe57ca29dc1f",
    name: "Account Analytics Read",
    description: "Grants read access to analytics",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "c57ea647ef654b47bc8944fa739b570d",
    name: "Account Custom Pages Read",
    description: "Grants read access to account custom pages",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "8a9d35a7c8504208ad5c3e8d58e6162d",
    name: "Account Custom Pages Write",
    description: "Grants write access to account custom pages",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "cfa964bcdafc4ab39704e7476154e41b",
    name: "Account DNS Settings Read",
    description: "Grants read access to Account DNS Settings",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "dc44f27f48ab405392a5f69fe822bd01",
    name: "Account DNS Settings Write",
    description: "Grants write access to Account DNS Settings",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "de7a688cc47d43bd9ea700b467a09c96",
    name: "Account Firewall Access Rules Read",
    description: "Grants read access to account firewall access rules",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "a416acf9ef5a4af19fb11ed3b96b1fe6",
    name: "Account Firewall Access Rules Write",
    description: "Grants write access to account firewall access rules",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "4f1071168de8466e9808de86febfc516",
    name: "Account Rule Lists Read",
    description: "Grants read access to Rule Lists",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "2edbf20661fd4661b0fe10e9e12f485c",
    name: "Account Rule Lists Write",
    description: "Grants write access to Rule Lists",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "fb39996ee9044d2a8725921e02744b39",
    name: "Account Rulesets Read",
    description: "Grants read access to Account Rulesets",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "56907406c3d548ed902070ec4df0e328",
    name: "Account Rulesets Write",
    description: "Grants write access to Account Rulesets",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "ece81d7757ff406cad61f221a4920d55",
    name: "Account Security Center Insights Read",
    description: "Grants read access to Security Center Insights",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "cfa2e2893226455c9b945914969dff7c",
    name: "Account Security Center Insights Write",
    description: "Grants write access to Security Center Insights",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "c1fde68c7bcc44588cbb6ddbc16d6480",
    name: "Account Settings Read",
    description:
      "Grants read access to Account resources, account membership, and account level features",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "1af1fa2adc104452b74a9a3364202f20",
    name: "Account Settings Write",
    description:
      "Grants write access to Account resources, account membership, and account level features",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "56b2af4817c84ad99187911dc3986c23",
    name: "Account WAF Read",
    description: "Grants read access to Account WAF",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "cde8c82463b6414ca06e46b9633f52a6",
    name: "Account WAF Write",
    description: "grants write access to account waf",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "3e4e20ee40b9475dae22201c468fdb70",
    name: "Account Waiting Rooms Read",
    description: "Grants read access to Waiting Rooms\n",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "a7a233f9604845c787d4c8c39ac09c21",
    name: "Account: SSL and Certificates Read",
    description:
      "Grants read access to SSL MTLS certificates or Certificate Store",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "db37e5f1cb1a4e1aabaef8deaea43575",
    name: "Account: SSL and Certificates Write",
    description:
      "Grants read and write access to SSL MTLS certificates or Certificate Store",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "d07270cea5484b08ad6440c985af2148",
    name: "Address Maps Read",
    description: "Grants read access to Address Maps",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "6ffe7f4299db4d4cb54f64e0eb12a456",
    name: "Address Maps Write",
    description: "Grants write access to Address Maps",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "151803815e4f47de854c2fb7f8284d57",
    name: "Agents Gateway Read",
    description: "Grants access to reading Agents Gateway",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "82748b814dcd46b9b3e66b8151ba5e95",
    name: "Agents Gateway Run",
    description: "Grants access to running Agents Gateway",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "e84fd345697c4036a14e7810da036e1a",
    name: "Agents Gateway Write",
    description: "Grants access to reading and editing Agents Gateway",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "f3604047d46144d2a3e9cf4ac99d7f16",
    name: "Allow Request Tracer Read",
    description: "Allows read access to request tracer API",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "9c88f9c5bce24ce7af9a958ba9c504db",
    name: "Analytics Read",
    description: "Grants read access to analytics",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "d79c5e2a405b4516a322432287d40c31",
    name: "Application Security Reports Read",
    description: "Can read Application Security Reports",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "094547ab6e77498c8c4dfa87fadd5c51",
    name: "Apps Write",
    description: "Grants full access to Cloudflare Apps",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "d7887c7a417e4cf2a69f1d01c1a1dc3b",
    name: "Auto Rag Read",
    description: "Grants access to reading data from Auto Rag",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "7fb8d27511b34d02994d005b520b679f",
    name: "Auto Rag Write",
    description: "Grants access to reading and writing data from Auto Rag",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "234108c786084936a381bb19b7f4ea65",
    name: "Auto Rag Write Run Engine",
    description: "Grants access to run Auto RAG engine",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "7cf72faf220841aabcfdfab81c43c4f6",
    name: "Billing Read",
    description:
      "Grants read access to billing profile, subscriptions, usage data and access to fetch invoices and entitlements",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "6c80e02421494afc9ae14414ed442632",
    name: "Billing Write",
    description:
      "Grants write access to billing profile, subscriptions, and access to fetch invoices and entitlements",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "51be404b56244056868226263a44a632",
    name: "Bot Management Feedback Report Read",
    description: "Grants read access to BOT Management Feedback Reports",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "2002629aaff0454085bf5a201ed70a72",
    name: "Bot Management Feedback Report Write",
    description: "Grants write access to BOT Management Feedback Reports",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "07bea2220b2343fa9fae15656c0d8e88",
    name: "Bot Management Read",
    description: "Grants read access to BOT Management",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "3b94c49258ec4573b06d51d99b6416c0",
    name: "Bot Management Write",
    description: "Grants write access to BOT Management",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "374b03fa229f4eb6b011bb1cd7f235ee",
    name: "Browser Rendering Read",
    description: "Grants read access to Browser Rendering API",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "adddda876faa4a0590f1b23a038976e4",
    name: "Browser Rendering Write",
    description: "Grants write access to Browser Rendering API",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "da5fe84b9c5446a0a5955b673fafa288",
    name: "CASB Read",
    description: "Grants read access to Cloudflare CASB",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "b9ed086b20864ad89c5aac24cdd02365",
    name: "CASB Write",
    description: "Grants write access to Cloudflare CASB",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "47b936e2027140c0a474cac8887b8c29",
    name: "CF Agents Read",
    description: "Grants read access to CF Agents",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "cb142f7fbc3540f0bade0cbe75f606dc",
    name: "CF Agents Write",
    description: "Grants write access to CF Agents",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "e17beae8b8cb423a99b1730f21238bed",
    name: "Cache Purge",
    description: "Grants access to purge cache",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "3245da1cf36c45c3847bb9b483c62f97",
    name: "Cache Settings Read",
    description: "Grants read access to cache settings phase",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "9ff81cbbe65c400b97d92c3c1033cab6",
    name: "Cache Settings Write",
    description: "Grants write access to cache settings phase",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "686ab9a8b3854f25a1474f302d14b68d",
    name: "Calls Read",
    description: "Grants read access to Calls configuration",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "b711942448db4b0aace44d1312f9fdb0",
    name: "Calls Write",
    description: "Grants read/write access to Calls configuration",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "9ade9cfc8f8949bcb2371be2f0ec8db1",
    name: "China Network Steering Read",
    description: "Grants read access to China Network Steering",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "c6f6338ceae545d0b90daaa1fed855e6",
    name: "China Network Steering Write",
    description: "Grants write access to China Network Steering",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "0661ff47aa3a4786beab3b8128e0cd24",
    name: "Cloud Connector Read",
    description: "Grants read access to Cloud Connector",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "eafd71286d0e4fdca404a7b4d203c5c9",
    name: "Cloud Connector Write",
    description: "Grants write access to Cloud Connector",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "9e5a9912439940fca5898b5b8dc6d1a5",
    name: "Cloud Email Security: Read",
    description: "Grants read access to Cloudflare Cloud Email Security",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "a3567c13e074447fb101babac3463566",
    name: "Cloud Email Security: Write",
    description: "Grants write access to Cloudflare Cloud Email Security",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "65ec50cbde3d4c838bbe7500024d5745",
    name: "Cloudchamber Read",
    description: "Grants read access to Cloudchamber deployments",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "26ce6c7d18a346528e7b905d5e269866",
    name: "Cloudchamber Write",
    description: "Grants write access to Cloudchamber deployments",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "00ec19a0d4fa4e4aae23b50bf04c0630",
    name: "Cloudflare CDS Compute Account Read",
    description:
      "Grants read access to Cloudflare CDS compute account resources",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "9bf884ba0de445dab37ea4a3e1a2c9f1",
    name: "Cloudflare CDS Compute Account Write",
    description:
      "Grants write access to Cloudflare CDS compute account resources",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "3a1e1ef09dd34271bb44fc4c6a419952",
    name: "Cloudflare DEX",
    description: "Grants access to Cloudflare DEX",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "3b376e0aa52c41cbb6afc9cab945afa8",
    name: "Cloudflare DEX Read",
    description: "Grants read access to Cloudflare DEX",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "92c8dcd551cc42a6a57a54e8f8d3f3e3",
    name: "Cloudflare DEX Write",
    description: "Grants full access to Cloudflare DEX",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "1cd960c063a0448481343372c963d8c7",
    name: "Cloudflare One Connector: WARP Read",
    description: "Grants read access to WARP Connectors",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "5b5c774a5d174ca88d046c8889648b3f",
    name: "Cloudflare One Connector: WARP Write",
    description: "Grants write access to WARP Connectors",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "c1968d31028d4239976ec3bc4750bbf6",
    name: "Cloudflare One Connector: cloudflared Read",
    description: "Grants read access to cloudflared connectors",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "037b9e348b3b42d4b46ea2fcb1cfb3e7",
    name: "Cloudflare One Connector: cloudflared Write",
    description: "Grants write access to cloudflared connectors",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "07cf1c1952a84b13b2cd542f3d2f29ab",
    name: "Cloudflare One Connectors Read",
    description: "Grants read access to Cloudflare One connectors",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "a7030c9c98d544e092d8b099fabb1f06",
    name: "Cloudflare One Connectors Write",
    description: "Grants write access to Cloudflare One connectors",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "4f1276d1e7e34c32a5012bbe02ece86d",
    name: "Cloudflare One Networks Read",
    description:
      "Grants read access to Cloudflare One routes, subnets, and virtual networks",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "e2980d9241cf4939bbbd74fdc43b9651",
    name: "Cloudflare One Networks Write",
    description:
      "Grants write access to Cloudflare One routes, subnets, and virtual networks",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "efea2ab8357b47888938f101ae5e053f",
    name: "Cloudflare Tunnel Read",
    description: "Grants access to view Cloudflare Tunnels",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "c07321b023e944ff818fec44d8203567",
    name: "Cloudflare Tunnel Write",
    description: "Grants access to create and delete Cloudflare Tunnels",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "e0e0edfbe8834df3b51424ba4fb7bb5f",
    name: "Cloudflare Zero Trust Secure DNS Locations Write",
    description:
      "Grants access to create and edit secure DNS Locations only in teams (Zero Trust)",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "cf9353ed7978436e8fb20c03fce26449",
    name: "Cloudforce One Read",
    description: "Grants read access to Cloudforce One",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "677767156f294485b497a8f103172e7d",
    name: "Cloudforce One Write",
    description: "Grants read access to Cloudforce One",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "20e5ea084b2f491c86b8d8d90abff905",
    name: "Config Settings Read",
    description: "Grants read access to config settings phase",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "06f0526e6e464647bd61b63c54935235",
    name: "Config Settings Write",
    description: "Grants write access to config settings phase",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "77efc2c0724d4c4eb94bfd9656247130",
    name: "Connectivity Directory Admin",
    description:
      "Can view, edit, create, and delete Connectivity Directory Services, including the ability to create Services that bind to Cloudflare Tunnel",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "95fa65ba51fd49c4a6ac4c8c78ebac93",
    name: "Connectivity Directory Bind",
    description:
      "Can read, list, and bind to Connectivity Directory services, as well as read and list Cloudflare Tunnels",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "8764961c1edb4274be129d630b0b2671",
    name: "Connectivity Directory Read",
    description:
      "Can view Connectivity Directory services and Cloudflare Tunnels",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "eeffa4d16812430cb4a0ae9e7f46fc24",
    name: "Constellation Read",
    description: "Grants read access to Constellation configuration and models",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "7c81856725af47ce89a790d5fb36f362",
    name: "Constellation Write",
    description:
      "Grants write access to Constellation configuration and models",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "a2b55cd504d44ef18b7ba6a7f2b8fbb1",
    name: "Custom Errors Read",
    description: "Grants read access to custom errors phase",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "a9dba34cf5814d4ab2007b4ada0045bd",
    name: "Custom Errors Write",
    description: "Grants write access to custom errors phase",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "a2431ca73b7d41f99c53303027392586",
    name: "Custom Pages Read",
    description: "Grants read access to custom pages",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "c244ec076974430a88bda1cdd992d0d9",
    name: "Custom Pages Write",
    description: "Grants write access to custom pages",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "192192df92ee43ac90f2aeeffce67e35",
    name: "D1 Read",
    description: "Grants read access to D1 configuration and SQL queries",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "09b2857d1c31407795e75e3fed8617a1",
    name: "D1 Write",
    description: "Grants write access to D1 configuration and SQL queries",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "dee7c22a57674abea8f942110b094717",
    name: "DDoS Botnet Feed Read",
    description: "Grants read access to Botnet Feed reports",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "0caa90c9b186447397c8b00358d34a76",
    name: "DDoS Botnet Feed Write",
    description: "Grants write access to Botnet Feed configuration",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "af1c363c35ba45b9a8c682ae50eb3f99",
    name: "DDoS Protection Read",
    description: "Grants read access to DDoS protection",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "d44ed14bcc4340b194d3824d60edad3f",
    name: "DDoS Protection Write",
    description: "Grants write access to DDoS protection",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "5f48a472240a4b489a21d43bd19a06e1",
    name: "DNS Firewall Read",
    description: "Grants read access to DNS Firewall",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "da6d2d6f2ec8442eaadda60d13f42bca",
    name: "DNS Firewall Write",
    description: "Grants write access to DNS Firewall",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "82e64a83756745bbbb1c9c2701bf816b",
    name: "DNS Read",
    description: "Grants read access to DNS",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "95d69e8d6d5144bfb0923667355d9f11",
    name: "DNS View Read",
    description: "Grants read access to DNS Views",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "5b7aedd821a548b9bf5a2acabbce98c7",
    name: "DNS View Write",
    description: "Grants write access to DNS Views",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "4755a26eedb94da69e1066d98aa820be",
    name: "DNS Write",
    description: "Grants write access to DNS",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "e199d584e69344eba202452019deafe3",
    name: "Disable ESC Read",
    description: "Grants read access to Cloudflare Disable ESC",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "29eefa0805f94fdfae2b058b5b52f319",
    name: "Disable ESC Read",
    description: "Grants read access to Cloudflare Disable ESC",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "9110d9dd749e464fb9f3961a2064efc5",
    name: "Disable ESC Write",
    description: "Grants write access to Cloudflare Disable ESC",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "18555e39c5ba40d284dde87eda845a90",
    name: "Disable ESC Write",
    description: "Grants write access to Cloudflare Disable ESC",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "f0235726de25444a84f704b7c93afadf",
    name: "Domain API Gateway",
    description:
      "Grants full access to API-Gateway Management (including API Shield)",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "6ced5d0d69b1422396909a62c38ab41b",
    name: "Domain API Gateway Read",
    description:
      "Grants read access to API-Gateway Management (including API Shield)",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "6134079371904d8ebd77931c8ca07e50",
    name: "Domain Page Shield",
    description: "Grants write access to Page Shield",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "945315185a8f40518bf3e9e6d0bee126",
    name: "Domain Page Shield Read",
    description: "Grants read access to Page Shield",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "d8e12db741544d1586ec1d6f5d3c7786",
    name: "Dynamic URL Redirects Read",
    description: "Grants read access to Dynamic URL Redirect",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "74e1036f577a48528b78d2413b40538d",
    name: "Dynamic URL Redirects Write",
    description: "Grants write access to Dynamic URL Redirect",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "5272e56105d04b5897466995b9bd4643",
    name: "Email Routing Addresses Read",
    description: "Grants read access to Email Routing target addresses\n",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "e4589eb09e63436686cd64252a3aebeb",
    name: "Email Routing Addresses Write",
    description: "Grants full access to Email Routing target addresses\n",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "1b600d9d8062443e986a973f097e728a",
    name: "Email Routing Rules Read",
    description: "Grants read access to Email Routing rules\n",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "79b3ec0d10ce4148a8f8bdc0cc5f97f2",
    name: "Email Routing Rules Write",
    description: "Grants full access to Email Routing rules\n",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "1047880d37b649b49db4a504a245896f",
    name: "Email Security DMARC Reports Read",
    description: "Grants read access to Email Security dmarc reports\n",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "2eee71c9364c4cacaf469e8370f09056",
    name: "Email Security DMARC Reports Write",
    description: "Grants full access to Email Security dmarc reports\n",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "2d5b4b1f6c89487bb7184c2c1dcd3bf1",
    name: "Email Sending Read",
    description: "Grants access to reading data from Email Sending",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "5df633d6b41c42bcaf5b4a62b9d14b64",
    name: "Email Sending Write",
    description: "Grants access to reading and writing data from Email Sending",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "4ec32dfcb35641c5bb32d5ef1ab963b4",
    name: "Firewall Services Read",
    description: "Grants read access to Firewall resources",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "43137f8d07884d3198dc0ee77ca6e79b",
    name: "Firewall Services Write",
    description: "Grants write access to Firewall resources",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "a2c61201f92a4e06a901f156795388a9",
    name: "Firewall for AI Read",
    description: "Grants read access to Firewall for AI settings.",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "5af6a2f284144e95a89840408439adef",
    name: "Firewall for AI Write",
    description: "Grants full access to Firewall for AI settings.",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "0d24e472a9654642a97df736e8b0d980",
    name: "Fraud Detection Read",
    description: "Grants read access to Fraud Detection",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "685f9605fd4e44ec937b6a0db658e629",
    name: "Fraud Detection Write",
    description: "Grants write access to Fraud Detection",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "6b60a5a87cae475da7e76e77e4209dd5",
    name: "HTTP Applications Read",
    description: "Grants read-only access to HTTP Applications",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "4736c02a9f224c8196ae5b127beae78c",
    name: "HTTP Applications Write",
    description: "Grants full access to HTTP Applications",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "c49f8d15f9f44885a544d945ef5aa6ae",
    name: "HTTP DDoS Managed Ruleset Read",
    description: "Grants read access to HTTP DDoS Managed Ruleset",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "b88a3aa889474524bccea5cf18f122bf",
    name: "HTTP DDoS Managed Ruleset Write",
    description: "Grants write access to HTTP DDoS Managed Ruleset",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "fac65912d42144aa86b7dd33281bf79e",
    name: "Health Checks Read",
    description: "Grants read access to Health Checks",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "e0dc25a0fbdf4286b1ea100e3256b0e3",
    name: "Health Checks Write",
    description: "Grants write access to Health Checks",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "4d62ccf834df44808bc9283d65c4e4e9",
    name: "Hyperdrive Read",
    description: "Grants read access to Hyperdrive configuration",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "721b2f51fba74871bd361de65aeb7e03",
    name: "Hyperdrive Write",
    description: "Grants write access to Hyperdrive configuration",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "212c9ff247b9406d990c017482afb3a5",
    name: "IOT Read",
    description: "Grants read access to IOT devices",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "865ebd55bc6d4b109de6813eccfefd13",
    name: "IOT Write",
    description: "Grants full access to IOT devices",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "e763fae6ee95443b8f56f19213c5f2a5",
    name: "IP Prefixes: BGP On Demand Read",
    description: "Grants access to read ip prefix bgp configuration",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "2ae23e4939d54074b7d252d27ce75a77",
    name: "IP Prefixes: BGP On Demand Write",
    description: "Grants access to read and change ip prefix bgp configuration",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "27beb7f8333b41e2b946f0e23cd8091e",
    name: "IP Prefixes: Read",
    description: "Grants access to read ip prefix settings",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "92b8234e99f64e05bbbc59e1dc0f76b6",
    name: "IP Prefixes: Write",
    description: "Grants access to read/write ip prefix settings",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "0cf6473ad41449e7b7b743d14fc20c60",
    name: "Images Read",
    description: "Grants read access to Images",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "618ec6c64a3a42f8b08bdcb147ded4e4",
    name: "Images Write",
    description: "Grants write access to upload Images",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "c6f97eeee13345db8cc00af0953a42de",
    name: "Integration Write",
    description: "Grants write access to integrations",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "df1577df30ee46268f9470952d7b0cdf",
    name: "Intel Read",
    description: "Grants read access to Intel API",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "92209474242d459690e2cdb1985eaa6c",
    name: "Intel Write",
    description: "Grants write access to Intel API",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "4657621393f94f83b8ef94adba382e48",
    name: "L4 DDoS Managed Ruleset Read",
    description: "Grants read access to L4 DDoS Managed Ruleset",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "7a4c3574054a4d0ba7c692893ba8bdd4",
    name: "L4 DDoS Managed Ruleset Write",
    description: "Grants write access to L4 DDoS Managed Ruleset",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "59059f0c977b44f8b1c18e0aaf91c369",
    name: "Load Balancers Account Read",
    description:
      "Grants read access to account load balancers and associated resources",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "419ec42810af4659ade77716dbe47bc6",
    name: "Load Balancers Account Write",
    description:
      "Grants write access to account load balancers and associated resources",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "e9a975f628014f1d85b723993116f7d5",
    name: "Load Balancers Read",
    description:
      "Grants read access to load balancers and associated resources",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "6d7f2f5f5b1d4a0e9081fdc98d432fd1",
    name: "Load Balancers Write",
    description:
      "Grants write access to load balancers and associated resources",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "9d24387c6e8544e2bc4024a03991339f",
    name: "Load Balancing: Monitors and Pools Read",
    description: "Grants read access to account level load balancer resources",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "d2a1802cc9a34e30852f8b33869b2f3c",
    name: "Load Balancing: Monitors and Pools Write",
    description: "Grants write access to account level load balancer resources",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "6a315a56f18441e59ed03352369ae956",
    name: "Logs Read",
    description: "Grants read access to logs and logpush jobs",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "c4a30cd58c5d42619c86a3c36c441e2d",
    name: "Logs Read",
    description: "Grants read access to logs and logpush jobs",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "96163bd1b0784f62b3e44ed8c2ab1eb6",
    name: "Logs Write",
    description: "Grants write access to logpush jobs",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "3e0b5820118e47f3922f7c989e673882",
    name: "Logs Write",
    description: "Grants write access to logpush jobs",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "b84a912ebb4a418888fec65f65c8ff3b",
    name: "MCP Portals Read",
    description: "Grants access to reading MCP Portals",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "db3d398df73946acb755c05b69edfc30",
    name: "MCP Portals Write",
    description: "Grants access to reading and editing MCP Portals",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "3a46c728a0a040d5a65cd8e2f3bc6935",
    name: "Magic Firewall Packet Captures - Read PCAPs API",
    description: "Grants read access to Packet Captures",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "4ea7d6421801452dbf07cef853a5ef39",
    name: "Magic Firewall Packet Captures - Write PCAPs API",
    description: "Grants write access to Packet Captures",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "02b71f12bb0748e9af8126494e181342",
    name: "Magic Firewall Read",
    description: "Grants read access to Magic Firewall",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "8bd1dac84d3d43e7bfb43145f010a15c",
    name: "Magic Firewall Write",
    description: "Grants write access to Magic Firewall",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "8e6ed1ef6e864ad0ae477ceffa5aa5eb",
    name: "Magic Network Monitoring Admin",
    description: "Grants admin access to MNM settings",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "3d85e9514f944bb4912c5871d92e5af5",
    name: "Magic Network Monitoring Config Read",
    description: "Grants read access to MNM config and rules",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "09c77baecb6341a2b1ca2c62b658d290",
    name: "Magic Network Monitoring Config Write",
    description:
      "Grants write access to MNM rules and update access to account settings",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "967ecf860a244dd1911a0331a0af582a",
    name: "Magic Transit Read",
    description: "Grants read access to Magic Transit",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "0bc09a3cd4b54605990df4e307f138e1",
    name: "Magic Transit Write",
    description: "Grants write access to Magic Transit",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "17fc856c4ebe49d4bb70f8e4744398cf",
    name: "Magic WAN Read",
    description: "Grants read access to Magic WAN",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "a1a7389ba7e441dba95852e10970fcc3",
    name: "Magic WAN Write",
    description: "Grants write access to Magic WAN",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "319f5059d33a410da0fac4d35a716157",
    name: "Managed headers Read",
    description: "Grants read access to managed headers phases",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "0fd9d56bc2da43ad8ea22d610dd8cab1",
    name: "Managed headers Write",
    description: "Grants write access to managed headers phases",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "429a068902904c5a9ed9fc267c67da9a",
    name: "Mass URL Redirects Read",
    description: "Grants read access to Mass URL Redirect",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "abe78e2276664f4db588c1f675a77486",
    name: "Mass URL Redirects Write",
    description: "Grants write access to Mass URL Redirect",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "ce18edbdcebf465e9d6d1d2fc80ffd42",
    name: "Notifications Read",
    description: "Grants read access to notifications",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "c3c847c5802d4ce3ba00e3e97b3c8555",
    name: "Notifications Write",
    description: "Grants write access to Notifications",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "7b32a91ece3140d4b3c2c56f23fc8e35",
    name: "Origin Read",
    description: "Grants read access to origin phase",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "a4308c6855c84eb2873e01b6cc85cbb3",
    name: "Origin Write",
    description: "Grants write access to origin phase",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "b415b70a4fd1412886f164451f20405c",
    name: "Page Rules Read",
    description: "Grants read access to Page Rules",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "ed07f6c337da4195b4e72a1fb2c6bcae",
    name: "Page Rules Write",
    description: "Grants write access to Page Rules",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "440e6958bcc947329f8d56328d7322ce",
    name: "Page Shield",
    description: "Grants write access to Page Shield",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "050531528b044d58bbb71666fef7c07c",
    name: "Page Shield Read",
    description: "Grants read access to Page Shield across the whole account",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "87065285ab38463481e72815eefd18c3",
    name: "Page Shield Write",
    description: "Grants write access to Page Shield",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "e247aedd66bd41cc9193af0213416666",
    name: "Pages Read",
    description: "Grants read access to Cloudflare Pages",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "8d28297797f24fb8a0c332fe0866ec89",
    name: "Pages Write",
    description: "Grants write access to Cloudflare Pages",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "14b9cf2f410f4c0c9a16bb10a81c0e0b",
    name: "Pipelines Read",
    description: "Grants read access to Cloudflare Pipelines",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "5606e7405dc542949d949d59993d321f",
    name: "Pipelines Send",
    description: "Grants access to Send Events to Cloudflare Pipelines",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "e34111af393449539859485aa5ddd5bd",
    name: "Pipelines Write",
    description: "Grants write access to Cloudflare Pipelines",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "fd7f886c75a244389e892c4c3c068292",
    name: "Pubsub Configuration Read",
    description: "Grants read access to Pubsub Configurations\n",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "910b6ecca1c5411bb894e787362d1312",
    name: "Pubsub Configuration Write",
    description: "Grants full access to Pubsub Configurations\n",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "84a7755d54c646ca87cd50682a34bf7c",
    name: "Queues Read",
    description: "Grants read access to Cloudflare Queues",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "366f57075ffc42689627bcf8242a1b6d",
    name: "Queues Write",
    description: "Grants write access to Cloudflare Queues",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "dfe525ec7b07472c827d8d009178b2ac",
    name: "Radar Read",
    description: "Grants access to reading Radar",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "de62b15d79cc4d8d9c7b443c656eadbd",
    name: "Realtime",
    description:
      "Grants access to Realtime configuration excluding sensitive data",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "ba6ce7d23a9544ccad0816691ba38e21",
    name: "Realtime Admin",
    description: "Grants admin access to Realtime configuration",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "9bb90620717647a39679e1d951f140d6",
    name: "Registrar Domains Read",
    description: "Grants read access to Cloudflare Registrar domains",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "93ae59e7a40c4287a57ff6e501186a63",
    name: "Response Compression Read",
    description: "Grants read access to the response compression phase",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "4bd3fb513a23494aa1341a7e1eb6e080",
    name: "Response Compression Write",
    description: "Grants write access to the response compression phase",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "58abbad6d2ce40abb2594fbe932a2e0e",
    name: "Rule Policies Read",
    description: "Grants read access to Rule Policies",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "61ddc58f1da14f95b33b41213360cbeb",
    name: "Rule Policies Write",
    description: "Grants write access to Rule Policies",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "d5812c023a5048b4882175a28952362d",
    name: "SCIM Provisioning",
    description: "Grants membership permissions needed for SCIM provisioning",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "7b7216b327b04b8fbc8f524e1f9b7531",
    name: "SSL and Certificates Read",
    description: "Grants read access to SSL configuration and cert management",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "c03055bc037c4ea9afb9a9f104b7b721",
    name: "SSL and Certificates Write",
    description: "Grants write access to SSL configuration and cert management",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "1d80f6f165ea47f2b55d4a393fd697de",
    name: "SSO Connector Read",
    description: "Grants read access to Cloudflare SSO connectors\n",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "901ca5e292584c6aa1b4cdb39248bb07",
    name: "SSO Connector Write",
    description: "Grants write access to Cloudflare SSO connectors\n",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "853643ed57244ed1a05a7c024af9ab5a",
    name: "Sanitize Read",
    description: "Grants read access to sanitization",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "89bb8c37d46042e98b84560eaaa6379f",
    name: "Sanitize Write",
    description: "Grants write access to sanitization",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "5e33b7d77788455c9fdf18cbd38ee5a0",
    name: "Secrets Store Read",
    description: "Grants read access to Secrets Store",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "adc8fa2bc6124928a8b3314dc63a1235",
    name: "Secrets Store Write",
    description: "Grants write access to Secrets Store",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "595409c54a24444b80a495620b2d614c",
    name: "Select Configuration Read",
    description: "Grants read access to select configuration",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "235eac9bb64942b49cb805cc851cb000",
    name: "Select Configuration Write",
    description: "Grants write access to select configuration",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "74c654eb4aac40e28d6c6caa4c5aeb3d",
    name: "Snippets Read",
    description: "Grants read access to Snippets",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "dadeaf3abdf14126a77a35e0c92fc36e",
    name: "Snippets Write",
    description: "Grants write access to Snippets",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "de21485a24744b76a004aa153898f7fe",
    name: "Stream Read",
    description: "Grants read access to Cloudflare Stream",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "714f9c13a5684c2885a793f5edb36f59",
    name: "Stream Write",
    description: "Grants write access to Cloudflare Stream",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "a9a99455bf3245f6a5a244f909d74830",
    name: "Transform Rules Read",
    description: "Grants read access to transform rules",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "ae16e88bc7814753a1894c7ce187ab72",
    name: "Transform Rules Write",
    description: "Grants write access to transform rules",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "f0ba3733e746429182fcd40ec648c066",
    name: "Trust and Safety Read",
    description: "Grants access to read abuse reports and abuse actions",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "120f843a9c074f399b830e542e5616b8",
    name: "Trust and Safety Write",
    description:
      "Grants access to interact with abuse reports and abuse actions",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "5d78fd7895974fd0bdbbbb079482721b",
    name: "Turnstile Sites Read",
    description: "Grants read access to Turnstile",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "755c05aa014b4f9ab263aa80b8167bd8",
    name: "Turnstile Sites Write",
    description: "Grants write access to Turnstile",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "5d613a610b294788a29572aaac2f254d",
    name: "URL Scanner Read",
    description: "Grants read access to URL Scanner API",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "2a400bcb29154daab509fe07e3facab0",
    name: "URL Scanner Write",
    description: "Grants write access to URL Scanner API",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "1799edaae5db489294430e20d9b519e0",
    name: "Vectorize Read",
    description: "Grants read access to Vectorize configuration",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "64156ba5be47441096c83c7fc17c488b",
    name: "Vectorize Write",
    description: "Grants write access to Vectorize configuration",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "cab5202d07ef47beae788e6bc95cb6fe",
    name: "Waiting Rooms Read",
    description: "Grants read access to Waiting Rooms\n",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "24fc124dc8254e0db468e60bf410c800",
    name: "Waiting Rooms Write",
    description: "Grants write access to Waiting Rooms\n",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "8e31f574901c42e8ad89140b28d42112",
    name: "Web3 Hostnames Read",
    description: "Grants read access to Web3 Hostnames\n",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "5ea6da42edb34811a78d1b007557c0ca",
    name: "Web3 Hostnames Write",
    description: "Grants write access to Web3 Hostnames\n",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "a92d2450e05d4e7bb7d0a64968f83d11",
    name: "Workers AI Read",
    description: "Grants access to invoke Workers AI models",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "bacc64e0f6c34fc0883a1223f938a104",
    name: "Workers AI Write",
    description: "Grants access to invoke Workers AI models and edit assets",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "ad99c5ae555e45c4bef5bdf2678388ba",
    name: "Workers CI Read",
    description: "Grants read access to Workers CI",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "2e095cf436e2455fa62c9a9c2e18c478",
    name: "Workers CI Write",
    description: "Grants write access to Workers CI",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "cfd39eebc07c4e3ea849e4b3d2644637",
    name: "Workers Containers Read",
    description: "Grants read access to Workers Containers",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "bdbcd690c763475a985e8641dddc09f7",
    name: "Workers Containers Write",
    description: "Grants write access to Workers Containers",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "8b47d2786a534c08a1f94ee8f9f599ef",
    name: "Workers KV Storage Read",
    description: "Grants read access to Cloudflare Workers KV Storage",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "f7f0eda5697f475c90846e879bab8666",
    name: "Workers KV Storage Write",
    description: "Grants write access to Cloudflare Workers KV Storage",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "66c1ed49f4ed46098b75696a6d4ee3c9",
    name: "Workers Observability Read",
    description: "Grants read access to Cloudflare Workers Observability",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "29c629fb7b5e4c408ca0f7b545724fcc",
    name: "Workers Observability Telemetry Write",
    description:
      "Grants write access for Telemetry to Cloudflare Workers Observability",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "82c075da3f4647a2a03becd0fe240f8a",
    name: "Workers Observability Write",
    description:
      "Grants read and write access to Cloudflare Workers Observability",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "45db74139a62490b9b60eb7c4f34994b",
    name: "Workers R2 Data Catalog Read",
    description: "Grants read access to R2 Data Catalog",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "d229766a2f7f4d299f20eaa8c9b1fde9",
    name: "Workers R2 Data Catalog Write",
    description: "Grants write access to R2 Data Catalog",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "f45430d92e2b4a6cb9f94f2594c141b8",
    name: "Workers R2 SQL Read",
    description:
      "Grants access to read-only SQL queries against R2 Data Catalog",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "6a018a9f2fc74eb6b293b0c548f38b39",
    name: "Workers R2 Storage Bucket Item Read",
    description: "Grants read access to Cloudflare R2 Bucket Scoped Storage",
    scopes: ["com.cloudflare.edge.r2.bucket"],
  },
  {
    id: "2efd5506f9c8494dacb1fa10a3e7d5b6",
    name: "Workers R2 Storage Bucket Item Write",
    description: "Grants write access to Cloudflare R2 Bucket Scoped Storage",
    scopes: ["com.cloudflare.edge.r2.bucket"],
  },
  {
    id: "b4992e1108244f5d8bfbd5744320c2e1",
    name: "Workers R2 Storage Read",
    description: "Grants read access to Cloudflare R2 Storage",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "bf7481a1826f439697cb59a20b22293e",
    name: "Workers R2 Storage Write",
    description: "Grants write access to Cloudflare R2 Storage",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "2072033d694d415a936eaeb94e6405b8",
    name: "Workers Routes Read",
    description:
      "Grants read access to Cloudflare Workers and Workers KV Storage",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "28f4b596e7d643029c524985477ae49a",
    name: "Workers Routes Write",
    description:
      "Grants write access to Cloudflare Workers and Workers KV Storage",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "1a71c399035b4950a1bd1466bbe4f420",
    name: "Workers Scripts Read",
    description: "Grants read access to Cloudflare Workers scripts",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "e086da7e2179491d91ee5f35b3ca210a",
    name: "Workers Scripts Write",
    description: "Grants write access to Cloudflare Workers scripts",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "05880cd1bdc24d8bae0be2136972816b",
    name: "Workers Tail Read",
    description: "Grants `wrangler tail` read permissions",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "cdeb15b336e640a2965df8c65052f1e0",
    name: "Zaraz Admin",
    description: "Can edit and publish Zaraz settings.",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "89d5bf002389496e9994b8c30608b5d0",
    name: "Zaraz Edit",
    description: "Can edit Zaraz settings.",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "5bdbde7e76144204a244274eac3eb0eb",
    name: "Zaraz Read",
    description: "Grants read access to Zaraz settings.",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "3f376c8e6f764a938b848bd01c8995c4",
    name: "Zero Trust Read",
    description: "Grants read access to Cloudflare Zero Trust resources",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "efb81b5cd37d49f3be1da9363a6d7a19",
    name: "Zero Trust Report",
    description: "Grants reporting access to Cloudflare Zero Trust",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "07f91e3e32b647ffae0178d884f23ee0",
    name: "Zero Trust Resilience Read",
    description:
      "Grants read access to Cloudflare Zero Trust Resilience resources",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "cc00ebddebca4b8399607562a78df084",
    name: "Zero Trust Resilience Write",
    description:
      "Grants write access to Cloudflare Zero Trust Resilience resources",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "b33f02c6f7284e05a6f20741c0bb0567",
    name: "Zero Trust Write",
    description: "Grants write access to Cloudflare Zero Trust resources",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "f5d857f67f144e3c8bacea88c17d4a13",
    name: "Zero Trust: PII Read",
    description: "Grants read access to Cloudflare Zero Trust PII.",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "a1a6298e52584c8fb6313760a30c681e",
    name: "Zero Trust: Seats Write",
    description:
      "Grants write access to the Zero Trust seats your organization can use (and be billed for)",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "0a6cfe8cd3ed445e918579e2fb13087b",
    name: "Zone DNS Settings Read",
    description: "Grants read access to Zone DNS Settings",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "c4df38be41c247b3b4b7702e76eadae0",
    name: "Zone DNS Settings Write",
    description: "Grants write access to Zone DNS Settings",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "c8fed203ed3043cba015a93ad1616f1f",
    name: "Zone Read",
    description: "Grants read access to zone management",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "517b21aee92c4d89936c976ba6e4be55",
    name: "Zone Settings Read",
    description: "Grants read access to zone settings",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "3030687196b94b638145a3953da2b699",
    name: "Zone Settings Write",
    description: "Grants write access to zone settings",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "211a4c0feb3e43b3a2d41f1443a433e7",
    name: "Zone Transform Rules Read",
    description: "Grants read access to transform rules at zone level",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "0ac90a90249747bca6b047d97f0803e9",
    name: "Zone Transform Rules Write",
    description: "Grants write access to transform rules at zone level",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "1b1ea24cf0904d33903f0cc7e54e280f",
    name: "Zone Versioning Read",
    description: "Grants read-only access to Zone Versioning",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "c9915d86fbff46af9dd945c0a882294b",
    name: "Zone Versioning Write",
    description: "Grants full access to Zone Versioning",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "dbc512b354774852af2b5a5f4ba3d470",
    name: "Zone WAF Read",
    description: "Grants read access to Zone WAF",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "fb6778dc191143babbfaa57993f1d275",
    name: "Zone WAF Write",
    description: "Grants write access to Zone WAF",
    scopes: ["com.cloudflare.api.account.zone"],
  },
  {
    id: "e6d2666161e84845a636613608cee8d5",
    name: "Zone Write",
    description: "Grants write access to zone management",
    scopes: ["com.cloudflare.api.account.zone"],
  },
] as const;

export type PermissionGroupName = (typeof PERMISSION_GROUPS)[number]["name"];

/**
 * Lookup map from permission-group name to the first matching permission group.
 *
 * Some Cloudflare names appear twice (e.g. account-scope and zone-scope variants
 * sharing a label). We keep the first occurrence; callers that need a specific
 * scope should pass `{ id }` directly instead of using the name shorthand.
 */
export const PERMISSION_GROUPS_BY_NAME: Record<
  PermissionGroupName,
  PermissionGroup
> = (() => {
  const map = {} as Record<PermissionGroupName, PermissionGroup>;
  for (const group of PERMISSION_GROUPS) {
    if (!(group.name in map)) {
      map[group.name as PermissionGroupName] = group;
    }
  }
  return map;
})();
