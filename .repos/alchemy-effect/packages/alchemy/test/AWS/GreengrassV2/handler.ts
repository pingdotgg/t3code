import * as GreengrassV2 from "@/AWS/GreengrassV2";
import { Thing } from "@/AWS/IoT";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export const COMPONENT_NAME = "com.alchemy.test.GgBindings";
export const COMPONENT_VERSION = "1.0.0";

const recipe = JSON.stringify({
  RecipeFormatVersion: "2020-01-25",
  ComponentName: COMPONENT_NAME,
  ComponentVersion: COMPONENT_VERSION,
  ComponentDescription: "Alchemy GreengrassV2 bindings fixture component",
  ComponentPublisher: "Alchemy",
  Manifests: [
    {
      Platform: { os: "linux" },
      Lifecycle: { run: "echo greengrass bindings fixture" },
    },
  ],
});

// A core device thing name that never exists — used to prove the
// core-device bindings' IAM + request plumbing via typed not-found errors.
const MISSING_CORE = "alchemy-gg-bindings-missing-core";

export class GreengrassTestFunction extends Lambda.Function<Lambda.Function>()(
  "GreengrassTestFunction",
) {}

/**
 * Collapse a typed call into `{ ok: true }` or `{ ok: false, tag }`.
 * Failures are logged (visible in CloudWatch) so unexpected tags are
 * diagnosable without redeploying.
 */
const probe = <A, E extends { readonly _tag: string }>(
  self: Effect.Effect<A, E>,
) =>
  self.pipe(
    Effect.map(() => ({ ok: true as const })),
    Effect.catch((error) =>
      Effect.logWarning(`probe failed: ${String(error)}`).pipe(
        Effect.map(() => ({ ok: false as const, tag: error._tag })),
      ),
    ),
  );

