import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vite-plus/test";
import { relayLiveActivities, relayMobileDevices } from "./schema.ts";

describe("relay notification schema", () => {
  it("uses the composite primary keys without redundant user-only indexes", () => {
    const mobileDevices = getTableConfig(relayMobileDevices);
    const liveActivities = getTableConfig(relayLiveActivities);

    expect(mobileDevices.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      "user_id",
      "device_id",
    ]);
    expect(
      mobileDevices.indexes.map(({ config }) => ({
        name: config.name,
        unique: config.unique,
      })),
    ).toEqual([
      {
        name: "idx_relay_mobile_devices_push_token",
        unique: true,
      },
      {
        name: "idx_relay_mobile_devices_push_to_start_token",
        unique: true,
      },
    ]);

    expect(liveActivities.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      "user_id",
      "device_id",
    ]);
    expect(
      liveActivities.indexes.map(({ config }) => ({
        name: config.name,
        unique: config.unique,
      })),
    ).toEqual([
      {
        name: "idx_relay_live_activities_activity_push_token",
        unique: true,
      },
    ]);
  });
});
