import * as AWS from "@/AWS";
import { Role } from "@/AWS/IAM/Role.ts";
import {
  Destination,
  DeviceProfile,
  ServiceProfile,
  WirelessDevice,
  WirelessGateway,
} from "@/AWS/IoTWireless";
import * as Test from "@/Test/Alchemy";
import * as iotw from "@distilled.cloud/aws/iot-wireless";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag every IoTWireless provider's read/delete path depends on.
// Runs in every CI pass at near-zero cost.
test.provider(
  "getServiceProfile on a bogus id fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        iotw.getServiceProfile({
          Id: "00000000-0000-0000-0000-000000000000",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// The IAM role IoT Wireless assumes to deliver uplinks to the rule/topic.
const deliveryRole = Role("IotWirelessDelivery", {
  assumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "iotwireless.amazonaws.com" },
        Action: ["sts:AssumeRole"],
      },
    ],
  },
  inlinePolicies: {
    deliver: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["iot:DescribeEndpoint", "iot:Publish"],
          Resource: ["*"],
        },
      ],
    },
  },
});

// Service profiles, device profiles, and destinations are free, provision
// instantly, and need no radio hardware — full lifecycle runs ungated.
test.provider(
  "lifecycle: service profile + device profile + destination",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const role = yield* deliveryRole;
          const serviceProfile = yield* ServiceProfile("Fleet", {
            loRaWAN: { AddGwMetadata: true },
            tags: { fixture: "iot-wireless" },
          });
          const deviceProfile = yield* DeviceProfile("SensorModel", {
            loRaWAN: {
              MacVersion: "1.0.3",
              RegParamsRevision: "RP002-1.0.1",
              RfRegion: "US915",
              MaxEirp: 10,
              SupportsJoin: true,
            },
            tags: { fixture: "iot-wireless" },
          });
          const destination = yield* Destination("Uplinks", {
            expressionType: "RuleName",
            expression: "alchemy_iot_wireless_test_rule",
            description: "alchemy iot-wireless test destination",
            roleArn: role.roleArn,
            tags: { fixture: "iot-wireless" },
          });
          return { serviceProfile, deviceProfile, destination };
        }),
      );

      expect(deployed.serviceProfile.serviceProfileId).toBeDefined();
      expect(deployed.serviceProfile.serviceProfileArn).toContain(
        "iotwireless",
      );
      expect(deployed.deviceProfile.deviceProfileId).toBeDefined();
      expect(deployed.destination.destinationArn).toContain("iotwireless");
      expect(deployed.destination.expression).toBe(
        "alchemy_iot_wireless_test_rule",
      );

      // Out-of-band verification via distilled.
      const liveServiceProfile = yield* iotw.getServiceProfile({
        Id: deployed.serviceProfile.serviceProfileId,
      });
      expect(liveServiceProfile.Name).toBe(
        deployed.serviceProfile.serviceProfileName,
      );
      expect(liveServiceProfile.LoRaWAN?.AddGwMetadata).toBe(true);

      const liveDeviceProfile = yield* iotw.getDeviceProfile({
        Id: deployed.deviceProfile.deviceProfileId,
      });
      expect(liveDeviceProfile.LoRaWAN?.RfRegion).toBe("US915");
      expect(liveDeviceProfile.LoRaWAN?.MacVersion).toBe("1.0.3");

      const liveDestination = yield* iotw.getDestination({
        Name: deployed.destination.destinationName,
      });
      expect(liveDestination.ExpressionType).toBe("RuleName");
      expect(liveDestination.Expression).toBe("alchemy_iot_wireless_test_rule");

      const destinationTags = yield* iotw.listTagsForResource({
        ResourceArn: deployed.destination.destinationArn,
      });
      expect(
        destinationTags.Tags?.some(
          (t) => t.Key === "alchemy::id" && t.Value === "Uplinks",
        ),
      ).toBe(true);
      expect(
        destinationTags.Tags?.some(
          (t) => t.Key === "fixture" && t.Value === "iot-wireless",
        ),
      ).toBe(true);

      // Update — the destination's expression and the service profile's
      // tags change in place; the service profile's LoRaWAN config is
      // immutable so changing it REPLACES the profile (new id).
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const role = yield* deliveryRole;
          const serviceProfile = yield* ServiceProfile("Fleet", {
            loRaWAN: { AddGwMetadata: false },
            tags: { fixture: "iot-wireless", env: "test" },
          });
          const deviceProfile = yield* DeviceProfile("SensorModel", {
            loRaWAN: {
              MacVersion: "1.0.3",
              RegParamsRevision: "RP002-1.0.1",
              RfRegion: "US915",
              MaxEirp: 10,
              SupportsJoin: true,
            },
            tags: { fixture: "iot-wireless" },
          });
          const destination = yield* Destination("Uplinks", {
            expressionType: "RuleName",
            expression: "alchemy_iot_wireless_test_rule_v2",
            description: "alchemy iot-wireless test destination",
            roleArn: role.roleArn,
            tags: { fixture: "iot-wireless" },
          });
          return { serviceProfile, deviceProfile, destination };
        }),
      );

      // Destination updated in place (same identity).
      expect(updated.destination.destinationName).toBe(
        deployed.destination.destinationName,
      );
      const updatedDestination = yield* iotw.getDestination({
        Name: updated.destination.destinationName,
      });
      expect(updatedDestination.Expression).toBe(
        "alchemy_iot_wireless_test_rule_v2",
      );

      // Device profile untouched (same id).
      expect(updated.deviceProfile.deviceProfileId).toBe(
        deployed.deviceProfile.deviceProfileId,
      );

      // Service profile replaced (new id) and the old one deleted.
      expect(updated.serviceProfile.serviceProfileId).not.toBe(
        deployed.serviceProfile.serviceProfileId,
      );
      const replacedServiceProfile = yield* iotw.getServiceProfile({
        Id: updated.serviceProfile.serviceProfileId,
      });
      expect(replacedServiceProfile.LoRaWAN?.AddGwMetadata).toBe(false);
      const oldServiceProfileError = yield* Effect.flip(
        iotw.getServiceProfile({
          Id: deployed.serviceProfile.serviceProfileId,
        }),
      );
      expect(oldServiceProfileError._tag).toBe("ResourceNotFoundException");
      const serviceProfileTags = yield* iotw.listTagsForResource({
        ResourceArn: updated.serviceProfile.serviceProfileArn,
      });
      expect(
        serviceProfileTags.Tags?.some(
          (t) => t.Key === "env" && t.Value === "test",
        ),
      ).toBe(true);

      // Destroy — everything gone, typed.
      yield* stack.destroy();
      const destinationError = yield* Effect.flip(
        iotw.getDestination({ Name: updated.destination.destinationName }),
      );
      expect(destinationError._tag).toBe("ResourceNotFoundException");
      const serviceProfileError = yield* Effect.flip(
        iotw.getServiceProfile({
          Id: updated.serviceProfile.serviceProfileId,
        }),
      );
      expect(serviceProfileError._tag).toBe("ResourceNotFoundException");
      const deviceProfileError = yield* Effect.flip(
        iotw.getDeviceProfile({ Id: updated.deviceProfile.deviceProfileId }),
      );
      expect(deviceProfileError._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 240_000 },
);