export default GreengrassTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The component version + deployment the scoped bindings are bound to.
    // The deployment targets an IoT thing with no live core device, so it
    // stays ACTIVE in the cloud and never installs anything.
    const component = yield* GreengrassV2.ComponentVersion("BindingComponent", {
      recipe,
    });
    const core = yield* Thing("GgBindingCore", {});
    const deployment = yield* GreengrassV2.Deployment("BindingRollout", {
      targetArn: core.thingArn,
      components: {
        [COMPONENT_NAME]: { componentVersion: component.componentVersion },
      },
    });

    // Event source: subscribe the host to Greengrass status events. The
    // deploy proves the EventBridge rule + invoke permission wiring.
    yield* GreengrassV2.consumeGreengrassEvents(
      { kinds: ["deployment-status", "component-status"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `greengrass event: ${event["detail-type"]} on ${event.detail.coreDeviceThingName}`,
          ),
        ),
    );

    // Component-version-scoped bindings.
    const getComponent = yield* GreengrassV2.GetComponent(component);
    const describeComponent = yield* GreengrassV2.DescribeComponent(component);
    const getArtifact =
      yield* GreengrassV2.GetComponentVersionArtifact(component);

    // Deployment-scoped bindings.
    const getDeployment = yield* GreengrassV2.GetDeployment(deployment);
    const cancelDeployment = yield* GreengrassV2.CancelDeployment(deployment);

    // Account-level bindings.
    const listComponents = yield* GreengrassV2.ListComponents();
    const listComponentVersions = yield* GreengrassV2.ListComponentVersions();
    const listDeployments = yield* GreengrassV2.ListDeployments();
    const listCoreDevices = yield* GreengrassV2.ListCoreDevices();
    const getCoreDevice = yield* GreengrassV2.GetCoreDevice();
    const deleteCoreDevice = yield* GreengrassV2.DeleteCoreDevice();
    const listInstalledComponents =
      yield* GreengrassV2.ListInstalledComponents();
    const listEffectiveDeployments =
      yield* GreengrassV2.ListEffectiveDeployments();
    const listClientDevices =
      yield* GreengrassV2.ListClientDevicesAssociatedWithCoreDevice();
    const associateClientDevices =
      yield* GreengrassV2.BatchAssociateClientDeviceWithCoreDevice();
    const disassociateClientDevices =
      yield* GreengrassV2.BatchDisassociateClientDeviceFromCoreDevice();
    const getConnectivityInfo = yield* GreengrassV2.GetConnectivityInfo();
    const updateConnectivityInfo = yield* GreengrassV2.UpdateConnectivityInfo();
    const resolveComponentCandidates =
      yield* GreengrassV2.ResolveComponentCandidates();

    const bound = {
      getComponent,
      describeComponent,
      getArtifact,
      getDeployment,
      cancelDeployment,
      listComponents,
      listComponentVersions,
      listDeployments,
      listCoreDevices,
      getCoreDevice,
      deleteCoreDevice,
      listInstalledComponents,
      listEffectiveDeployments,
      listClientDevices,
      associateClientDevices,
      disassociateClientDevices,
      getConnectivityInfo,
      updateConnectivityInfo,
      resolveComponentCandidates,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        // Component-scoped read: the component version ARN is injected.
        if (request.method === "GET" && pathname === "/component") {
          const metadata = yield* describeComponent();
          return yield* HttpServerResponse.json({
            arn: metadata.arn,
            componentName: metadata.componentName,
            componentVersion: metadata.componentVersion,
            state: metadata.status?.componentState,
          });
        }

        // Fetch the raw recipe and prove it round-trips.
        if (request.method === "GET" && pathname === "/recipe") {
          const { recipe: bytes, recipeOutputFormat } = yield* getComponent({
            recipeOutputFormat: "JSON",
          });
          const text = yield* Effect.sync(() =>
            new TextDecoder().decode(bytes),
          );
          return yield* HttpServerResponse.json({
            recipeOutputFormat,
            hasName: text.includes(COMPONENT_NAME),
          });
        }

        // The fixture component has no artifacts — the typed error proves
        // IAM + request plumbing end-to-end.
        if (request.method === "GET" && pathname === "/artifact") {
          const result = yield* probe(
            getArtifact({ artifactName: "missing.zip" }),
          );
          return yield* HttpServerResponse.json(result);
        }

        // Deployment-scoped read: the deployment id is injected.
        if (request.method === "GET" && pathname === "/deployment") {
          const detail = yield* getDeployment();
          return yield* HttpServerResponse.json({
            deploymentId: detail.deploymentId,
            deploymentStatus: detail.deploymentStatus,
            targetArn: detail.targetArn,
            isLatestForTarget: detail.isLatestForTarget,
          });
        }

        // Account-level list, must include the fixture's deployment.
        if (request.method === "GET" && pathname === "/deployments") {
          const { deployments } = yield* listDeployments({
            historyFilter: "LATEST_ONLY",
          });
          return yield* HttpServerResponse.json({
            ids: (deployments ?? []).flatMap((d) =>
              d.deploymentId === undefined ? [] : [d.deploymentId],
            ),
          });
        }

        // Account-level list, must include the fixture's component.
        if (request.method === "GET" && pathname === "/components") {
          const { components } = yield* listComponents({ scope: "PRIVATE" });
          return yield* HttpServerResponse.json({
            names: (components ?? []).flatMap((c) =>
              c.componentName === undefined ? [] : [c.componentName],
            ),
          });
        }

        // List the fixture component's versions via its base ARN (derived
        // at runtime from the version ARN).
        if (request.method === "GET" && pathname === "/component-versions") {
          const metadata = yield* describeComponent();
          const baseArn = (metadata.arn ?? "").split(":versions:")[0]!;
          const { componentVersions } = yield* listComponentVersions({
            arn: baseArn,
          });
          return yield* HttpServerResponse.json({
            versions: (componentVersions ?? []).flatMap((v) =>
              v.componentVersion === undefined ? [] : [v.componentVersion],
            ),
          });
        }

        // Account-level list of core devices (usually empty in CI).
        if (request.method === "GET" && pathname === "/core-devices") {
          const { coreDevices } = yield* listCoreDevices();
          return yield* HttpServerResponse.json({
            count: (coreDevices ?? []).length,
          });
        }

        // Core-device bindings probed against a thing name that never
        // exists: typed not-found (never AccessDenied) proves IAM works.
        if (request.method === "GET" && pathname === "/core-device-probes") {
          const req = { coreDeviceThingName: MISSING_CORE };
          return yield* HttpServerResponse.json({
            getCoreDevice: yield* probe(getCoreDevice(req)),
            deleteCoreDevice: yield* probe(deleteCoreDevice(req)),
            listInstalledComponents: yield* probe(listInstalledComponents(req)),
            listEffectiveDeployments: yield* probe(
              listEffectiveDeployments(req),
            ),
            listClientDevices: yield* probe(listClientDevices(req)),
            associateClientDevices: yield* probe(
              associateClientDevices({
                ...req,
                entries: [{ thingName: "alchemy-gg-bindings-client" }],
              }),
            ),
            disassociateClientDevices: yield* probe(
              disassociateClientDevices({
                ...req,
                entries: [{ thingName: "alchemy-gg-bindings-client" }],
              }),
            ),
          });
        }

        // Real write+read on the fixture thing's connectivity info (the
        // thing exists; no live core device is required).
        if (request.method === "POST" && pathname === "/connectivity") {
          const detail = yield* getDeployment();
          const thingName = (detail.targetArn ?? "").split("/").pop()!;
          yield* updateConnectivityInfo({
            thingName,
            connectivityInfo: [
              { id: "fixture", hostAddress: "127.0.0.1", portNumber: 8883 },
            ],
          });
          const { connectivityInfo } = yield* getConnectivityInfo({
            thingName,
          });
          return yield* HttpServerResponse.json({
            hostAddresses: (connectivityInfo ?? []).flatMap((info) =>
              info.hostAddress === undefined ? [] : [info.hostAddress],
            ),
          });
        }

        // Dependency resolution against the fixture component.
        if (request.method === "GET" && pathname === "/resolve") {
          const result = yield* resolveComponentCandidates({
            platform: {
              attributes: { os: "linux", architecture: "amd64" },
            },
            componentCandidates: [
              {
                componentName: COMPONENT_NAME,
                versionRequirements: { fixture: `=${COMPONENT_VERSION}` },
              },
            ],
          }).pipe(
            Effect.map((response) => ({
              ok: true as const,
              names: (response.resolvedComponentVersions ?? []).flatMap((v) =>
                v.componentName === undefined ? [] : [v.componentName],
              ),
            })),
            Effect.catch((error) =>
              Effect.logWarning(`resolve failed: ${String(error)}`).pipe(
                Effect.map(() => ({
                  ok: false as const,
                  names: [] as string[],
                  tag: error._tag,
                })),
              ),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // Deployment-scoped write: cancel the fixture rollout (called last).
        if (request.method === "POST" && pathname === "/cancel-deployment") {
          const result = yield* probe(cancelDeployment());
          return yield* HttpServerResponse.json(result);
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.EventSource,
        GreengrassV2.GetComponentHttp,
        GreengrassV2.DescribeComponentHttp,
        GreengrassV2.GetComponentVersionArtifactHttp,
        GreengrassV2.GetDeploymentHttp,
        GreengrassV2.CancelDeploymentHttp,
        GreengrassV2.ListComponentsHttp,
        GreengrassV2.ListComponentVersionsHttp,
        GreengrassV2.ListDeploymentsHttp,
        GreengrassV2.ListCoreDevicesHttp,
        GreengrassV2.GetCoreDeviceHttp,
        GreengrassV2.DeleteCoreDeviceHttp,
        GreengrassV2.ListInstalledComponentsHttp,
        GreengrassV2.ListEffectiveDeploymentsHttp,
        GreengrassV2.ListClientDevicesAssociatedWithCoreDeviceHttp,
        GreengrassV2.BatchAssociateClientDeviceWithCoreDeviceHttp,
        GreengrassV2.BatchDisassociateClientDeviceFromCoreDeviceHttp,
        GreengrassV2.GetConnectivityInfoHttp,
        GreengrassV2.UpdateConnectivityInfoHttp,
        GreengrassV2.ResolveComponentCandidatesHttp,
      ),
    ),
  ),
);
