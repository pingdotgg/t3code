import generatedManifest from "@t3tools/mobile-third-party-licenses";
import { decodeThirdPartyLicenseManifest } from "@t3tools/shared/thirdPartyLicenses";

export const MOBILE_THIRD_PARTY_LICENSES = decodeThirdPartyLicenseManifest(generatedManifest);