// Deterministic fabricated radio identities — devices and gateways can be
// registered without hardware (they just never join), but accounts shared
// with real LoRaWAN fleets should not accumulate phantom radios, so the
// full device/gateway lifecycle is gated behind AWS_TEST_IOT_WIRELESS=1.
const DEV_EUI = "1a2b3c4d5e6f7081";
const APP_EUI = "0000000000000001";
const APP_KEY = Redacted.make("000102030405060708090a0b0c0d0e0f");
const GATEWAY_EUI = "aa555a0000000101";

test.provider.skipIf(!process.env.AWS_TEST_IOT_WIRELESS)(
  "lifecycle: wireless device + wireless gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create — a full LoRaWAN registration: destination + profiles +
      // OTAA v1.0.x device + gateway.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const role = yield* deliveryRole;
          const destination = yield* Destination("DeviceUplinks", {
            expressionType: "RuleName",
            expression: "alchemy_iot_wireless_device_rule",
            roleArn: role.roleArn,
            tags: { fixture: "iot-wireless" },
          });
          const serviceProfile = yield* ServiceProfile("DeviceFleet", {
            loRaWAN: { AddGwMetadata: true },
          });
          const deviceProfile = yield* DeviceProfile("DeviceModel", {
            loRaWAN: {
              MacVersion: "1.0.3",
              RegParamsRevision: "RP002-1.0.1",
              RfRegion: "US915",
              MaxEirp: 10,
              SupportsJoin: true,
            },
          });
          const device = yield* WirelessDevice("Sensor", {
            type: "LoRaWAN",
            destinationName: destination.destinationName,
            description: "alchemy test sensor",
            loRaWAN: {
              DevEui: DEV_EUI,
              DeviceProfileId: deviceProfile.deviceProfileId,
              ServiceProfileId: serviceProfile.serviceProfileId,
              OtaaV1_0_x: { AppKey: APP_KEY, AppEui: APP_EUI },
            },
            tags: { fixture: "iot-wireless" },
          });
          const gateway = yield* WirelessGateway("RooftopGw", {
            description: "alchemy test gateway",
            loRaWAN: { GatewayEui: GATEWAY_EUI, RfRegion: "US915" },
            tags: { fixture: "iot-wireless" },
          });
          return {
            destination,
            serviceProfile,
            deviceProfile,
            device,
            gateway,
          };
        }),
      );

      expect(deployed.device.wirelessDeviceId).toBeDefined();
      expect(deployed.device.type).toBe("LoRaWAN");
      expect(deployed.device.destinationName).toBe(
        deployed.destination.destinationName,
      );
      expect(deployed.gateway.wirelessGatewayId).toBeDefined();
      expect(deployed.gateway.gatewayEui).toBe(GATEWAY_EUI);

      // Out-of-band verification via distilled.
      const liveDevice = yield* iotw.getWirelessDevice({
        Identifier: deployed.device.wirelessDeviceId,
        IdentifierType: "WirelessDeviceId",
      });
      expect(liveDevice.LoRaWAN?.DevEui?.toLowerCase()).toBe(DEV_EUI);
      expect(liveDevice.LoRaWAN?.DeviceProfileId).toBe(
        deployed.deviceProfile.deviceProfileId,
      );
      expect(liveDevice.LoRaWAN?.ServiceProfileId).toBe(
        deployed.serviceProfile.serviceProfileId,
      );
      const liveGateway = yield* iotw.getWirelessGateway({
        Identifier: deployed.gateway.wirelessGatewayId,
        IdentifierType: "WirelessGatewayId",
      });
      expect(liveGateway.LoRaWAN?.GatewayEui?.toLowerCase()).toBe(GATEWAY_EUI);
      expect(liveGateway.LoRaWAN?.RfRegion).toBe("US915");

      // Update — device description and gateway MaxEirp change in place;
      // identities (DevEui / GatewayEui) are stable.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const role = yield* deliveryRole;
          const destination = yield* Destination("DeviceUplinks", {
            expressionType: "RuleName",
            expression: "alchemy_iot_wireless_device_rule",
            roleArn: role.roleArn,
            tags: { fixture: "iot-wireless" },
          });
          const serviceProfile = yield* ServiceProfile("DeviceFleet", {
            loRaWAN: { AddGwMetadata: true },
          });
          const deviceProfile = yield* DeviceProfile("DeviceModel", {
            loRaWAN: {
              MacVersion: "1.0.3",
              RegParamsRevision: "RP002-1.0.1",
              RfRegion: "US915",
              MaxEirp: 10,
              SupportsJoin: true,
            },
          });
          const device = yield* WirelessDevice("Sensor", {
            type: "LoRaWAN",
            destinationName: destination.destinationName,
            description: "alchemy test sensor v2",
            loRaWAN: {
              DevEui: DEV_EUI,
              DeviceProfileId: deviceProfile.deviceProfileId,
              ServiceProfileId: serviceProfile.serviceProfileId,
              OtaaV1_0_x: { AppKey: APP_KEY, AppEui: APP_EUI },
            },
            tags: { fixture: "iot-wireless", env: "test" },
          });
          const gateway = yield* WirelessGateway("RooftopGw", {
            description: "alchemy test gateway",
            loRaWAN: {
              GatewayEui: GATEWAY_EUI,
              RfRegion: "US915",
              MaxEirp: 27,
            },
            tags: { fixture: "iot-wireless" },
          });
          return { device, gateway };
        }),
      );

      expect(updated.device.wirelessDeviceId).toBe(
        deployed.device.wirelessDeviceId,
      );
      expect(updated.gateway.wirelessGatewayId).toBe(
        deployed.gateway.wirelessGatewayId,
      );
      const updatedDevice = yield* iotw.getWirelessDevice({
        Identifier: updated.device.wirelessDeviceId,
        IdentifierType: "WirelessDeviceId",
      });
      expect(updatedDevice.Description).toBe("alchemy test sensor v2");
      const updatedGateway = yield* iotw.getWirelessGateway({
        Identifier: updated.gateway.wirelessGatewayId,
        IdentifierType: "WirelessGatewayId",
      });
      expect(updatedGateway.LoRaWAN?.MaxEirp).toBe(27);
      const deviceTags = yield* iotw.listTagsForResource({
        ResourceArn: updated.device.wirelessDeviceArn,
      });
      expect(
        deviceTags.Tags?.some((t) => t.Key === "env" && t.Value === "test"),
      ).toBe(true);

      // Destroy — device and gateway gone, typed.
      yield* stack.destroy();
      const deviceError = yield* Effect.flip(
        iotw.getWirelessDevice({
          Identifier: updated.device.wirelessDeviceId,
          IdentifierType: "WirelessDeviceId",
        }),
      );
      expect(deviceError._tag).toBe("ResourceNotFoundException");
      const gatewayError = yield* Effect.flip(
        iotw.getWirelessGateway({
          Identifier: updated.gateway.wirelessGatewayId,
          IdentifierType: "WirelessGatewayId",
        }),
      );
      expect(gatewayError._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 240_000 },
);
