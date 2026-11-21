import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import type { HomeAssistantBambuPrinterConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  discoverBambuEntityPrefix,
  homeAssistantBambuAdapter,
  parseHomeAssistantBambuStates,
} from "./adapters/HomeAssistantBambuAdapter.ts";

const P1S_CONFIG: HomeAssistantBambuPrinterConfig = {
  kind: "home-assistant-bambu",
  id: "bambu-p1s",
  label: "Studio P1S",
  baseUrl: "http://192.168.1.50:8123",
  accessToken: "test-token",
  pollIntervalSeconds: 4,
};

const LIVE_P1S_STATES = [
  {
    entity_id: "binary_sensor.p1s_01p00a000000001_online",
    state: "on",
    last_reported: "2026-11-21T00:18:05.000Z",
  },
  { entity_id: "binary_sensor.p1s_01p00a000000001_hybrid_mqtt_control_blocked", state: "off" },
  { entity_id: "binary_sensor.p1s_01p00a000000001_extruder_filament", state: "on" },
  { entity_id: "binary_sensor.p1s_01p00a000000001_externalspool_active", state: "on" },
  {
    entity_id: "binary_sensor.p1s_01p00a000000001_hms_errors",
    state: "off",
    attributes: { Count: 0 },
  },
  { entity_id: "binary_sensor.p1s_01p00a000000001_print_error", state: "off" },
  { entity_id: "binary_sensor.p1s_01p00a000000001_timelapse", state: "off" },
  { entity_id: "button.p1s_01p00a000000001_pause", state: "unknown" },
  { entity_id: "button.p1s_01p00a000000001_resume", state: "unavailable" },
  { entity_id: "button.p1s_01p00a000000001_stop", state: "unknown" },
  {
    entity_id: "camera.p1s_01p00a000000001_camera",
    state: "streaming",
    last_updated: "2026-11-21T00:18:00.000Z",
  },
  {
    entity_id: "image.p1s_01p00a000000001_cover_image",
    state: "2026-11-21T00:16:41.000Z",
    last_updated: "2026-11-21T00:16:41.000Z",
  },
  {
    entity_id: "image.p1s_01p00a000000001_pick_image",
    state: "2026-11-21T00:16:41.000Z",
  },
  { entity_id: "light.p1s_01p00a000000001_chamber_light", state: "on" },
  {
    entity_id: "fan.p1s_01p00a000000001_aux_fan",
    state: "on",
    attributes: { percentage: 40 },
  },
  {
    entity_id: "fan.p1s_01p00a000000001_chamber_fan",
    state: "off",
    attributes: { percentage: 0 },
  },
  {
    entity_id: "fan.p1s_01p00a000000001_cooling_fan",
    state: "on",
    attributes: { percentage: 80 },
  },
  { entity_id: "sensor.p1s_01p00a000000001_heatbreak_fan_speed", state: "100" },
  {
    entity_id: "number.p1s_01p00a000000001_nozzle_target_temperature",
    state: "215",
    attributes: { min: 0, max: 320 },
  },
  { entity_id: "sensor.p1s_01p00a000000001_nozzle_temperature", state: "216" },
  {
    entity_id: "number.p1s_01p00a000000001_bed_target_temperature",
    state: "70",
    attributes: { min: 0, max: 120 },
  },
  { entity_id: "sensor.p1s_01p00a000000001_bed_temperature", state: "70" },
  { entity_id: "select.p1s_01p00a000000001_printing_speed", state: "standard" },
  {
    entity_id: "sensor.p1s_01p00a000000001_speed_profile",
    state: "standard",
    attributes: { modifier: 100 },
  },
  {
    entity_id: "sensor.p1s_01p00a000000001_print_status",
    state: "running",
    last_reported: "2026-11-21T00:18:05.000Z",
  },
  { entity_id: "sensor.p1s_01p00a000000001_current_stage", state: "cleaning_nozzle_tip" },
  { entity_id: "sensor.p1s_01p00a000000001_print_progress", state: "28" },
  { entity_id: "sensor.p1s_01p00a000000001_current_layer", state: "28" },
  { entity_id: "sensor.p1s_01p00a000000001_total_layer_count", state: "100" },
  {
    entity_id: "sensor.p1s_01p00a000000001_remaining_time",
    state: "1.5",
    attributes: { unit_of_measurement: "h" },
  },
  { entity_id: "sensor.p1s_01p00a000000001_start_time", state: "2026-11-21T00:00:00.000Z" },
  { entity_id: "sensor.p1s_01p00a000000001_end_time", state: "2026-11-21T01:48:00.000Z" },
  {
    entity_id: "sensor.p1s_01p00a000000001_gcode_filename",
    state: "GD_Desk-Rear-Edge-Jig_SIDDAMENT-PETG_P1S_v1.gcode.3mf",
  },
  { entity_id: "sensor.p1s_01p00a000000001_print_weight", state: "42.63" },
  { entity_id: "sensor.p1s_01p00a000000001_print_length", state: "13.96" },
  {
    entity_id: "sensor.p1s_01p00a000000001_printable_objects",
    state: "2",
    attributes: {
      objects: {
        "15": "desk-rear-edge-jig.stl",
        "16": "clamp-spacer.stl",
      },
    },
  },
  {
    entity_id: "sensor.p1s_01p00a000000001_skipped_objects",
    state: "1",
    attributes: { objects: [16] },
  },
  { entity_id: "sensor.p1s_01p00a000000001_printer_name", state: "P1S-01P00A000000001" },
  { entity_id: "sensor.p1s_01p00a000000001_serial_number", state: "01P00A000000001" },
  { entity_id: "sensor.p1s_01p00a000000001_ip_address", state: "192.168.1.60" },
  { entity_id: "sensor.p1s_01p00a000000001_nozzle_size", state: "0.4" },
  { entity_id: "sensor.p1s_01p00a000000001_nozzle_type", state: "stainless_steel" },
  { entity_id: "sensor.p1s_01p00a000000001_print_bed_type", state: "textured_plate" },
  { entity_id: "sensor.p1s_01p00a000000001_total_usage", state: "73.64" },
  { entity_id: "sensor.p1s_01p00a000000001_wi_fi_signal", state: "-29" },
  { entity_id: "sensor.p1s_01p00a000000001_sd_card_status", state: "normal" },
  { entity_id: "sensor.p1s_01p00a000000001_mqtt_connection_mode", state: "local" },
  {
    entity_id: "sensor.p1s_01p00a000000001_externalspool_external_spool",
    state: "PETG",
    attributes: { active: true, color: "#1F2937FF", empty: false, type: "PETG" },
  },
];

