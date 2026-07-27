import * as iotw from "@distilled.cloud/aws/iot-wireless";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  hasAlchemyTags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  readIotWirelessTags,
  sameShape,
  syncIotWirelessTags,
} from "./internal.ts";

export interface WirelessGatewayProps {
  /**
   * Name of the wireless gateway. If omitted, a deterministic physical name
   * is generated from the app, stage, and logical ID. Can be changed in
   * place.
   */
  name?: string;
  /**
   * Human-readable description of the gateway.
   */
  description?: string;
  /**
   * LoRaWAN gateway configuration. `GatewayEui` (the gateway's unique
   * 64-bit radio identifier) and `RfRegion` are the gateway's identity —
   * changing either replaces the gateway. `JoinEuiFilters`, `NetIdFilters`,
   * and `MaxEirp` update in place.
   */
  loRaWAN: iotw.LoRaWANGateway;
  /**
   * Tags applied to the gateway. Alchemy ownership tags are merged in
   * automatically.
   */
  tags?: Record<string, string>;
}

export interface WirelessGateway extends Resource<
  "AWS.IoTWireless.WirelessGateway",
  WirelessGatewayProps,
  {
    /** Server-assigned ID of the wireless gateway. */
    wirelessGatewayId: string;
    /** ARN of the wireless gateway. */
    wirelessGatewayArn: string;
    /** Name of the wireless gateway. */
    wirelessGatewayName: string;
    /** The gateway's unique 64-bit radio identifier. */
    gatewayEui: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An AWS IoT Core for LoRaWAN wireless gateway — the cloud registration of
 * a physical LoRaWAN gateway (packet forwarder), keyed by its unique
 * 64-bit `GatewayEui`.
 *
 * The gateway's radio identity (`GatewayEui`, `RfRegion`, sub-bands,
 * beaconing) is immutable — changing it replaces the gateway. The name,
 * description, EUI/NetID filters, `MaxEirp`, and tags update in place.
 * @resource
 * @section Creating Gateways
 * @example US915 Gateway
 * ```typescript
 * import * as IoTWireless from "alchemy/AWS/IoTWireless";
 *
 * const gateway = yield* IoTWireless.WirelessGateway("RooftopGw", {
 *   loRaWAN: {
 *     GatewayEui: "aa555a0000000001",
 *     RfRegion: "US915",
 *   },
 *   tags: { site: "hq" },
 * });
 * ```
 *
 * @example Gateway with join filters
 * ```typescript
 * const gateway = yield* IoTWireless.WirelessGateway("RooftopGw", {
 *   loRaWAN: {
 *     GatewayEui: "aa555a0000000001",
 *     RfRegion: "US915",
 *     JoinEuiFilters: [["0000000000000001", "00000000000000ff"]],
 *     MaxEirp: 30,
 *   },
 * });
 * ```
 */
export const WirelessGateway = Resource<WirelessGateway>(
  "AWS.IoTWireless.WirelessGateway",
);

/** The parts of a LoRaWAN gateway spec that form its immutable identity. */
const gatewayIdentity = (loRaWAN: iotw.LoRaWANGateway | undefined) => ({
  GatewayEui: loRaWAN?.GatewayEui,
  RfRegion: loRaWAN?.RfRegion,
  SubBands: loRaWAN?.SubBands,
  Beaconing: loRaWAN?.Beaconing,
});

