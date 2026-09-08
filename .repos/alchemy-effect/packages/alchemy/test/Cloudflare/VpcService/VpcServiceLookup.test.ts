import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const asyncWorkerScript = `export default {
  async fetch() {
    return new Response("ok");
  },
};
`;

// Declares the tunnel + VPC service. Yielded in both deploys (same logical
// ids), so the first deploy creates them and the second is a no-op reconcile
// that keeps them alive while the worker binds.
const vpcService = Effect.gen(function* () {
  const tunnel = yield* Cloudflare.Tunnel.Tunnel("RefTunnel", {
    ingress: [{ service: "http://localhost:8080" }],
    adopt: true,
  });
  return yield* Cloudflare.VpcService.VpcService("RefSvc", {
    httpPort: 8080,
    host: {
      hostname: "localhost",
      resolverNetwork: { tunnelId: tunnel.tunnelId },
    },
    adopt: true,
  });
});

// Read the worker's live `vpc_service` bindings out-of-band from the script
// settings API.
const readVpcBindings = (scriptName: string) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const settings = yield* workers.getScriptScriptAndVersionSetting({
      accountId,
      scriptName,
    });
    return (settings.bindings ?? []).filter(
      (b): b is Extract<typeof b, { type: "vpc_service" }> =>
        b.type === "vpc_service",
    );
  });

test.provider(
  "looks up a vpc service by id/name and binds it to a worker",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create a real VPC service to look up.
      const svc = yield* stack.deploy(vpcService);

      // Bind the service to a worker three ways — the managed resource
      // directly, and `lookup` data sources by id and by name. All emit a
      // `vpc_service` binding. The lookups are also returned as stack
      // outputs, pinning plan-time Output resolution. The service and its
      // tunnel are re-declared so they stay deployed.
      const { byId, byName, worker } = yield* stack.deploy(
        Effect.gen(function* () {
          const managed = yield* vpcService;
          const worker = yield* Cloudflare.Worker("vpc-binding-worker", {
            script: asyncWorkerScript,
            env: {
              SVC_MANAGED: managed,
              SVC_BY_ID: Cloudflare.VpcService.lookup({
                serviceId: svc.serviceId,
              }),
              SVC_BY_NAME: Cloudflare.VpcService.lookup({
                name: svc.serviceName,
              }),
            },
          });
          return {
            byId: Cloudflare.VpcService.lookup({ serviceId: svc.serviceId }),
            byName: Cloudflare.VpcService.lookup({ name: svc.serviceName }),
            worker,
          };
        }),
      );

      // The data source resolves to the service's attributes.
      expect(byId.serviceId).toEqual(svc.serviceId);
      expect(byName.serviceId).toEqual(svc.serviceId);
      expect(byName.serviceName).toEqual(svc.serviceName);
      expect(byName.httpPort).toEqual(svc.httpPort);

      const vpc = yield* readVpcBindings(worker.workerName);
      expect(vpc.find((b) => b.name === "SVC_MANAGED")?.serviceId).toEqual(
        svc.serviceId,
      );
      expect(vpc.find((b) => b.name === "SVC_BY_ID")?.serviceId).toEqual(
        svc.serviceId,
      );
      expect(vpc.find((b) => b.name === "SVC_BY_NAME")?.serviceId).toEqual(
        svc.serviceId,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
