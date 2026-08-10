import verifiedReleases from "../content/verified-releases.json";
import { type ReleaseManifest, resolvePublicCapabilities } from "./capabilities";

export const publicCapabilities = resolvePublicCapabilities(
  import.meta.env,
  verifiedReleases as ReleaseManifest,
);
