import * as ControlTower from "@/AWS/ControlTower";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// A well-formed-but-nonexistent operation id — drives the typed error paths
// for the operation-status bindings (proving the IAM grant + typed union;
// an IAM gap would surface AccessDeniedException instead).
const NONEXISTENT_OPERATION_ID = "00000000-0000-0000-0000-000000000000";

// A well-formed-but-foreign landing zone ARN — the testing account has no
// landing zone, so any identifier is absent.
const NONEXISTENT_LANDING_ZONE_ARN =
  "arn:aws:controltower:us-west-2:111111111111:landingzone/AAAAAAAAAAAAAAAA";

export class ControlTowerTestFunction extends Lambda.Function<Lambda.Function>()(
  "ControlTowerTestFunction",
) {}

export default ControlTowerTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    // --- account-level bindings (Control Tower has no data plane; these
    // are the read/audit + operation-status APIs a governance function
    // uses) ---
    const listBaselines = yield* ControlTower.ListBaselines();
    const getBaseline = yield* ControlTower.GetBaseline();
    const listEnabledBaselines = yield* ControlTower.ListEnabledBaselines();
    const getBaselineOperation = yield* ControlTower.GetBaselineOperation();
    const listEnabledControls = yield* ControlTower.ListEnabledControls();
    const getControlOperation = yield* ControlTower.GetControlOperation();
    const listControlOperations = yield* ControlTower.ListControlOperations();
    const listLandingZones = yield* ControlTower.ListLandingZones();
    const getLandingZone = yield* ControlTower.GetLandingZone();
    const getLandingZoneOperation =
      yield* ControlTower.GetLandingZoneOperation();
    const listLandingZoneOperations =
      yield* ControlTower.ListLandingZoneOperations();

    const bound = {
      listBaselines,
      getBaseline,
      listEnabledBaselines,
      getBaselineOperation,
      listEnabledControls,
      getControlOperation,
      listControlOperations,
      listLandingZones,
      getLandingZone,
      getLandingZoneOperation,
      listLandingZoneOperations,
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

        if (request.method === "GET" && pathname === "/baselines") {
          // The baseline catalog is served even without a landing zone;
          // some org configurations reject the call outright — but always
          // with a typed tag.
          const result = yield* listBaselines().pipe(
            Effect.map((r) => ({
              ok: true as const,
              names: r.baselines.map((b) => b.name ?? null),
            })),
            Effect.catchTag(
              ["AccessDeniedException", "UnauthorizedException"],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/baseline") {
          // Discover a baseline ARN from the catalog, then read it back —
          // proves GetBaseline's grant end-to-end.
          const result = yield* listBaselines().pipe(
            Effect.flatMap((r) =>
              Effect.gen(function* () {
                const arn = r.baselines.find(
                  (b) => b.name === "AWSControlTowerBaseline",
                )?.arn;
                if (arn === undefined) {
                  return { ok: false as const, tag: "NoCatalog" };
                }
                const b = yield* getBaseline({ baselineIdentifier: arn });
                return { ok: true as const, name: b.name };
              }),
            ),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "UnauthorizedException",
                "ResourceNotFoundException",
              ],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/enabled-baselines") {
          // The baseline API family rejects accounts without a landing
          // zone with the typed UnauthorizedException (distilled patch).
          const result = yield* listEnabledBaselines().pipe(
            Effect.map((r) => ({
              ok: true as const,
              count: r.enabledBaselines.length,
            })),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "UnauthorizedException",
                "ValidationException",
              ],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/enabled-controls") {
          const result = yield* listEnabledControls().pipe(
            Effect.map((r) => ({
              ok: true as const,
              count: r.enabledControls.length,
            })),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "ResourceNotFoundException",
                "ValidationException",
              ],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/control-operations") {
          const result = yield* listControlOperations().pipe(
            Effect.map((r) => ({
              ok: true as const,
              count: r.controlOperations.length,
            })),
            // ListControlOperations never throws ResourceNotFoundException
            // (per the distilled union + AWS docs) — only the access/validation
            // family applies here.
            Effect.catchTag(
              ["AccessDeniedException", "ValidationException"],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/landing-zones") {
          // The testing account has no landing zone — an empty (or
          // singleton) list, never a crash.
          const result = yield* listLandingZones().pipe(
            Effect.map((r) => ({
              ok: true as const,
              count: r.landingZones.length,
            })),
            Effect.catchTag(
              ["AccessDeniedException", "UnauthorizedException"],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (
          request.method === "GET" &&
          pathname === "/landing-zone-operations"
        ) {
          const result = yield* listLandingZoneOperations().pipe(
            Effect.map((r) => ({
              ok: true as const,
              count: r.landingZoneOperations.length,
            })),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "UnauthorizedException",
                "ValidationException",
              ],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (
          request.method === "GET" &&
          pathname === "/landing-zone-not-found"
        ) {
          const tag = yield* getLandingZone({
            landingZoneIdentifier: NONEXISTENT_LANDING_ZONE_ARN,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "ValidationException",
                "AccessDeniedException",
                "UnauthorizedException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (
          request.method === "GET" &&
          pathname === "/control-operation-not-found"
        ) {
          const tag = yield* getControlOperation({
            operationIdentifier: NONEXISTENT_OPERATION_ID,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "ValidationException",
                "AccessDeniedException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (
          request.method === "GET" &&
          pathname === "/baseline-operation-not-found"
        ) {
          const result = yield* getBaselineOperation({
            operationIdentifier: NONEXISTENT_OPERATION_ID,
          }).pipe(
            Effect.map(() => ({ tag: "Found", message: "" })),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "ValidationException",
                "AccessDeniedException",
                "UnauthorizedException",
              ],
              (e) => Effect.succeed({ tag: e._tag, message: e.message }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (
          request.method === "GET" &&
          pathname === "/landing-zone-operation-not-found"
        ) {
          const result = yield* getLandingZoneOperation({
            operationIdentifier: NONEXISTENT_OPERATION_ID,
          }).pipe(
            Effect.map(() => ({ tag: "Found", message: "" })),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "ValidationException",
                "AccessDeniedException",
                "UnauthorizedException",
              ],
              (e) => Effect.succeed({ tag: e._tag, message: e.message }),
            ),
          );
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
        ControlTower.ListBaselinesHttp,
        ControlTower.GetBaselineHttp,
        ControlTower.ListEnabledBaselinesHttp,
        ControlTower.GetBaselineOperationHttp,
        ControlTower.ListEnabledControlsHttp,
        ControlTower.GetControlOperationHttp,
        ControlTower.ListControlOperationsHttp,
        ControlTower.ListLandingZonesHttp,
        ControlTower.GetLandingZoneHttp,
        ControlTower.GetLandingZoneOperationHttp,
        ControlTower.ListLandingZoneOperationsHttp,
      ),
    ),
  ),
);
