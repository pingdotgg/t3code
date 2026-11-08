import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Profiles from "./CloudSandboxProfiles.ts";
import * as Store from "./CloudSandboxStore.ts";
import * as Transport from "./CloudSandboxTransport.ts";
import { make } from "./CloudSandboxManager.ts";

export const fixture = (
  failConnect = false,
  onConnect: Effect.Effect<void> = Effect.void,
  activity: { readonly active: boolean; readonly probe?: Effect.Effect<void> } = {
    active: false,
    probe: Effect.void,
  },
) => {
  let responseFor: (url: string, method: string) => Response | undefined = () => undefined;
  let beforeRequest: (url: string) => Effect.Effect<void> = () => Effect.void;
  const records = new Map<string, Store.CloudSandboxRecord>();
  const values = new Map<string, Uint8Array>();
  const spend = new Map<string, number>();
  const spentBy = new Map<string, Set<string>>();
  let connections = 0;
  let connectFails = failConnect;
  let stops = 0;
  let resumes = 0;
  let requests = 0;
  let healthChecks = 0;
  let extensions = 0;
  const extensionTtls: number[] = [];
  let state: "ready" | "stopped" = "ready";
  let healthy = true;
  let monthlyBudgetUsd: number | null = null;
  let maxConcurrentSandboxes = 100;
  let apiKey = "key";
  const authorizations: (string | undefined)[] = [];
  const connectionInputs: Transport.CloudSandboxTransportInput[] = [];
  const profiles = Profiles.CloudSandboxProfiles.of({
    list: Effect.succeed([]),
    save: () => Effect.die("not used"),
    saveStatus: () => Effect.die("not used"),
    remove: () => Effect.die("not used"),
    resolve: (profileId) =>
      Effect.succeed({
        profile: {
          profileId,
          name: "Fixture profile",
          driverKind: "boat",
          apiKeySet: true,
          defaultSize: null,
          autoStopMinutes: 15,
          template: null,
          monthlyBudgetUsd,
          maxConcurrentSandboxes,
        },
        apiKey,
      }),
    recordSpend: (profileId, resourceId, usd) =>
      Effect.sync(() => {
        const counted = spentBy.get(profileId) ?? new Set<string>();
        spentBy.set(profileId, counted);
        if (!counted.has(resourceId)) {
          counted.add(resourceId);
          spend.set(profileId, (spend.get(profileId) ?? 0) + usd);
        }
        return { period: "2025-01", usd: spend.get(profileId)!, running: 0 };
      }),
    spendOf: (profileId) =>
      Effect.succeed(
        spend.has(profileId) ? { period: "2025-01", usd: spend.get(profileId)!, running: 0 } : null,
      ),
    test: () => Effect.die("not used"),
  });
  const store = Store.CloudSandboxStore.of({
    get: (id) => Effect.sync(() => Option.fromNullishOr(records.get(id))),
    list: Effect.sync(() => [...records.values()]),
    save: (record) =>
      Effect.sync(() => {
        records.set(record.resourceId, record);
      }),
  });
  const secrets = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        values.set(name, value);
      }),
    create: (name, value) =>
      Effect.sync(() => {
        values.set(name, value);
      }),
    getOrCreateRandom: (name, length) =>
      Effect.sync(() => {
        const existing = values.get(name);
        if (existing) return existing;
        const value = new Uint8Array(length).fill(13);
        values.set(name, value);
        return value;
      }),
    remove: (name) =>
      Effect.sync(() => {
        values.delete(name);
      }),
  });
  const transport = Transport.CloudSandboxTransport.of({
    connect: (input) =>
      Effect.gen(function* () {
        connectionInputs.push(input);
        connections++;
        if (state === "stopped") {
          if (!input.allowResume)
            return yield* new Store.CloudSandboxManagerError({ reason: "transport" });
          resumes++;
          state = "ready";
        }
        healthy = true;
        yield* onConnect;
        if (connectFails) return yield* new Store.CloudSandboxManagerError({ reason: "transport" });
        return {
          httpBaseUrl: "http://child.test",
          bearerToken: "child-token",
          withConnection: () => Effect.die("not used"),
          pairingToken: "bootstrap",
          environmentId: EnvironmentId.make("child"),
          label: "Child",
        };
      }),
    disconnect: () =>
      Effect.sync(() => {
        healthy = false;
      }),
    isConnected: () =>
      Effect.sync(() => {
        healthChecks++;
        return healthy;
      }),
    withConnection: () => Effect.die("not used"),
    pairingToken: () => Effect.succeed("fresh-peer-token"),
  });
  const client = HttpClient.make((request) => {
    requests++;
    if (request.url.includes("/stop")) stops++;
    authorizations.push(request.headers.authorization);
    if (request.method === "PATCH" && request.body._tag === "Uint8Array") {
      const payload: unknown = JSON.parse(new TextDecoder().decode(request.body.body));
      if (
        typeof payload === "object" &&
        payload !== null &&
        "ttlSeconds" in payload &&
        typeof payload.ttlSeconds === "number"
      ) {
        extensionTtls.push(payload.ttlSeconds);
        if (payload.ttlSeconds > 900) extensions++;
      }
    }
    return beforeRequest(request.url).pipe(
      Effect.andThen(
        request.url.includes("/activity") ? (activity.probe ?? Effect.void) : Effect.void,
      ),
      Effect.as(
        HttpClientResponse.fromWeb(
          request,
          responseFor(request.url, request.method) ??
            Response.json(
              request.url.includes("/activity")
                ? { active: activity.active }
                : {
                    ok: true,
                    sandbox: {
                      id: "bx_23456789",
                      name: "test",
                      state: state === "stopped" ? "archived" : "ready",
                      type: "small",
                    },
                  },
            ),
        ),
      ),
    );
  });
  const manager = make.pipe(
    Effect.provideService(Store.CloudSandboxStore, store),
    Effect.provideService(Profiles.CloudSandboxProfiles, profiles),
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    Effect.provideService(Transport.CloudSandboxTransport, transport),
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provideService(
      ServerEnvironment.ServerEnvironment,
      ServerEnvironment.ServerEnvironment.of({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("controller")),
        getDescriptor: Effect.die("not used"),
      }),
    ),
  );
  return {
    manager,
    connectionInputs,
    setBudget: (usd: number | null) => {
      monthlyBudgetUsd = usd;
    },
    setMaxConcurrent: (value: number) => {
      maxConcurrentSandboxes = value;
    },
    setApiKey: (value: string) => {
      apiKey = value;
    },
    authorizations: (): readonly (string | undefined)[] => authorizations,
    setSpend: (profileId: string, usd: number) => {
      spend.set(profileId, usd);
    },
    spent: (profileId: string) => spend.get(profileId) ?? 0,
    setResponse: (hook: typeof responseFor) => {
      responseFor = hook;
    },
    setBeforeRequest: (hook: (url: string) => Effect.Effect<void>) => {
      beforeRequest = hook;
    },
    records,
    values,
    connections: () => connections,
    stops: () => stops,
    resumes: () => resumes,
    requests: () => requests,
    healthChecks: () => healthChecks,
    extensions: () => extensions,
    extensionTtls: (): readonly number[] => extensionTtls,
    setState: (value: "ready" | "stopped") => {
      state = value;
    },
    setConnectFails: (value: boolean) => {
      connectFails = value;
    },
    setHealthy: (value: boolean) => {
      healthy = value;
    },
  };
};
