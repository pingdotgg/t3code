import { type DeviceHostSummary, type EasDeviceHostConfig, type DevicePlatform } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as DeviceHost from "./DeviceHost.ts";
import { findEasProjectId } from "./easProjectId.ts";
import { PLATFORMS, type RunningSession, decodePathSegment, resolveSavedExpoCredential } from "./EasDeviceHost-part2.ts";

export const makeEasHostSurfaces = (deps: {
  readonly sessions: Map<string, RunningSession>;
  readonly secrets: SecretResolver.SecretResolver["Service"];
  readonly config: EasDeviceHostConfig;
  readonly services: Context.Context<
    FileSystem.FileSystem | Path.Path | Effect.Services<ReturnType<typeof findEasProjectId>>
  >;
  readonly hostId: string;
}) => {
  const { sessions, secrets, config, services, hostId } = deps;
  const upstream: NonNullable<DeviceHost.DeviceHostReady["upstream"]> = (hubPath, search) =>
    Effect.sync(() => {
      const platform = (["ios", "android"] as const).find((candidate) =>
        hubPath.startsWith(`${PLATFORMS[candidate].hubPrefix}/`),
      );
      if (!platform) return null;
      const helper = /^\/vendor\/serve-sim\/helper\/([^/]+)\//.exec(hubPath);
      const deviceId = helper ? decodePathSegment(helper[1]!) : search.get("device");
      if (helper && deviceId === null) return null;
      const session =
        deviceId !== null
          ? sessions.get(deviceId)
          : sessions.size === 1
            ? [...sessions.values()][0]
            : undefined;
      if (session?.platform !== platform) return null;
      const { hubPrefix, previewPrefix, protocol } = PLATFORMS[platform];
      const path = helper
        ? `/helper/${encodeURIComponent(session.remoteDeviceId)}${hubPath.slice(helper[0].length - 1)}`
        : `${previewPrefix}${hubPath.slice(hubPrefix.length)}`;
      const params = new URLSearchParams(search);
      if (params.has("device")) params.set("device", session.remoteDeviceId);
      const query = params.size > 0 ? `?${params.toString()}` : "";
      const token = Redacted.value(session.preview.token);
      return {
        url: `${session.preview.origin}${path}${query}`,
        headers: { authorization: `Bearer ${token}` },
        protocols: [`${protocol}.token.${token}`],
      };
    });

  // Each server signs in on its own, so one with no Expo credential answers for itself. Reading
  // the credential is local; whether Expo accepts it is only known once a session starts.
  const platformAvailability = (platform: DevicePlatform) =>
    resolveSavedExpoCredential(secrets, config.accessToken).pipe(
      Effect.provide(services),
      Effect.as({ platform, available: true }),
      Effect.catch((error) =>
        Effect.succeed({ platform, available: false, reason: error.message }),
      ),
    );

  const summary: Effect.Effect<DeviceHostSummary> = Effect.all([
    platformAvailability("ios"),
    platformAvailability("android"),
  ]).pipe(
    Effect.map((platforms) => ({
      id: hostId,
      label: config.label,
      kind: "eas" as const,
      platforms,
      // Nothing to install: the hub and agent-device daemon run in each session.
      hubInstalled: true,
      agentDeviceInstalled: true,
    })),
  );


  return { upstream, platformAvailability, summary };
};