describe("HomeAssistantBambuAdapter parsing", () => {
  it("auto-discovers Bambu entity prefix and parses live P1S telemetry accurately", () => {
    expect(discoverBambuEntityPrefix(LIVE_P1S_STATES)).toBe("p1s_01p00a000000001");

    const nowMs = Date.parse("2026-11-21T00:18:10.000Z");
    const { snapshot, cache } = parseHomeAssistantBambuStates({
      config: P1S_CONFIG,
      states: LIVE_P1S_STATES,
      previous: undefined,
      cache: {},
      nowMs,
      nowIso: "2026-11-21T00:18:10.000Z",
    });

    expect(cache.entityPrefix).toBe("p1s_01p00a000000001");
    expect(snapshot.online).toBe(true);
    expect(snapshot.stale).toBe(false);
    expect(snapshot.hardware.model).toBe("Bambu Lab P1S");
    expect(snapshot.hardware.nozzleSizeMm).toBe(0.4);
    expect(snapshot.hardware.nozzleType).toBe("Stainless Steel");
    expect(snapshot.hardware.bedType).toBe("Textured PEI Plate");
    expect(snapshot.job.status).toBe("running");
    expect(snapshot.job.stageLabel).toBe("Cleaning nozzle tip");
    expect(snapshot.job.progressPercent).toBe(28);
    expect(snapshot.job.currentLayer).toBe(28);
    expect(snapshot.job.totalLayers).toBe(100);
    expect(snapshot.job.remainingSeconds).toBe(5400);
    expect(snapshot.job.printableObjects).toEqual([
      { id: 15, name: "desk-rear-edge-jig.stl", skipped: false },
      { id: 16, name: "clamp-spacer.stl", skipped: true },
    ]);
    expect(snapshot.thermals.nozzle.actualC).toBe(216);
    expect(snapshot.thermals.nozzle.targetC).toBe(215);
    expect(snapshot.thermals.bed.actualC).toBe(70);
    expect(snapshot.thermals.chamber).toBeUndefined();
    expect(snapshot.thermals.history).toHaveLength(1);
    expect(snapshot.fans).toEqual({
      coolingPercent: 80,
      auxPercent: 40,
      chamberPercent: 0,
      heatbreakPercent: 100,
    });
    expect(snapshot.lighting.chamberLight).toBe(true);
    expect(snapshot.speed).toEqual({ profile: "standard", modifierPercent: 100 });
    expect(snapshot.filament.externalSpool?.colorHex).toBe("#1F2937");
    expect(snapshot.filament.externalSpool?.material).toBe("PETG");
    expect(snapshot.media.hasCamera).toBe(true);
    expect(snapshot.media.hasCoverImage).toBe(true);
    expect(snapshot.media.hasPickImage).toBe(true);
    // Axis jog is disabled while a print is active, and skipObjects needs >=2 unskipped objects.
    expect(snapshot.capabilities.canJog).toBe(false);
    expect(snapshot.capabilities.canPause).toBe(true);
    expect(snapshot.capabilities.canStop).toBe(true);
    expect(snapshot.capabilities.canSkipObjects).toBe(false);
  });

  it("marks offline printers and camera frames honestly as stale", () => {
    const offlineStates = LIVE_P1S_STATES.map((entity) =>
      entity.entity_id === "binary_sensor.p1s_01p00a000000001_online"
        ? { ...entity, state: "off" }
        : entity.entity_id === "sensor.p1s_01p00a000000001_print_status"
          ? { ...entity, state: "offline" }
          : entity,
    );

    const { snapshot } = parseHomeAssistantBambuStates({
      config: P1S_CONFIG,
      states: offlineStates,
      previous: undefined,
      cache: {},
      nowMs: Date.parse("2026-11-21T00:20:00.000Z"),
      nowIso: "2026-11-21T00:20:00.000Z",
    });

    expect(snapshot.online).toBe(false);
    expect(snapshot.stale).toBe(true);
    expect(snapshot.media.cameraStale).toBe(true);
    expect(snapshot.capabilities.canPause).toBe(false);
    expect(snapshot.capabilities.canJog).toBe(false);
  });

  it("parses AMS trays and decodes known and unknown HMS error codes", () => {
    const statesWithAmsAndHms = [
      ...LIVE_P1S_STATES.filter(
        (e) => e.entity_id !== "binary_sensor.p1s_01p00a000000001_hms_errors",
      ),
      {
        entity_id: "binary_sensor.p1s_01p00a000000001_hms_errors",
        state: "on",
        attributes: {
          Count: 2,
          "1-Error_Code": "0700_2000_0002_0001",
          "2-Code": "0999_0001_0002_0003",
          "2-Error": "Abnormal accelerometer data detected.",
        },
      },
      {
        entity_id: "sensor.p1s_01p00a000000001_ams_1_humidity_index",
        state: "3",
      },
      {
        entity_id: "sensor.p1s_01p00a000000001_ams_1_tray_1",
        state: "PLA",
        attributes: { active: true, color: "#FF5500FF", remain: 65, type: "PLA", empty: false },
      },
      {
        entity_id: "sensor.p1s_01p00a000000001_ams_1_tray_2",
        state: "Empty",
        attributes: { active: false, color: "#00000000", empty: true },
      },
    ];

    const { snapshot } = parseHomeAssistantBambuStates({
      config: P1S_CONFIG,
      states: statesWithAmsAndHms,
      previous: undefined,
      cache: {},
      nowMs: Date.parse("2026-11-21T00:20:00.000Z"),
      nowIso: "2026-11-21T00:20:00.000Z",
    });

    expect(snapshot.filament.amsUnits).toHaveLength(1);
    expect(snapshot.filament.amsUnits[0]?.humidityIndex).toBe(3);
    expect(snapshot.filament.amsUnits[0]?.trays[0]).toMatchObject({
      material: "PLA",
      colorHex: "#FF5500",
      remainingPercent: 65,
      active: true,
      empty: false,
    });
    expect(snapshot.filament.amsUnits[0]?.trays[1]).toMatchObject({
      colorHex: null,
      empty: true,
    });
    expect(snapshot.alerts).toEqual([
      {
        code: "0700_2000_0002_0001",
        severity: "warning",
        message: "AMS filament ran out or failed to feed",
      },
      {
        code: "0999_0001_0002_0003",
        severity: "warning",
        message: "Abnormal accelerometer data detected.",
      },
    ]);
  });

  it("marks repeated camera frames older than 30s as stale consistently in poll and normalizes trailing-dot prefix", () => {
    expect(discoverBambuEntityPrefix(LIVE_P1S_STATES, "p1s_01p00a000000001.")).toBe(
      "p1s_01p00a000000001",
    );
    expect(discoverBambuEntityPrefix(LIVE_P1S_STATES, "p1s') }} {{ 1+1")).toBeNull();

    const t0 = Date.parse("2026-11-21T00:18:00.000Z");
    const first = parseHomeAssistantBambuStates({
      config: P1S_CONFIG,
      states: LIVE_P1S_STATES,
      previous: undefined,
      cache: {
        lastCameraHash: "abc123",
        lastCameraChangedAtMs: t0,
        cameraEntityHealthy: true,
      },
      nowMs: t0 + 10_000,
      nowIso: "2026-11-21T00:18:10.000Z",
    });
    expect(first.snapshot.media.cameraStale).toBe(false);

    const stale = parseHomeAssistantBambuStates({
      config: P1S_CONFIG,
      states: LIVE_P1S_STATES,
      previous: first.snapshot,
      cache: {
        ...first.cache,
        lastCameraHash: "abc123",
        lastCameraChangedAtMs: t0,
      },
      nowMs: t0 + 35_000,
      nowIso: "2026-11-21T00:18:35.000Z",
    });
    expect(stale.snapshot.media.cameraStale).toBe(true);
  });

  it("marks HA telemetry stale and disables jogging when online or print_status timestamps are missing or older than 5 minutes", () => {
    const nowMs = Date.parse("2026-11-21T00:25:00.000Z");
    const idleWithOldStatus = LIVE_P1S_STATES.map((entity) =>
      entity.entity_id === "sensor.p1s_01p00a000000001_print_status"
        ? { ...entity, state: "idle", last_reported: "2026-11-21T00:18:00.000Z" }
        : entity.entity_id === "binary_sensor.p1s_01p00a000000001_online"
          ? { ...entity, state: "on", last_reported: "2026-11-21T00:24:55.000Z" }
          : entity,
    );
    const oldResult = parseHomeAssistantBambuStates({
      config: P1S_CONFIG,
      states: idleWithOldStatus,
      previous: undefined,
      cache: {},
      nowMs,
      nowIso: "2026-11-21T00:25:00.000Z",
    });
    expect(oldResult.snapshot.stale).toBe(true);
    expect(oldResult.snapshot.capabilities.canJog).toBe(false);

    const idleMissingTimestamps = LIVE_P1S_STATES.map((entity) =>
      entity.entity_id === "sensor.p1s_01p00a000000001_print_status"
        ? { entity_id: entity.entity_id, state: "idle" }
        : entity,
    );
    const missingResult = parseHomeAssistantBambuStates({
      config: P1S_CONFIG,
      states: idleMissingTimestamps,
      previous: undefined,
      cache: {},
      nowMs,
      nowIso: "2026-11-21T00:25:00.000Z",
    });
    expect(missingResult.snapshot.stale).toBe(true);
    expect(missingResult.snapshot.capabilities.canJog).toBe(false);
  });

  effectIt.effect(
    "fails testConnection on explicit deviceId mismatch and rejects non-image bytes from camera proxy",
    () =>
      Effect.gen(function* () {
        const mockClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const url = new URL(request.url);
            if (url.pathname === "/api/states") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(JSON.stringify(LIVE_P1S_STATES), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                  }),
                ),
              );
            }
            if (url.pathname === "/api/template") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response("actual-ha-device-id", {
                    status: 200,
                    headers: { "content-type": "text/plain" },
                  }),
                ),
              );
            }
            if (url.pathname.startsWith("/api/camera_proxy/")) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response("<html>login page</html>", {
                    status: 200,
                    headers: { "content-type": "text/html" },
                  }),
                ),
              );
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("Not Found", { status: 404 })),
            );
          }),
        );

        const mismatchExit = yield* Effect.exit(
          homeAssistantBambuAdapter
            .testConnection({ ...P1S_CONFIG, deviceId: "wrong-device-id" }, "test-token")
            .pipe(Effect.provide(mockClient)),
        );
        expect(Exit.isFailure(mismatchExit)).toBe(true);
        expect(String(mismatchExit)).toContain("does not match");

        const polled = yield* homeAssistantBambuAdapter
          .poll(P1S_CONFIG, "test-token", undefined, {})
          .pipe(Effect.provide(mockClient));
        const mediaExit = yield* Effect.exit(
          homeAssistantBambuAdapter
            .fetchMedia(P1S_CONFIG, "test-token", "camera", polled.snapshot, polled.cache)
            .pipe(Effect.provide(mockClient)),
        );
        expect(Exit.isFailure(mediaExit)).toBe(true);
      }),
  );

  it("canonicalizes start_time and end_time across HA timestamp format variations and drops unparseable values", () => {
    const nowMs = Date.parse("2026-11-21T00:18:10.000Z");
    const withTimes = (startTime: string, endTime: string) =>
      LIVE_P1S_STATES.map((entity) => {
        if (entity.entity_id === "sensor.p1s_01p00a000000001_start_time") {
          return { ...entity, state: startTime };
        }
        if (entity.entity_id === "sensor.p1s_01p00a000000001_end_time") {
          return { ...entity, state: endTime };
        }
        return entity;
      });

    const poll1 = parseHomeAssistantBambuStates({
      config: P1S_CONFIG,
      states: withTimes("2026-11-21T00:00:00+00:00", "2026-11-21T01:48:00+00:00"),
      previous: undefined,
      cache: {},
      nowMs,
      nowIso: "2026-11-21T00:18:10.000Z",
    });
    const poll2 = parseHomeAssistantBambuStates({
      config: P1S_CONFIG,
      states: withTimes("2026-11-21T02:00:00.000+02:00", "2026-11-21T01:48:00.000Z"),
      previous: poll1.snapshot,
      cache: poll1.cache,
      nowMs: nowMs + 4_000,
      nowIso: "2026-11-21T00:18:14.000Z",
    });
    expect(poll1.snapshot.job.startedAt).toBe("2026-11-21T00:00:00.000Z");
    expect(poll2.snapshot.job.startedAt).toBe("2026-11-21T00:00:00.000Z");
    expect(poll1.snapshot.job.estimatedFinishAt).toBe("2026-11-21T01:48:00.000Z");
    expect(poll2.snapshot.job.estimatedFinishAt).toBe("2026-11-21T01:48:00.000Z");

    const invalid = parseHomeAssistantBambuStates({
      config: P1S_CONFIG,
      states: withTimes("not-a-timestamp", "12345"),
      previous: undefined,
      cache: {},
      nowMs,
      nowIso: "2026-11-21T00:18:10.000Z",
    });
    expect(invalid.snapshot.job.startedAt).toBeNull();
    expect(invalid.snapshot.job.estimatedFinishAt).toBeNull();
    expect(invalid.snapshot.job.elapsedSeconds).toBeNull();
  });
});
