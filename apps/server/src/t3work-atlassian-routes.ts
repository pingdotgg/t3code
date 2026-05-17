import { AtlassianIntegrationProvider, type JiraApiAuth } from "@t3tools/integrations-atlassian";
import { MockIntegrationProvider } from "@t3tools/integrations-core/mock";
import type { IntegrationAccountRef } from "@t3tools/integrations-core";
import * as Effect from "effect/Effect";
import { HttpRouter } from "effect/unstable/http";
import {
  type BasicConnectInput,
  type OAuthConnectInput,
  loadPersistedAuths,
  providerForAccount,
  providerForPersistedAuths,
  savePersistedAuths,
  setAtlassianAuth,
} from "./t3work-atlassian-auth-store.ts";
import {
  errorResponse,
  okJson,
  readJsonBody,
  tryAtlassianPromise,
} from "./t3work-atlassian-http.ts";

type ResourceListInput = {
  readonly account: IntegrationAccountRef;
  readonly externalProjectId: string;
  readonly limit?: number;
};

type ResourceGetInput = {
  readonly accountId: string;
  readonly ref: unknown;
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
    for (const account of accounts) {
      setAtlassianAuth(account.id, input.auth);
    }
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
    const auths: ReadonlyArray<JiraApiAuth> = input.auth.sites.map((site) => ({
      kind: "oauth",
      cloudId: site.id,
      accessToken: input.auth.token.accessToken,
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
    for (const account of accounts) {
      const auth = auths.find(
        (candidate) => candidate.kind === "oauth" && candidate.cloudId === account.id,
      );
      if (auth) {
        setAtlassianAuth(account.id, auth);
      }
    }
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

export const t3workAtlassianResourcesRouteLayer = HttpRouter.add(
  "POST",
  "/api/t3work/atlassian/resources",
  Effect.gen(function* () {
    const input = yield* readJsonBody<ResourceListInput>();
    const provider = yield* providerForAccount(input.account.id);
    const page = yield* tryAtlassianPromise(
      () =>
        provider.listResources({
          account: input.account,
          externalProjectId: input.externalProjectId,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        }),
      "Failed to load Atlassian issues.",
    );
    return okJson({ page });
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
