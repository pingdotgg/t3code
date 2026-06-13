import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("reference vpc service by name and by id", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const service = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel("RefTunnel", {
          ingress: [{ service: "http://localhost:8080" }],
          adopt: true,
        });
        return yield* Cloudflare.VpcService("RefSvc", {
          httpPort: 8080,
          host: {
            hostname: "localhost",
            resolverNetwork: { tunnelId: tunnel.tunnelId },
          },
          adopt: true,
        });
      }),
    );

    const refByName = yield* Cloudflare.VpcServiceRef({
      name: service.serviceName,
    });
    expect(refByName.serviceId).toEqual(service.serviceId);
    expect(refByName.serviceName).toEqual(service.serviceName);
    expect(refByName.httpPort).toEqual(service.httpPort);

    const refById = yield* Cloudflare.VpcServiceRef({
      serviceId: service.serviceId,
    });
    expect(refById.serviceId).toEqual(service.serviceId);
    expect(refById.serviceName).toEqual(service.serviceName);

    yield* stack.destroy();
  }).pipe(logLevel),
);