export const WirelessGatewayProvider = () =>
  Provider.effect(
    WirelessGateway,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { name?: string },
      ) {
        return (
          props.name ?? (yield* createPhysicalName({ id, maxLength: 256 }))
        );
      });

      const getBy = (identifier: string, type: iotw.WirelessGatewayIdType) =>
        iotw
          .getWirelessGateway({ Identifier: identifier, IdentifierType: type })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const observe = Effect.fn(function* (
        output: WirelessGateway["Attributes"] | undefined,
        props: WirelessGatewayProps,
      ) {
        if (output?.wirelessGatewayId !== undefined) {
          const found = yield* getBy(
            output.wirelessGatewayId,
            "WirelessGatewayId",
          );
          if (found !== undefined) return found;
        }
        // Recover identity by the gateway's unique EUI when state was lost.
        if (props.loRaWAN?.GatewayEui !== undefined) {
          return yield* getBy(props.loRaWAN.GatewayEui, "GatewayEui");
        }
        return undefined;
      });

      const toAttrs = Effect.fn(function* (
        gateway: iotw.GetWirelessGatewayResponse,
        name: string,
      ) {
        if (gateway.Id === undefined || gateway.Arn === undefined) {
          return yield* Effect.fail(
            new Error(`IoT Wireless gateway '${name}' returned without Id/Arn`),
          );
        }
        return {
          wirelessGatewayId: gateway.Id,
          wirelessGatewayArn: gateway.Arn,
          wirelessGatewayName: gateway.Name ?? name,
          gatewayEui: gateway.LoRaWAN?.GatewayEui,
        };
      });

      return WirelessGateway.Provider.of({
        stables: ["wirelessGatewayId", "wirelessGatewayArn", "gatewayEui"],

        list: () =>
          iotw.listWirelessGateways.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.WirelessGatewayList ?? [])
                .flatMap((g) =>
                  g.Id !== undefined && g.Arn !== undefined
                    ? [
                        {
                          wirelessGatewayId: g.Id,
                          wirelessGatewayArn: g.Arn,
                          wirelessGatewayName: g.Name ?? g.Id,
                          gatewayEui: g.LoRaWAN?.GatewayEui,
                        },
                      ]
                    : [],
                ),
            ),
          ),

        read: Effect.fn(function* ({ id, olds, output }) {
          const props = olds ?? { loRaWAN: {} };
          const name =
            output?.wirelessGatewayName ?? (yield* createName(id, props));
          const gateway = yield* observe(output, props);
          if (gateway === undefined) return undefined;
          const attrs = yield* toAttrs(gateway, name);
          const tags = yield* readIotWirelessTags(attrs.wirelessGatewayArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        // The radio identity (GatewayEui, RfRegion, sub-bands, beaconing) is
        // create-only. Name, description, filters, and MaxEirp update in
        // place via UpdateWirelessGateway.
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            !sameShape(
              gatewayIdentity(olds?.loRaWAN),
              gatewayIdentity(news.loRaWAN),
            )
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name =
            output?.wirelessGatewayName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative; output is an id cache.
          let gateway = yield* observe(output, news);

          // 2. ENSURE — create if missing; a Conflict means the EUI is
          //    already registered, so re-observe by it.
          if (gateway === undefined) {
            yield* session.note(`creating wireless gateway ${name}`);
            const created = yield* iotw
              .createWirelessGateway({
                Name: name,
                Description: news.description,
                LoRaWAN: news.loRaWAN,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.catchTag("ConflictException", () =>
                  Effect.succeed(undefined),
                ),
              );
            gateway =
              created?.Id !== undefined
                ? yield* getBy(created.Id, "WirelessGatewayId")
                : yield* observe(undefined, news);
          }
          if (gateway === undefined) {
            return yield* Effect.fail(
              new Error(
                `IoT Wireless gateway '${name}' not found after create`,
              ),
            );
          }
          const attrs = yield* toAttrs(gateway, name);

          // 3. SYNC — apply the mutable-aspect delta from OBSERVED state.
          const nameDelta = gateway.Name !== name;
          const descriptionDelta =
            news.description !== undefined &&
            gateway.Description !== news.description;
          const joinFiltersDelta =
            news.loRaWAN.JoinEuiFilters !== undefined &&
            !sameShape(
              gateway.LoRaWAN?.JoinEuiFilters,
              news.loRaWAN.JoinEuiFilters,
            );
          const netIdFiltersDelta =
            news.loRaWAN.NetIdFilters !== undefined &&
            !sameShape(
              gateway.LoRaWAN?.NetIdFilters,
              news.loRaWAN.NetIdFilters,
            );
          const maxEirpDelta =
            news.loRaWAN.MaxEirp !== undefined &&
            gateway.LoRaWAN?.MaxEirp !== news.loRaWAN.MaxEirp;
          if (
            nameDelta ||
            descriptionDelta ||
            joinFiltersDelta ||
            netIdFiltersDelta ||
            maxEirpDelta
          ) {
            yield* iotw.updateWirelessGateway({
              Id: attrs.wirelessGatewayId,
              Name: name,
              Description: news.description,
              JoinEuiFilters: news.loRaWAN.JoinEuiFilters,
              NetIdFilters: news.loRaWAN.NetIdFilters,
              MaxEirp: news.loRaWAN.MaxEirp,
            });
          }

          // 3b. SYNC tags — diff against OBSERVED cloud tags.
          yield* syncIotWirelessTags(attrs.wirelessGatewayArn, desiredTags);

          // 4. RETURN fresh attributes.
          const final = yield* getBy(
            attrs.wirelessGatewayId,
            "WirelessGatewayId",
          );
          if (final === undefined) {
            return yield* Effect.fail(
              new Error(
                `IoT Wireless gateway '${name}' vanished during update`,
              ),
            );
          }
          yield* session.note(attrs.wirelessGatewayId);
          return yield* toAttrs(final, name);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* iotw
            .deleteWirelessGateway({ Id: output.wirelessGatewayId })
            .pipe(
              Effect.asVoid,
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
