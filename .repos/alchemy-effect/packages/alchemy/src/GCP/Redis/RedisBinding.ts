import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as redis from "@distilled.cloud/gcp/redis_v1";
import type { Url } from "../../Redis/index.ts";
import { UrlMissing as RedisUrlMissing } from "../../Redis/index.ts";
import * as Output from "../../Output.ts";
import { bindGcpHost, type GcpIamGrant } from "../Host.ts";
import type { Instance } from "./Instance.ts";

export const REDIS_URL_ENV = "REDIS_URL";

/**
 * Shared scaffolding for Memorystore Redis RESP bindings.
 *
 * Deploy time transports only the instance's endpoint (`redis[s]://host:port`)
 * and, when AUTH is enabled, its resource name through the host's
 * RuntimeContext. The AUTH string itself never enters the host's
 * configuration: the runtime fetches it once per instance with
 * `instances.getAuthString`. That permission only exists in
 * `roles/redis.admin`, so the host is granted `roles/redis.admin` on the
 * project under an IAM Condition matching the one instance (only when AUTH
 * is enabled; otherwise `roles/redis.viewer` under the same condition).
 * `REDIS_URL` in the environment is only a fallback.
 *
 * NOT exported from `index.ts`.
 */

const redisUrlFromEnv = Config.Redacted(REDIS_URL_ENV).pipe(
  Effect.map((value) => Redacted.value(value)),
);

const endpointOf = (instance: Instance) =>
  Output.map(
    Output.all(instance.host, instance.port, instance.transitEncryptionMode),
    ([host, port, mode]) =>
      host === undefined || host.length === 0
        ? ""
        : `${mode === "SERVER_AUTHENTICATION" ? "rediss" : "redis"}://${host}:${port ?? 6379}`,
  );

/** The instance name when AUTH is enabled, else `""`. */
const authInstanceOf = (instance: Instance) =>
  Output.map(
    Output.all(instance.name, instance.authEnabled),
    ([name, authEnabled]) => (authEnabled ? name : ""),
  );

const scopedCondition = (name: string) => ({
  title: "alchemy-scoped",
  expression: `resource.name == "${name}" || resource.name.startsWith("${name}/")`,
});

const authGrantOf = (instance: Instance) =>
  Output.map(
    Output.all(instance.name, instance.authEnabled),
    ([name, authEnabled]): GcpIamGrant => ({
      role: authEnabled ? "roles/redis.admin" : "roles/redis.viewer",
      condition: scopedCondition(name),
    }),
  );

const withPassword = (endpoint: string, password: string) =>
  password.length === 0
    ? endpoint
    : endpoint.replace("://", `://:${encodeURIComponent(password)}@`);

export const makeRedisBinding = <Client>(options: {
  tag: string;
  makeClient: (url: Url) => Client;
}) =>
  Effect.gen(function* () {
    const getAuthString = yield* redis.getAuthStringProjectsLocationsInstances;
    return Effect.fn(function* (instance: Instance) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: instance,
        iam: [authGrantOf(instance)],
      });
      // A composed Output's binding key is its inspect string, which embeds
      // the mapping functions' source — and that differs between the
      // deploy-time source and the bundled runtime. Name it per instance.
      const endpoint = yield* Output.named(
        endpointOf(instance),
        `GCP_REDIS_ENDPOINT_${instance.FQN}`,
      );
      const authInstance = yield* Output.named(
        authInstanceOf(instance),
        `GCP_REDIS_AUTH_INSTANCE_${instance.FQN}`,
      );
      const missing = new RedisUrlMissing({ name: instance.LogicalId });
      // One AUTH lookup per instance for the life of the runtime; a failed
      // lookup is not cached, so the next command retries it.
      let cachedPassword: string | undefined;
      const password = Effect.suspend(() =>
        cachedPassword !== undefined
          ? Effect.succeed(cachedPassword)
          : Effect.gen(function* () {
              const name = yield* authInstance;
              const auth =
                typeof name === "string" && name.length > 0
                  ? yield* getAuthString({ name })
                  : undefined;
              cachedPassword = auth?.authString ?? "";
              return cachedPassword;
            }),
      );
      const url: Url = Effect.gen(function* () {
        const value = yield* endpoint;
        if (typeof value !== "string" || value.length === 0) {
          return yield* redisUrlFromEnv.pipe(Effect.mapError(() => missing));
        }
        const secret = yield* password.pipe(
          Effect.tapError((cause) =>
            Effect.logError(
              `Memorystore AUTH lookup failed for ${instance.LogicalId}`,
              cause,
            ),
          ),
          Effect.mapError(() => missing),
        );
        return withPassword(value, secret);
      });
      return options.makeClient(url);
    });
  });
