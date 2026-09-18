import * as AWS from "@/AWS";
import {
  cacheClusterConnectEnvPrefix,
  replicationGroupConnectEnvPrefix,
} from "@/AWS/ElastiCache";
import * as Test from "@/Test/Alchemy";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import ProvisionedCacheDataPlaneLive, {
  ProvisionedCacheDataPlaneFunction,
} from "./Provisioned.DataPlane.handler.ts";
import { shareProvisionedNetwork } from "./ProvisionedFixture.ts";

const { test, beforeAll, afterAll } = Test.make({
  providers: AWS.providers(),
});
shareProvisionedNetwork({ beforeAll, afterAll });

// A type alias so it stays comparable to `response.json`'s JsonObject.
type ConnectionProbe = {
  valkey: {
    host: string;
    port: number;
    readerHost?: string;
    readerPort?: number;
    tls: boolean;
  };
  memcached: {
    endpoints: Array<{ address: string; port: number }>;
    tls: boolean;
  };
};

test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "connects from a VPC Lambda to provisioned Valkey and Memcached",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { fn } = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* ProvisionedCacheDataPlaneFunction;
          return { fn };
        }).pipe(Effect.provide(ProvisionedCacheDataPlaneLive)),
      );
      const baseUrl = fn.functionUrl?.replace(/\/+$/, "");
      expect(baseUrl).toBeDefined();
      const config = yield* Lambda.getFunctionConfiguration({
        FunctionName: fn.functionName,
      });
      const env = config.Environment?.Variables ?? {};
      const envValue = (key: string) => {
        const value = env[key];
        return value === undefined || typeof value === "string"
          ? value
          : Redacted.value(value);
      };
      const valkeyPrefix = replicationGroupConnectEnvPrefix("Valkey");
      expect(envValue(`${valkeyPrefix}_HOST`)).toBeTruthy();
      expect(envValue(`${valkeyPrefix}_PORT`)).toBe("6379");
      expect(envValue(`${valkeyPrefix}_TLS`)).toBe("false");
      const memcachedPrefix = cacheClusterConnectEnvPrefix("Memcached");
      expect(envValue(`${memcachedPrefix}_TLS`)).toBe("false");
      expect(
        JSON.parse(envValue(`${memcachedPrefix}_ENDPOINTS`) ?? "[]"),
      ).toHaveLength(1);

      const getJson = (path: string, times: number) =>
        HttpClient.get(`${baseUrl}${path}`).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? response.json
              : response.text.pipe(
                  Effect.flatMap((body) =>
                    Effect.fail(
                      new Error(`${path} returned ${response.status}: ${body}`),
                    ),
                  ),
                ),
          ),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.fixed("3 seconds"),
              Schedule.recurs(times),
            ]),
          }),
        );

      const connection = (yield* getJson("/connection", 60)) as ConnectionProbe;
      expect(connection.valkey.host).toBeTruthy();
      expect(connection.valkey.port).toBe(6379);
      expect(connection.memcached.endpoints).toHaveLength(1);
      expect(connection.memcached.endpoints[0]?.port).toBe(11211);

      const valkey = yield* getJson("/valkey?value=hello-valkey", 10);
      expect((valkey as { value: string }).value).toBe("hello-valkey");
      const memcached = yield* getJson("/memcached?value=hello-memcached", 10);
      expect((memcached as { value: string }).value).toBe("hello-memcached");

      yield* stack.destroy();
    }),
  { timeout: 2_700_000 },
);
