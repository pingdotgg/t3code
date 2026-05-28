import { Credentials, formatHeaders } from "@distilled.cloud/cloudflare/Credentials";
import * as CloudflareWorkers from "@distilled.cloud/cloudflare/workers";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Provider from "alchemy/Provider";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { readCloudflareZone } from "./ImportedCloudflareZone.ts";

export interface WorkerCustomDomainProps {
  readonly zoneId: string;
  readonly workerName: string;
  readonly subdomain: string;
  readonly dnsApiToken: Redacted.Redacted<string>;
}

export interface WorkerCustomDomainOutput extends WorkerCustomDomainProps {
  readonly id: string;
  readonly dnsRecordId?: string;
  readonly hostname: string;
}

export type WorkerCustomDomain = Alchemy.Resource<
  "T3CodeRelay.WorkerCustomDomain",
  WorkerCustomDomainProps,
  WorkerCustomDomainOutput
>;

export const WorkerCustomDomain = Alchemy.Resource<WorkerCustomDomain>(
  "T3CodeRelay.WorkerCustomDomain",
);

export class WorkerCustomDomainError extends Data.TaggedError("WorkerCustomDomainError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const workerCustomDomainHostname = (input: {
  readonly subdomain: string;
  readonly zoneName: string;
}) => `${input.subdomain}.${input.zoneName}`;

function normalizeWorkerCustomDomainProps(input: WorkerCustomDomainProps): WorkerCustomDomainProps {
  const subdomain = input.subdomain.trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/i.test(input.zoneId)) {
    throw new Error("Cloudflare zone id must be a 32 character hex string.");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(subdomain)) {
    throw new Error("Cloudflare Worker custom domain subdomain must be a DNS label.");
  }
  if (!input.workerName.trim()) {
    throw new Error("Cloudflare Worker custom domain worker name is required.");
  }
  return {
    zoneId: input.zoneId,
    workerName: input.workerName.trim(),
    subdomain,
    dnsApiToken: input.dnsApiToken,
  };
}

function toWorkerCustomDomainOutput(input: {
  readonly id: string | null | undefined;
  readonly dnsRecordId?: string | null | undefined;
  readonly hostname: string;
  readonly props: WorkerCustomDomainProps;
}): WorkerCustomDomainOutput {
  return {
    id: input.id ?? "",
    ...(input.dnsRecordId ? { dnsRecordId: input.dnsRecordId } : {}),
    hostname: input.hostname,
    zoneId: input.props.zoneId,
    workerName: input.props.workerName,
    subdomain: input.props.subdomain,
    dnsApiToken: input.props.dnsApiToken,
  };
}

type CloudflareDnsRecord = {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly content?: string | null;
  readonly proxied?: boolean | null;
};

type CloudflareListDnsRecordsResponse = {
  readonly success: boolean;
  readonly errors?: ReadonlyArray<{ readonly message?: string }>;
  readonly result?: ReadonlyArray<CloudflareDnsRecord>;
};

type CloudflareDnsRecordResponse = {
  readonly success: boolean;
  readonly errors?: ReadonlyArray<{ readonly message?: string }>;
  readonly result?: CloudflareDnsRecord | null;
};

type CloudflareWorkerRoute = {
  readonly id: string;
  readonly pattern: string;
  readonly script?: string | null;
};

type CloudflareListWorkerRoutesResponse = {
  readonly success: boolean;
  readonly errors?: ReadonlyArray<{ readonly message?: string }>;
  readonly result?: ReadonlyArray<CloudflareWorkerRoute>;
};

type CloudflareWorkerRouteResponse = {
  readonly success: boolean;
  readonly errors?: ReadonlyArray<{ readonly message?: string }>;
  readonly result?: CloudflareWorkerRoute | null;
};

const relayDnsRecordContent = "192.0.2.1";

const routePattern = (hostname: string) => `${hostname}/*`;

function cloudflareErrorMessage(
  fallback: string,
  errors: ReadonlyArray<{ readonly message?: string }> | undefined,
) {
  return (
    errors
      ?.map((error) => error.message)
      .filter(Boolean)
      .join(", ") || fallback
  );
}

