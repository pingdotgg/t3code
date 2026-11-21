import * as Layer from "effect/Layer";
import * as ProviderHostLive from "../../provider/ProviderHostLive.ts";
import * as ProviderUsageLimitsIngestion from "../../provider/ProviderUsageLimitsIngestion.ts";
import * as UsageLimitSources from "../../usage/UsageLimitSources.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as AntigravityUsage from "../../provider/Drivers/AntigravityUsage.ts";
import { MuseUsageHome } from "@t3tools/provider-muse/server";
import * as CodexUsageHistory from "../../usage/CodexUsageHistory.ts";
import * as CursorAccountReader from "@t3tools/provider-cursor/server/CursorAccountReader";
import * as CursorUsageAccounts from "@t3tools/provider-cursor/server/CursorUsageAccounts";
import * as UsageService from "../../usage/UsageService.ts";
import { layerServerSettings } from "./settings.ts";

export const layerUsage = UsageService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      AntigravityUsage.layer,
      MuseUsageHome.layer,
      CodexUsageHistory.layer,
      CursorUsageAccounts.layer.pipe(Layer.provide(CursorAccountReader.layer)),
    ).pipe(Layer.provide(ProviderHostLive.layer.pipe(Layer.provide(ServerSecretStore.layer)))),
  ),
  Layer.provide(layerServerSettings),
);

export const layerUsageLimitsIngestion = ProviderUsageLimitsIngestion.layer;

export const layerUsageLimitSources = UsageLimitSources.layer;
