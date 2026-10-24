import { releaseResourceAttributes } from "@t3tools/shared/releaseResource";

/**
 * The UI is a build of its own, so it reports its own release identity rather
 * than the server's. Vercel PR previews cannot carry it in `version` without
 * breaking the version-skew comparison against the server, so they mark
 * themselves with `VITE_RELEASE_CHANNEL=preview`.
 */
export const clientTracingResource = (input: {
  readonly version: string;
  readonly isDevelopment: boolean;
  readonly releaseChannel: string | undefined;
  readonly surface: "desktop" | "web";
}) => ({
  serviceName: "t3code-web",
  attributes: {
    "service.namespace": "t3code",
    ...releaseResourceAttributes({
      version: input.version,
      isDevelopment: input.isDevelopment,
      operatorAttributes: {},
      channel: input.releaseChannel?.trim().toLowerCase() === "preview" ? "preview" : undefined,
    }),
    "service.runtime": "t3-web",
    "t3code.client.surface": input.surface,
    "service.version": input.version,
  },
});
