// AWS Account Management (sdkId: "account").
//
// Action -> coverage ledger:
// - putAccountName / getAccountInformation      -> AccountName resource
// - putContactInformation / getContactInformation -> ContactInformation resource
// - put/get/deleteAlternateContact              -> AlternateContact resource
// - enableRegion / disableRegion / getRegionOptStatus / listRegions -> Region resource
// - getAccountInformation / getContactInformation / getAlternateContact /
//   listRegions / getRegionOptStatus            -> runtime read bindings
// - startPrimaryEmailUpdate / acceptPrimaryEmailUpdate / getPrimaryEmail
//     Out of scope: the primary (root) email update flow requires a
//     one-time password delivered to the new mailbox — a human-in-the-loop
//     workflow that cannot be automated as a resource or runtime binding.
// - getGovCloudAccountInformation
//     Out of scope: management read of the linked GovCloud account; no
//     plausible runtime/consumer use.
//
// Runtime bindings cover the account-level reads (account metadata, primary
// and alternate contacts, Region opt statuses) a deployed Function calls at
// runtime. Writes (putContactInformation, enableRegion, …) remain
// resource-only: they are root-level account settings the IaC engine owns.
// No event sources: the service emits no event streams or notification
// configurations.
export * from "./AccountName.ts";
export * from "./AlternateContact.ts";
export * from "./ContactInformation.ts";
export * from "./GetAccountInformation.ts";
export * from "./GetAccountInformationHttp.ts";
export * from "./GetAlternateContact.ts";
export * from "./GetAlternateContactHttp.ts";
export * from "./GetContactInformation.ts";
export * from "./GetContactInformationHttp.ts";
export * from "./GetRegionOptStatus.ts";
export * from "./GetRegionOptStatusHttp.ts";
export * from "./ListRegions.ts";
export * from "./ListRegionsHttp.ts";
export * from "./Region.ts";