export const WorkerCustomDomainProvider = () =>
  Provider.effect(
    WorkerCustomDomain,
    Effect.gen(function* () {
      const credentialsEffect = yield* Credentials;
      const cloudflareEnvironment = yield* Cloudflare.CloudflareEnvironment;
      const listDomains = yield* CloudflareWorkers.listDomains;
      const deleteDomain = yield* CloudflareWorkers.deleteDomain;

      const readZone = (zoneId: string) =>
        Effect.gen(function* () {
          const credentials = yield* credentialsEffect;
          const zone = yield* readCloudflareZone({
            apiBaseUrl: credentials.apiBaseUrl,
            headers: formatHeaders(credentials),
            zoneId,
          });
          if (zone.accountId !== cloudflareEnvironment.accountId) {
            return yield* new WorkerCustomDomainError({
              message:
                "Cloudflare Worker custom domain zone belongs to a different account than the Alchemy Cloudflare credentials.",
            });
          }
          return zone;
        });

      const readDomainByHostname = (hostname: string) =>
        listDomains({
          accountId: cloudflareEnvironment.accountId,
          hostname,
        }).pipe(
          Effect.map((response) =>
            (response.result ?? []).find((domain) => domain.hostname === hostname),
          ),
          Effect.catch(() => Effect.void),
        );

      const requestCloudflare = <A>(
        token: Redacted.Redacted<string>,
        path: string,
        options: RequestInit,
        fallbackMessage: string,
      ) =>
        Effect.gen(function* () {
          const credentials = yield* credentialsEffect;
          const request = HttpClientRequest.make(
            (options.method ?? "GET") as "GET" | "POST" | "PUT",
          )(`${credentials.apiBaseUrl}${path}`, {
            headers: {
              authorization: `Bearer ${Redacted.value(token)}`,
              "content-type": "application/json",
              ...(options.headers as Record<string, string> | undefined),
            },
          }).pipe(
            typeof options.body === "string"
              ? HttpClientRequest.bodyText(options.body, "application/json")
              : (request) => request,
          );
          const response = yield* HttpClient.execute(request).pipe(
            Effect.mapError(
              (cause) =>
                new WorkerCustomDomainError({
                  message: fallbackMessage,
                  cause,
                }),
            ),
          );
          return yield* response.json.pipe(
            Effect.map((json) => json as A),
            Effect.mapError(
              (cause) =>
                new WorkerCustomDomainError({
                  message: fallbackMessage,
                  cause,
                }),
            ),
          );
        });

      const listDnsRecords = (token: Redacted.Redacted<string>, zoneId: string, hostname: string) =>
        requestCloudflare<CloudflareListDnsRecordsResponse>(
          token,
          `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(hostname)}`,
          { method: "GET" },
          `Failed to list Cloudflare DNS records for '${hostname}'.`,
        ).pipe(
          Effect.flatMap((json) =>
            json.success
              ? Effect.succeed(json.result ?? [])
              : Effect.fail(
                  new WorkerCustomDomainError({
                    message: cloudflareErrorMessage(
                      `Failed to list Cloudflare DNS records for '${hostname}'.`,
                      json.errors,
                    ),
                  }),
                ),
          ),
        );

      const createDnsRecord = (props: WorkerCustomDomainProps, hostname: string) =>
        requestCloudflare<CloudflareDnsRecordResponse>(
          props.dnsApiToken,
          `/zones/${props.zoneId}/dns_records`,
          {
            method: "POST",
            body: JSON.stringify({
              name: hostname,
              type: "A",
              content: relayDnsRecordContent,
              ttl: 1,
              proxied: true,
              comment: "Managed by Alchemy for T3 Code Relay Worker domain.",
            }),
          },
          `Failed to create Cloudflare DNS record for '${hostname}'.`,
        ).pipe(
          Effect.flatMap((json) =>
            json.success && json.result?.id
              ? Effect.succeed(json.result)
              : Effect.fail(
                  new WorkerCustomDomainError({
                    message: cloudflareErrorMessage(
                      `Failed to create Cloudflare DNS record for '${hostname}'.`,
                      json.errors,
                    ),
                  }),
                ),
          ),
        );

      const updateDnsRecord = (
        props: WorkerCustomDomainProps,
        hostname: string,
        dnsRecordId: string,
      ) =>
        requestCloudflare<CloudflareDnsRecordResponse>(
          props.dnsApiToken,
          `/zones/${props.zoneId}/dns_records/${dnsRecordId}`,
          {
            method: "PUT",
            body: JSON.stringify({
              name: hostname,
              type: "A",
              content: relayDnsRecordContent,
              ttl: 1,
              proxied: true,
              comment: "Managed by Alchemy for T3 Code Relay Worker domain.",
            }),
          },
          `Failed to update Cloudflare DNS record for '${hostname}'.`,
        ).pipe(
          Effect.flatMap((json) =>
            json.success && json.result?.id
              ? Effect.succeed(json.result)
              : Effect.fail(
                  new WorkerCustomDomainError({
                    message: cloudflareErrorMessage(
                      `Failed to update Cloudflare DNS record for '${hostname}'.`,
                      json.errors,
                    ),
                  }),
                ),
          ),
        );

      const ensureDnsRecord = (props: WorkerCustomDomainProps, hostname: string) =>
        Effect.gen(function* () {
          const records = yield* listDnsRecords(props.dnsApiToken, props.zoneId, hostname);
          const record = records.find((candidate) => candidate.name === hostname);
          if (!record) {
            return yield* createDnsRecord(props, hostname);
          }
          if (record.content !== relayDnsRecordContent || record.proxied !== true) {
            return yield* updateDnsRecord(props, hostname, record.id);
          }
          return record;
        });

      const deleteDnsRecord = (props: WorkerCustomDomainOutput) =>
        Effect.gen(function* () {
          const dnsRecordId = props.dnsRecordId;
          if (!dnsRecordId) return;
          const credentials = yield* credentialsEffect;
          yield* HttpClient.del(
            `${credentials.apiBaseUrl}/zones/${props.zoneId}/dns_records/${dnsRecordId}`,
            {
              headers: formatHeaders(credentials),
            },
          ).pipe(
            Effect.mapError(
              (cause) =>
                new WorkerCustomDomainError({
                  message: `Failed to delete Cloudflare DNS record for '${props.hostname}'.`,
                  cause,
                }),
            ),
          );
        });

      const listRoutes = (props: WorkerCustomDomainProps) =>
        requestCloudflare<CloudflareListWorkerRoutesResponse>(
          props.dnsApiToken,
          `/zones/${props.zoneId}/workers/routes`,
          { method: "GET" },
          `Failed to list Cloudflare Worker routes for '${props.workerName}'.`,
        ).pipe(
          Effect.flatMap((json) =>
            json.success
              ? Effect.succeed(json.result ?? [])
              : Effect.fail(
                  new WorkerCustomDomainError({
                    message: cloudflareErrorMessage(
                      `Failed to list Cloudflare Worker routes for '${props.workerName}'.`,
                      json.errors,
                    ),
                  }),
                ),
          ),
        );

      const createRoute = (props: WorkerCustomDomainProps, hostname: string) =>
        requestCloudflare<CloudflareWorkerRouteResponse>(
          props.dnsApiToken,
          `/zones/${props.zoneId}/workers/routes`,
          {
            method: "POST",
            body: JSON.stringify({
              pattern: routePattern(hostname),
              script: props.workerName,
            }),
          },
          `Failed to create Cloudflare Worker route for '${hostname}'.`,
        ).pipe(
          Effect.flatMap((json) =>
            json.success && json.result?.id
              ? Effect.succeed(json.result)
              : Effect.fail(
                  new WorkerCustomDomainError({
                    message: cloudflareErrorMessage(
                      `Failed to create Cloudflare Worker route for '${hostname}'.`,
                      json.errors,
                    ),
                  }),
                ),
          ),
        );

      const updateRoute = (props: WorkerCustomDomainProps, hostname: string, routeId: string) =>
        requestCloudflare<CloudflareWorkerRouteResponse>(
          props.dnsApiToken,
          `/zones/${props.zoneId}/workers/routes/${routeId}`,
          {
            method: "PUT",
            body: JSON.stringify({
              pattern: routePattern(hostname),
              script: props.workerName,
            }),
          },
          `Failed to update Cloudflare Worker route for '${hostname}'.`,
        ).pipe(
          Effect.flatMap((json) =>
            json.success && json.result?.id
              ? Effect.succeed(json.result)
              : Effect.fail(
                  new WorkerCustomDomainError({
                    message: cloudflareErrorMessage(
                      `Failed to update Cloudflare Worker route for '${hostname}'.`,
                      json.errors,
                    ),
                  }),
                ),
          ),
        );

      const ensureRoute = (props: WorkerCustomDomainProps, hostname: string) =>
        Effect.gen(function* () {
          const pattern = routePattern(hostname);
          const routes = yield* listRoutes(props);
          const route = routes.find((candidate) => candidate.pattern === pattern);
          if (!route) {
            return yield* createRoute(props, hostname);
          }
          if (route.script !== props.workerName) {
            return yield* updateRoute(props, hostname, route.id);
          }
          return route;
        });

      const deleteRoute = (props: WorkerCustomDomainOutput) =>
        requestCloudflare<CloudflareWorkerRouteResponse>(
          props.dnsApiToken,
          `/zones/${props.zoneId}/workers/routes/${props.id}`,
          { method: "DELETE" },
          `Failed to delete Cloudflare Worker route for '${props.hostname}'.`,
        ).pipe(Effect.catch(() => Effect.void));

      return {
        stables: ["zoneId", "hostname", "workerName"],
        diff: ({ output }) =>
          Effect.succeed(
            output && !output.dnsRecordId ? ({ action: "update" } as const) : undefined,
          ),
        reconcile: Effect.fn(function* ({ news }) {
          const props = normalizeWorkerCustomDomainProps(news);
          const zone = yield* readZone(props.zoneId);
          const hostname = workerCustomDomainHostname({
            subdomain: props.subdomain,
            zoneName: zone.name,
          });
          const existing = yield* readDomainByHostname(hostname);

          if (existing?.service && existing.service !== props.workerName) {
            return yield* new WorkerCustomDomainError({
              message: `Cloudflare Worker custom domain '${hostname}' is already attached to Worker '${existing.service}'.`,
            });
          }

          if (existing?.id) {
            yield* deleteDomain({
              accountId: cloudflareEnvironment.accountId,
              domainId: existing.id,
            }).pipe(Effect.catchTag("DomainNotFound", () => Effect.void));
          }
          const dnsRecord = yield* ensureDnsRecord(props, hostname);
          const route = yield* ensureRoute(props, hostname);
          return toWorkerCustomDomainOutput({
            id: route.id,
            dnsRecordId: dnsRecord.id,
            hostname,
            props,
          });
        }),
        delete: Effect.fn(function* ({ output }) {
          if (!output?.id) return;
          yield* deleteRoute(output);
          yield* deleteDnsRecord(output);
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.hostname) return undefined;
          const records = yield* listDnsRecords(output.dnsApiToken, output.zoneId, output.hostname);
          const dnsRecord = records.find((candidate) => candidate.name === output.hostname);
          const routes = yield* listRoutes(output);
          const route = routes.find(
            (candidate) =>
              candidate.id === output.id || candidate.pattern === routePattern(output.hostname),
          );
          if (
            !dnsRecord?.id ||
            dnsRecord.content !== relayDnsRecordContent ||
            dnsRecord.proxied !== true ||
            !route?.id ||
            route.script !== output.workerName
          ) {
            return undefined;
          }
          return toWorkerCustomDomainOutput({
            id: route.id,
            dnsRecordId: dnsRecord?.id,
            hostname: output.hostname,
            props: {
              zoneId: output.zoneId,
              workerName: output.workerName,
              subdomain: output.subdomain,
              dnsApiToken: output.dnsApiToken,
            },
          });
        }),
      };
    }),
  );
