import { AtlassianIntegrationProvider, type JiraApiAuth } from "@t3tools/integrations-atlassian";
import { MockIntegrationProvider } from "@t3tools/integrations-core/mock";
import type { IntegrationAccountRef } from "@t3tools/integrations-core";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { HttpRouter } from "effect/unstable/http";
import {
  type BasicConnectInput,
  type OAuthConnectInput,
  loadPersistedAuths,
  providerForAccount,
  providerForPersistedAuths,
  replaceAtlassianAuths,
  savePersistedAuths,
} from "./t3work-atlassian-auth-store.ts";
import {
  T3workAtlassianError,
  errorResponse,
  okJson,
  readJsonBody,
  tryAtlassianPromise,
} from "./t3work-atlassian-http.ts";
export { t3workAtlassianAssetContentRouteLayer } from "./t3work-atlassian-asset-content-route.ts";
export { t3workAtlassianBacklogRouteLayer } from "./t3work-atlassian-backlog-routes.ts";
export { t3workAtlassianResourcesRouteLayer } from "./t3work-atlassian-resources-routes.ts";

type ResourceGetInput = {
  readonly accountId: string;
  readonly ref: unknown;
};

type AssetGetInput = {
  readonly accountId: string;
  readonly url: string;
};

const mockProvider = new MockIntegrationProvider();

export const t3workAtlassianConnectBasicRouteLayer = HttpRouter.add(
  "POST",
  "/api/t3work/atlassian/connect/basic",
  Effect.gen(function* () {
    yield* loadPersistedAuths;
    const input = yield* readJsonBody<BasicConnectInput>();

    if (!input.auth.apiToken.trim()) {
      return okJson({
        accounts: yield* tryAtlassianPromise(
          () => mockProvider.listAccounts(),
          "Failed to load preview Atlassian accounts.",
        ),
      });
    }

    const provider = new AtlassianIntegrationProvider(input.auth);
    const accounts = yield* tryAtlassianPromise(
      () => provider.listAccounts(),
      "Failed to connect to Atlassian.",
    );
    replaceAtlassianAuths(accounts.map((account) => ({ accountId: account.id, auth: input.auth })));
    yield* savePersistedAuths;
    return okJson({ accounts });
  }).pipe(Effect.catch(errorResponse)),
);

export const t3workAtlassianAccountsRouteLayer = HttpRouter.add(
  "POST",
  "/api/t3work/atlassian/accounts",
  Effect.gen(function* () {
    const provider = yield* providerForPersistedAuths();
    if (!provider) {
      return okJson({ accounts: [] });
    }
    const accounts = yield* tryAtlassianPromise(
      () => provider.listAccounts(),
      "Failed to load persisted Atlassian accounts.",
    );
    return okJson({ accounts });
  }).pipe(Effect.catch(errorResponse)),
);

export const t3workAtlassianConnectOAuthRouteLayer = HttpRouter.add(
  "POST",
  "/api/t3work/atlassian/connect/oauth",
  Effect.gen(function* () {
    yield* loadPersistedAuths;
    const input = yield* readJsonBody<OAuthConnectInput>();
    if (!input.auth.token.refreshToken?.trim()) {
      return yield* new T3workAtlassianError({
        message:
          "Atlassian OAuth did not return a refresh token. Reconnect Atlassian and approve offline access.",
      });
    }
    const now = yield* Clock.currentTimeMillis;
    const expiresAt = now + input.auth.token.expiresIn * 1000;
    const auths: ReadonlyArray<JiraApiAuth> = input.auth.sites.map((site) => ({
      kind: "oauth",
      cloudId: site.id,
      siteUrl: site.url,
      accessToken: input.auth.token.accessToken,
      refreshToken: input.auth.token.refreshToken,
      expiresAt,
    }));

    if (auths.length === 0) {
      return okJson({
        accounts: yield* tryAtlassianPromise(
          () => mockProvider.listAccounts(),
          "Failed to load preview Atlassian accounts.",
        ),
      });
    }

    const provider = AtlassianIntegrationProvider.fromMultipleAuths(auths);
    const accounts = yield* tryAtlassianPromise(
      () => provider.listAccounts(),
      "Failed to connect to Atlassian.",
    );
    replaceAtlassianAuths(
      accounts.flatMap((account) => {
        const auth = auths.find(
          (candidate) => candidate.kind === "oauth" && candidate.cloudId === account.id,
        );
        return auth ? [{ accountId: account.id, auth }] : [];
      }),
    );
    yield* savePersistedAuths;
    return okJson({ accounts });
  }).pipe(Effect.catch(errorResponse)),
);

export const t3workAtlassianProjectsRouteLayer = HttpRouter.add(
  "POST",
  "/api/t3work/atlassian/projects",
  Effect.gen(function* () {
    const account = yield* readJsonBody<IntegrationAccountRef>();
    const provider = yield* providerForAccount(account.id);
    const projects = yield* tryAtlassianPromise(
      () => provider.listProjects(account),
      "Failed to load Atlassian projects.",
    );
    return okJson({ projects });
  }).pipe(Effect.catch(errorResponse)),
);

export const t3workAtlassianResourceRouteLayer = HttpRouter.add(
  "POST",
  "/api/t3work/atlassian/resource",
  Effect.gen(function* () {
    const input = yield* readJsonBody<ResourceGetInput>();
    const provider = yield* providerForAccount(input.accountId);
    const snapshot = yield* tryAtlassianPromise(
      () => provider.getResource(input.ref),
      "Failed to load Atlassian issue.",
    );
    return okJson({ snapshot });
  }).pipe(Effect.catch(errorResponse)),
);

export const t3workAtlassianAssetRouteLayer = HttpRouter.add(
  "POST",
  "/api/t3work/atlassian/asset",
  Effect.gen(function* () {
    const input = yield* readJsonBody<AssetGetInput>();
    const provider = yield* providerForAccount(input.accountId);
    const asset = yield* tryAtlassianPromise(
      () => provider.downloadAsset(input.url),
      "Failed to download Atlassian asset.",
    );
    return okJson({
      asset: {
        base64Contents: Buffer.from(asset.bytes).toString("base64"),
        sizeBytes: asset.bytes.byteLength,
        ...(asset.mimeType ? { mimeType: asset.mimeType } : {}),
      },
    });
  }).pipe(Effect.catch(errorResponse)),
);
