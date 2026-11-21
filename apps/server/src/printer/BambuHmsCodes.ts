import type { PrinterAlert } from "@t3tools/contracts";

const BAMBU_HMS_MESSAGES: Readonly<
  Record<string, { severity: "warning" | "error"; message: string }>
> = {
  "0300_0100_0001_0001": { severity: "error", message: "Heatbed temperature sensor abnormal" },
  "0300_0200_0001_0001": {
    severity: "error",
    message: "Nozzle temperature abnormal or thermistor open",
  },
  "0300_0A00_0001_0001": {
    severity: "warning",
    message: "Heatbed homing or leveling force abnormal",
  },
  "0300_0D00_0001_0003": { severity: "error", message: "Toolhead front housing cover fell off" },
  "0300_1200_0002_0001": { severity: "warning", message: "Spaghetti / print defect detected" },
  "0500_0300_0001_0002": { severity: "warning", message: "SD card missing or abnormal" },
  "0700_0100_0002_0002": { severity: "warning", message: "AMS assist motor overloaded" },
  "0700_2000_0002_0001": { severity: "warning", message: "AMS filament ran out or failed to feed" },
  "0700_2000_0002_0002": {
    severity: "warning",
    message: "Failed to pull back filament from toolhead",
  },
  "0700_2000_0002_0004": { severity: "warning", message: "Filament cutter appears stuck" },
  "0700_4000_0002_0001": { severity: "warning", message: "External spool filament ran out" },
  "0C00_0300_0002_0001": {
    severity: "warning",
    message: "Build plate localization marker not detected",
  },
};

const BAMBU_STAGE_LABELS: Readonly<Record<string, string>> = {
  printing: "Printing",
  auto_bed_leveling: "Auto bed leveling",
  heatbed_preheating: "Preheating heatbed",
  heating_hotend: "Heating nozzle",
  cleaning_nozzle_tip: "Cleaning nozzle tip",
  changing_filament: "Changing filament",
  filament_loading: "Loading filament",
  filament_unloading: "Unloading filament",
  sweeping_xy_mech_mode: "Vibration calibration",
  calibrating_extrusion: "Calibrating extrusion",
  calibrating_extrusion_flow: "Calibrating flow dynamics",
  calibrating_micro_lidar: "Calibrating lidar",
  homing_toolhead: "Homing toolhead",
  identifying_build_plate_type: "Checking build plate",
  inspecting_first_layer: "Inspecting first layer",
  cooling_chamber: "Cooling chamber",
  m400_pause: "Paused (M400)",
  paused_user: "Paused by user",
  paused_front_cover_falling: "Paused: front cover open",
  paused_filament_runout: "Paused: filament runout",
  paused_nozzle_temperature_malfunction: "Paused: nozzle temp fault",
  paused_heat_bed_temperature_malfunction: "Paused: heatbed temp fault",
  paused_ams_lost: "Paused: AMS disconnected",
  paused_low_fan_speed_heat_break: "Paused: heatbreak fan low",
  paused_chamber_temperature_control_error: "Paused: chamber temp fault",
  paused_user_gcode: "Paused by G-code",
  paused_nozzle_filament_covered_detected: "Paused: nozzle clumping",
  paused_cutter_error: "Paused: cutter error",
  paused_first_layer_error: "Paused: first layer issue",
  paused_nozzle_clog: "Paused: nozzle clog",
  pre_extrusion_before_printing: "Purging filament",
  thermal_preconditioning: "Thermal preconditioning",
  moving_toolhead_to_center_of_heatbed: "Centering toolhead",
  measuring_surface: "Measuring build plate",
  idle: "Idle",
  offline: "Offline",
};

const NOZZLE_TYPE_LABELS: Readonly<Record<string, string>> = {
  stainless_steel: "Stainless Steel",
  hardened_steel: "Hardened Steel",
  brass: "Brass",
};

const BED_TYPE_LABELS: Readonly<Record<string, string>> = {
  textured_plate: "Textured PEI Plate",
  cool_plate: "Cool Plate",
  eng_plate: "Engineering Plate",
  hot_plate: "Smooth PEI Plate",
  supertack_plate: "SuperTack Plate",
};

export function formatBambuStage(rawStage: string | null | undefined): string | null {
  if (!rawStage) return null;
  const normalized = rawStage.trim().toLowerCase();
  if (!normalized || normalized === "unknown" || normalized === "unavailable") return null;
  const known = BAMBU_STAGE_LABELS[normalized];
  if (known) return known;
  return normalized.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function formatNozzleType(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  if (!key || key === "unknown" || key === "unavailable") return null;
  return NOZZLE_TYPE_LABELS[key] ?? raw.replace(/_/g, " ");
}

export function formatBedType(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  if (!key || key === "unknown" || key === "unavailable") return null;
  return BED_TYPE_LABELS[key] ?? raw.replace(/_/g, " ");
}

export function decodeBambuHmsError(code: string, fallbackDescription?: string): PrinterAlert {
  const normalized = code.trim().toUpperCase().replace(/^HMS_/, "").replace(/-/g, "_");
  const known = BAMBU_HMS_MESSAGES[normalized];
  if (known) {
    return {
      code: normalized,
      severity: known.severity,
      message: known.message,
    };
  }
  return {
    code: normalized || "HMS_UNKNOWN",
    severity: "warning",
    message: fallbackDescription?.trim() || `Bambu HMS alert ${normalized || code}`,
  };
}
