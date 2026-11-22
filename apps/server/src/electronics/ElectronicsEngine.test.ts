import { describe, expect, it } from "@effect/vitest";

import { runBuiltinMnaSimulation } from "./mnaSolver.ts";
import { parseElectronicsFile, parseEngineeringNumber } from "./parsers.ts";
import { traceCircuitPath } from "./pathTracer.ts";
import { assembleValidationReport, runBuiltinCircuitValidation } from "./validator.ts";

const SAMPLE_KICAD_SCH = `(kicad_sch
  (version 20231120)
  (title_block (title "Sensor Power & Divider"))
  (lib_symbols
    (symbol "Device:R"
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27) (name "~") (number "1"))
        (pin passive line (at 0 -3.81 90) (length 1.27) (name "~") (number "2"))
      )
    )
    (symbol "Regulator:LDO"
      (symbol "LDO_1_1"
        (pin power_in line (at -5.08 0 0) (length 2.54) (name "VIN") (number "1"))
        (pin power_in line (at 0 -5.08 90) (length 2.54) (name "GND") (number "2"))
        (pin power_out line (at 5.08 0 180) (length 2.54) (name "VOUT") (number "3"))
      )
    )
    (symbol "power:+5V"
      (symbol "+5V_1_1"
        (pin power_in line (at 0 0 90) (length 0) (name "+5V") (number "1"))
      )
    )
    (symbol "power:GND"
      (symbol "GND_1_1"
        (pin power_in line (at 0 0 270) (length 0) (name "GND") (number "1"))
      )
    )
  )
  (symbol (lib_id "power:+5V") (at 20 30 0)
    (property "Reference" "#PWR01")
    (property "Value" "+5V")
  )
  (symbol (lib_id "power:GND") (at 35 45 0)
    (property "Reference" "#PWR02")
    (property "Value" "GND")
  )
  (symbol (lib_id "Regulator:LDO") (at 35 30 0)
    (property "Reference" "U1")
    (property "Value" "AMS1117-3.3")
    (property "Footprint" "Package_TO_SOT_SMD:SOT-223-3_TabPin2")
  )
  (symbol (lib_id "Device:R") (at 60 30 0)
    (property "Reference" "R1")
    (property "Value" "10k")
    (property "Footprint" "Resistor_SMD:R_0603")
  )
  (symbol (lib_id "Device:R") (at 60 45 0)
    (property "Reference" "R2")
    (property "Value" "10k")
    (property "Footprint" "Resistor_SMD:R_0603")
  )
  (wire (pts (xy 20 30) (xy 29.92 30)))
  (wire (pts (xy 35 35.08) (xy 35 45)))
  (wire (pts (xy 40.08 30) (xy 60 26.19)))
  (wire (pts (xy 60 33.81) (xy 60 41.19)))
  (wire (pts (xy 60 48.81) (xy 35 45)))
  (label "+3V3" (at 45 28 0))
  (wire (pts (xy 45 28) (xy 40.08 30)))
  (label "VSENSE" (at 60 37.5 0))
  (junction (at 60 37.5))
)`;

const SAMPLE_KICAD_PCB = `(kicad_pcb
  (version 20240108)
  (title_block (title "Mini Filter Board"))
  (layers
    (0 "F.Cu" signal)
    (31 "B.Cu" signal)
    (44 "Edge.Cuts" user)
  )
  (net 0 "")
  (net 1 "+5V")
  (net 2 "VOUT")
  (net 3 "GND")
  (gr_rect (start 0 0) (end 40 25) (layer "Edge.Cuts"))
  (footprint "Resistor_SMD:R_0603" (layer "F.Cu") (at 10 10 0)
    (property "Reference" "R1")
    (property "Value" "1k")
    (pad "1" smd rect (at -0.8 0) (net 1 "+5V"))
    (pad "2" smd rect (at 0.8 0) (net 2 "VOUT"))
  )
  (footprint "Capacitor_SMD:C_0603" (layer "F.Cu") (at 20 10 0)
    (property "Reference" "C1")
    (property "Value" "100n")
    (pad "1" smd rect (at -0.8 0) (net 2 "VOUT"))
    (pad "2" smd rect (at 0.8 0) (net 3 "GND"))
  )
  (segment (start 10.8 10) (end 19.2 10) (width 0.25) (layer "F.Cu") (net 2))
)`;

const SAMPLE_SPICE_RC = `* RC Low-Pass Filter & Divider
V1 vin 0 DC 5 AC 1
R1 vin vout 1k
C1 vout 0 100n
.end
`;

const SAMPLE_SPICE_DIVIDER = `* 5V Resistive Voltage Divider
V1 vin 0 5
R1 vin mid 10k
R2 mid 0 10k
.end
`;

const SAMPLE_CIRCUIT_JSON = JSON.stringify([
  { type: "pcb_board", center: { x: 0, y: 0 }, width: 30, height: 20 },
  {
    type: "source_component",
    source_component_id: "sc_r1",
    name: "R1",
    ftype: "simple_resistor",
    display_value: "4.7k",
  },
  {
    type: "source_component",
    source_component_id: "sc_r2",
    name: "R2",
    ftype: "simple_resistor",
    display_value: "4.7k",
  },
  {
    type: "source_port",
    source_port_id: "sp_r1_1",
    source_component_id: "sc_r1",
    name: "pin1",
    pin_number: 1,
  },
  {
    type: "source_port",
    source_port_id: "sp_r1_2",
    source_component_id: "sc_r1",
    name: "pin2",
    pin_number: 2,
  },
  {
    type: "source_port",
    source_port_id: "sp_r2_1",
    source_component_id: "sc_r2",
    name: "pin1",
    pin_number: 1,
  },
  {
    type: "source_port",
    source_port_id: "sp_r2_2",
    source_component_id: "sc_r2",
    name: "pin2",
    pin_number: 2,
  },
  { type: "source_net", source_net_id: "sn_vcc", name: "+3V3" },
  { type: "source_net", source_net_id: "sn_gnd", name: "GND" },
  {
    type: "source_trace",
    connected_source_port_ids: ["sp_r1_1"],
    connected_source_net_ids: ["sn_vcc"],
    display_name: "+3V3",
  },
  {
    type: "source_trace",
    connected_source_port_ids: ["sp_r1_2", "sp_r2_1"],
    display_name: "MID",
  },
  {
    type: "source_trace",
    connected_source_port_ids: ["sp_r2_2"],
    connected_source_net_ids: ["sn_gnd"],
    display_name: "GND",
  },
]);

describe("Electronics parsers, path tracer, validator, and MNA simulator", () => {
  it("parses KiCad schematic connectivity, BOM, and traces multi-hop paths across resistors", () => {
    const model = parseElectronicsFile("boards/power.kicad_sch", SAMPLE_KICAD_SCH);
    expect(model.format).toBe("kicad_sch");
    expect(model.title).toBe("Sensor Power & Divider");
    expect(model.nets.map((n) => n.name)).toEqual(
      expect.arrayContaining(["+5V", "+3V3", "VSENSE", "GND"]),
    );

    // BOM groups R1 and R2 (both 10k 0603) and excludes #PWR symbols
    const rBom = model.bom.find((entry) => entry.value === "10k");
    expect(rBom?.quantity).toBe(2);
    expect(rBom?.refs).toEqual(["R1", "R2"]);

    // Direct connection U1.VOUT -> R1.1 on +3V3
    const direct = traceCircuitPath(model, { from: "U1.VOUT", to: "R1.1" });
    expect(direct.connected).toBe(true);
    expect(direct.directNet).toBe("+3V3");
    expect(direct.estimatedResistanceOhms).toBe(0);

    // Multi-hop connection U1.VOUT -> VSENSE through R1 (10k)
    const multi = traceCircuitPath(model, { from: "U1.VOUT", to: "VSENSE" });
    expect(multi.connected).toBe(true);
    expect(multi.hops.map((h) => h.name)).toEqual(["+3V3", "R1", "VSENSE"]);
    expect(multi.estimatedResistanceOhms).toBe(10_000);
  });

  it("parses KiCad PCB footprints, pads, tracks, and verifies routed vs unrouted nets", () => {
    const model = parseElectronicsFile("boards/filter.kicad_pcb", SAMPLE_KICAD_PCB);
    expect(model.format).toBe("kicad_pcb");
    expect(model.boardOutline.length).toBe(4);
    expect(model.wires.length).toBe(1);
    expect(model.components.map((c) => c.ref)).toEqual(["R1", "C1"]);

    // VOUT is routed cleanly between R1.2 and C1.1
    const validation = runBuiltinCircuitValidation(model);
    expect(validation.issues.some((i) => i.code === "unrouted_pcb_net")).toBe(false);

    // Break the track -> unrouted_pcb_net warning must trigger!
    const brokenPcb = SAMPLE_KICAD_PCB.replace(
      '(segment (start 10.8 10) (end 19.2 10) (width 0.25) (layer "F.Cu") (net 2))',
      "",
    );
    const brokenModel = parseElectronicsFile("boards/filter-broken.kicad_pcb", brokenPcb);
    const brokenVal = runBuiltinCircuitValidation(brokenModel);
    expect(brokenVal.issues.some((i) => i.code === "unrouted_pcb_net" && i.net === "VOUT")).toBe(
      true,
    );
  });

  it("flags power rail shorts, duplicate designators, single-pin nets, and missing decoupling", () => {
    const shortedSch = SAMPLE_KICAD_SCH.replace(
      "(wire (pts (xy 60 48.81) (xy 35 45)))",
      "(wire (pts (xy 60 48.81) (xy 35 45)))\n  (wire (pts (xy 20 30) (xy 35 45)))",
    );
    const model = parseElectronicsFile("boards/short.kicad_sch", shortedSch);
    const { issues } = runBuiltinCircuitValidation(model);
    const report = assembleValidationReport({
      model,
      builtinIssues: issues,
      externalIssues: [],
      enginesUsed: ["builtin"],
      notes: [],
    });
    expect(report.passed).toBe(false);
    expect(report.issues.some((i) => i.code === "power_rail_short")).toBe(true);
    expect(report.issues.some((i) => i.code === "missing_decoupling")).toBe(true);
  });

  it("parses Circuit JSON and traces multi-hop paths", () => {
    const model = parseElectronicsFile("demo.circuit.json", SAMPLE_CIRCUIT_JSON);
    expect(model.format).toBe("circuit_json");
    expect(model.components.map((c) => c.ref)).toEqual(["R1", "R2"]);
    expect(model.boardOutline.length).toBe(4);
    const trace = traceCircuitPath(model, { from: "+3V3", to: "MID" });
    expect(trace.connected).toBe(true);
    expect(trace.estimatedResistanceOhms).toBe(4700);
  });

  it("solves DC operating point accurately using built-in MNA solver", () => {
    const model = parseElectronicsFile("sim/divider.cir", SAMPLE_SPICE_DIVIDER);
    const dc = runBuiltinMnaSimulation(model, { kind: "dc_op", outputNode: "mid" });
    expect(dc.engine).toBe("builtin_mna");
    const mid = dc.nodeVoltages.find((n) => n.node === "mid");
    expect(mid?.voltageV).toBeCloseTo(2.5, 4);
    const r1 = dc.componentReadings.find((c) => c.ref === "R1");
    expect(r1?.currentA).toBeCloseTo(0.00025, 6);
    expect(r1?.powerW).toBeCloseTo(0.000625, 6);
  });

  it("computes accurate RC low-pass AC Bode sweep (-3 dB cutoff at 1/(2*pi*R*C)) and transient step response", () => {
    const model = parseElectronicsFile("sim/rc_filter.cir", SAMPLE_SPICE_RC);
    const ac = runBuiltinMnaSimulation(model, {
      kind: "ac_sweep",
      outputNode: "vout",
      startFreqHz: 10,
      stopFreqHz: 1_000_000,
      pointsPerDecade: 20,
    });
    expect(ac.series.length).toBe(1);
    const cutoffMetric = ac.metrics.find((m) => m.name === "-3 dB Cutoff");
    // Exact fc = 1 / (2 * pi * 1000 * 100e-9) = 1591.55 Hz
    expect(cutoffMetric).toBeDefined();
    expect(cutoffMetric!.value).toBeGreaterThan(1500);
    expect(cutoffMetric!.value).toBeLessThan(1680);

    const pulseModel = parseElectronicsFile(
      "sim/rc_pulse.cir",
      "* RC Step\nV1 vin 0 PULSE(0 5 0 1n 1n 5m 10m)\nR1 vin vout 1k\nC1 vout 0 100n\n.end\n",
    );
    const tran = runBuiltinMnaSimulation(pulseModel, {
      kind: "transient",
      outputNode: "vout",
      stopTimeSeconds: 1e-3,
    });
    expect(tran.series.length).toBeGreaterThanOrEqual(1);
    const outTrace = tran.series.find((s) => s.label === "V(vout)");
    expect(outTrace).toBeDefined();
    expect(outTrace!.points[0]!.y).toBeCloseTo(0, 3);
    const finalV = outTrace!.points[outTrace!.points.length - 1]!.y;
    // After 10*tau (tau = 0.1ms), capacitor charges to ~5V
    expect(finalV).toBeGreaterThan(4.9);
  });

  it("handles SPICE femto suffix, case-insensitive SPICE nets, 1M vs 1m, value params, IC1, SPICE VSS, AC excitation, and MNA cap", () => {
    expect(parseEngineeringNumber("10f", { spice: true })).toBeCloseTo(1e-14, 20);
    expect(parseEngineeringNumber("10uF")).toBeCloseTo(1e-5, 12);
    expect(parseEngineeringNumber("1F")).toBeCloseTo(1, 12);
    // KiCad/schematic uppercase M is Megaohm, lowercase m is milliohm; SPICE keeps m/M as milli and meg as Mega
    expect(parseEngineeringNumber("1M")).toBeCloseTo(1e6, 2);
    expect(parseEngineeringNumber("1m")).toBeCloseTo(1e-3, 9);
    expect(parseEngineeringNumber("1M", { spice: true })).toBeCloseTo(1e-3, 9);
    expect(parseEngineeringNumber("1meg", { spice: true })).toBeCloseTo(1e6, 2);
    // Trailing SPICE/KiCad parameters like TC=0,0 do not break engineering value parsing
    expect(parseEngineeringNumber("1k TC=0,0", { spice: true })).toBeCloseTo(1000, 6);

    // SPICE node names are case-insensitive (in === IN)
    const caseModel = parseElectronicsFile(
      "sim/case.cir",
      "* Mixed case divider\nV1 IN 0 5\nR1 in out 1k TC=0,0\nR2 OUT 0 1k\n.end\n",
    );
    const caseDc = runBuiltinMnaSimulation(caseModel, { kind: "dc_op", outputNode: "OUT" });
    expect(caseDc.nodeVoltages.find((n) => n.node === "out")?.voltageV).toBeCloseTo(2.5, 4);
    const traceCase = traceCircuitPath(caseModel, { from: "IN", to: "R1.1" });
    expect(traceCase.connected).toBe(true);
    expect(traceCase.directNet).toBe("in");

    // Non-SPICE IC1 / LED1 / CON1 must NOT be misclassified as I/L/C sources/reactives
    const icDividerSch = `(kicad_sch
  (lib_symbols
    (symbol "Device:R"
      (symbol "R_1_1"
        (pin passive line (at 0 2 270) (length 1) (name "1") (number "1"))
        (pin passive line (at 0 -2 90) (length 1) (name "2") (number "2"))
      )
    )
    (symbol "Simulation_SPICE:VDC"
      (symbol "VDC_1_1"
        (pin power_out line (at 0 2 270) (length 1) (name "+") (number "1"))
        (pin power_in line (at 0 -2 90) (length 1) (name "-") (number "2"))
      )
    )
    (symbol "Sensor:IC"
      (symbol "IC_1_1"
        (pin input line (at -2 0 0) (length 1) (name "IN") (number "1"))
        (pin power_in line (at 2 0 180) (length 1) (name "GND") (number "2"))
      )
    )
    (symbol "power:GND" (power)
      (symbol "GND_0_1"
        (pin power_in line (at 0 0 90) (length 0) (name "GND") (number "1"))
      )
    )
  )
  (symbol (lib_id "Simulation_SPICE:VDC") (at 10 25 0) (unit 1) (property "Reference" "V1") (property "Value" "5"))
  (symbol (lib_id "Device:R") (at 20 20 0) (unit 1) (property "Reference" "R1") (property "Value" "1M"))
  (symbol (lib_id "Device:R") (at 20 30 0) (unit 1) (property "Reference" "R2") (property "Value" "1k"))
  (symbol (lib_id "Sensor:IC") (at 40 25 0) (unit 1) (property "Reference" "IC1") (property "Value" "10u"))
  (symbol (lib_id "power:GND") (at 20 32 0) (unit 1) (property "Reference" "#PWR01") (property "Value" "GND"))
  (wire (pts (xy 10 23) (xy 10 18)))
  (wire (pts (xy 10 18) (xy 20 18)))
  (wire (pts (xy 10 27) (xy 10 32)))
  (wire (pts (xy 10 32) (xy 20 32)))
  (wire (pts (xy 20 22) (xy 20 28)))
  (wire (pts (xy 20 25) (xy 38 25)))
  (wire (pts (xy 42 25) (xy 42 32)))
  (wire (pts (xy 20 32) (xy 42 32)))
  (label "+5V" (at 20 18 0))
  (label "VSENSE" (at 20 25 0))
)`;
    const icModel = parseElectronicsFile("sch/ic_divider.kicad_sch", icDividerSch);
    const icDc = runBuiltinMnaSimulation(icModel, { kind: "dc_op", outputNode: "VSENSE" });
    // 5V * 1k / (1M + 1k) ≈ 4.995 mV, NOT 5V or corrupted by IC1 as 10uA current source
    const vsense = icDc.nodeVoltages.find((n) => n.node === "VSENSE")?.voltageV;
    expect(vsense).toBeDefined();
    expect(vsense!).toBeCloseTo(0.004995, 5);
    expect(icDc.notes.some((n) => n.includes("IC1"))).toBe(true);

    // SPICE node VSS is NOT implicitly forced to ground 0
    const vssModel = parseElectronicsFile(
      "sim/vss.cir",
      "* Split supply\nVneg VSS 0 -5\nR1 VSS 0 1k\n.end\n",
    );
    const vssDc = runBuiltinMnaSimulation(vssModel, { kind: "dc_op", outputNode: "vss" });
    expect(vssDc.nodeVoltages.find((n) => n.node === "vss")?.voltageV).toBeCloseTo(-5, 4);

    // Invalid transient stopTimeSeconds=0 fails cleanly instead of producing NaN
    expect(() =>
      runBuiltinMnaSimulation(vssModel, { kind: "transient", stopTimeSeconds: 0 }),
    ).toThrow(/positive finite/i);

    // DC-only supply must NOT be excited during AC sweep when another source has AC 1
    const dualSrc = parseElectronicsFile(
      "sim/dual_ac.cir",
      "* Dual source AC\nVdd vdd 0 DC 5\nVin vin 0 DC 0 AC 1\nR1 vdd out 1k\nR2 vin out 1k\n.end\n",
    );
    const dualAc = runBuiltinMnaSimulation(dualSrc, {
      kind: "ac_sweep",
      outputNode: "out",
      startFreqHz: 100,
      stopFreqHz: 1000,
      pointsPerDecade: 4,
    });
    // Voltage divider of AC 1 across equal 1k resistors = 0.5 (-6.02 dB), NOT 1.0 (0 dB)
    expect(dualAc.series[0]!.points[0]!.y).toBeCloseTo(-6.02, 1);

    // Matrix size cap rejects huge ladders before dense allocation
    const ladderLines = ["* Huge ladder", "V1 n0 0 5"];
    for (let i = 0; i < 300; i += 1) {
      ladderLines.push(`R${i + 1} n${i} n${i + 1} 1k`);
    }
    ladderLines.push("Rend n300 0 1k", ".end");
    const hugeModel = parseElectronicsFile("sim/huge.cir", ladderLines.join("\n"));
    expect(() => runBuiltinMnaSimulation(hugeModel, { kind: "dc_op" })).toThrow(/exceeding/i);
  });

  it("handles PWR_FLAG, derived lib symbols (extends), extreme coordinates, multi-unit BOM/trace, and PCB copper gaps", () => {
    // PWR_FLAG on both +5V and GND must NOT short them into one PWR_FLAG net, and must satisfy power_out check
    const pwrFlagSch = `(kicad_sch
  (lib_symbols
    (symbol "power:PWR_FLAG" (power)
      (symbol "PWR_FLAG_0_1"
        (pin power_out line (at 0 0 90) (length 0) (name "pwr") (number "1"))
      )
    )
    (symbol "power:+5V" (power)
      (symbol "+5V_0_1"
        (pin power_in line (at 0 0 270) (length 0) (name "+5V") (number "1"))
      )
    )
    (symbol "power:GND" (power)
      (symbol "GND_0_1"
        (pin power_in line (at 0 0 90) (length 0) (name "GND") (number "1"))
      )
    )
    (symbol "Device:R"
      (symbol "R_1_1"
        (pin passive line (at 0 2 270) (length 1) (name "1") (number "1"))
        (pin passive line (at 0 -2 90) (length 1) (name "2") (number "2"))
      )
    )
    (symbol "Device:R_Derived" (extends "Device:R"))
  )
  (symbol (lib_id "power:+5V") (at 10 10 0) (unit 1) (property "Reference" "#PWR01") (property "Value" "+5V"))
  (symbol (lib_id "power:PWR_FLAG") (at 10 10 0) (unit 1) (property "Reference" "#FLG01") (property "Value" "PWR_FLAG"))
  (symbol (lib_id "Device:R_Derived") (at 10 20 0) (unit 1) (property "Reference" "R1") (property "Value" "10k"))
  (symbol (lib_id "power:GND") (at 10 30 0) (unit 1) (property "Reference" "#PWR02") (property "Value" "GND"))
  (symbol (lib_id "power:PWR_FLAG") (at 10 30 0) (unit 1) (property "Reference" "#FLG02") (property "Value" "PWR_FLAG"))
  (wire (pts (xy 10 10) (xy 10 18)))
  (wire (pts (xy 10 22) (xy 10 30)))
)`;
    const pwrModel = parseElectronicsFile("sch/pwrflag.kicad_sch", pwrFlagSch);
    const pwrNetNames = pwrModel.nets.map((n) => n.name);
    expect(pwrNetNames).toContain("+5V");
    expect(pwrNetNames).toContain("GND");
    expect(pwrNetNames).not.toContain("PWR_FLAG");
    // Derived symbol R_Derived inherited its 2 pins from Device:R
    const derivedR1 = pwrModel.components.find((c) => c.ref === "R1");
    expect(derivedR1?.pins).toHaveLength(2);
    const pwrVal = runBuiltinCircuitValidation(pwrModel);
    expect(pwrVal.issues.some((i) => i.code === "power_ground_short")).toBe(false);
    expect(pwrVal.issues.some((i) => i.code === "undriven_power_net")).toBe(false);

    // Extreme coordinate (1e20) must not hang spatial grid indexing
    const extremeSch = `(kicad_sch
  (wire (pts (xy 0 0) (xy 1e20 0)))
)`;
    const extremeModel = parseElectronicsFile("sch/extreme.kicad_sch", extremeSch);
    expect(extremeModel.parseWarnings.some((w) => /coordinate/i.test(w))).toBe(true);

    // Multi-unit symbol: BOM counts U1 once (qty 1), and traceCircuitPath finds unit 2 pin U1.5
    const multiUnitSch = `(kicad_sch
  (lib_symbols
    (symbol "OpAmp:LM358"
      (symbol "LM358_1_1"
        (pin input line (at -5 0 0) (length 2) (name "IN1") (number "3"))
      )
      (symbol "LM358_2_1"
        (pin input line (at -5 0 0) (length 2) (name "IN2") (number "5"))
      )
    )
  )
  (symbol (lib_id "OpAmp:LM358") (at 20 20 0) (unit 1)
    (property "Reference" "U1")
    (property "Value" "LM358")
  )
  (symbol (lib_id "OpAmp:LM358") (at 50 20 0) (unit 2)
    (property "Reference" "U1")
    (property "Value" "LM358")
  )
  (wire (pts (xy 45 20) (xy 40 20)))
  (label "SIG_IN2" (at 40 20 0))
)`;
    const muModel = parseElectronicsFile("sch/multi.kicad_sch", multiUnitSch);
    expect(muModel.components.map((c) => c.pins.map((p) => p.number))).toEqual([["3"], ["5"]]);
    expect(muModel.bom.find((b) => b.value === "LM358")?.quantity).toBe(1);
    const muTrace = traceCircuitPath(muModel, { from: "U1.5", to: "SIG_IN2" });
    expect(muTrace.connected).toBe(true);
    const muVal = runBuiltinCircuitValidation(muModel);
    expect(muVal.issues.some((i) => i.code === "duplicate_reference")).toBe(false);

    // PCB copper width tolerance: 0.10mm tracks with a 0.20mm gap must be flagged unrouted AND traceCircuitPath returns connected: false
    const pcbGap = `(kicad_pcb
  (footprint "R_0603" (layer "F.Cu") (at 10 10)
    (property "Reference" "R1") (property "Value" "1k")
    (pad "1" smd rect (at 0 0) (size 0.5 0.5) (layers "F.Cu") (net "SIG"))
  )
  (footprint "R_0603" (layer "F.Cu") (at 20 10)
    (property "Reference" "R2") (property "Value" "1k")
    (pad "1" smd rect (at 0 0) (size 0.5 0.5) (layers "F.Cu") (net "SIG"))
  )
  (segment (start 10 10) (end 14.9 10) (width 0.1) (layer "F.Cu") (net "SIG"))
  (segment (start 15.1 10) (end 20 10) (width 0.1) (layer "F.Cu") (net "SIG"))
)`;
    const gapModel = parseElectronicsFile("pcb/gap.kicad_pcb", pcbGap);
    const gapVal = runBuiltinCircuitValidation(gapModel);
    expect(gapVal.issues.some((i) => i.code === "unrouted_pcb_net" && i.net === "SIG")).toBe(true);
    const gapTrace = traceCircuitPath(gapModel, { from: "R1.1", to: "R2.1" });
    expect(gapTrace.connected).toBe(false);
    expect(gapTrace.warnings.some((w) => /unrouted/i.test(w))).toBe(true);

    // KiCad 10 name-based PCB nets: F.Cu pads with a B.Cu track and no via MUST flag unrouted
    const kicad10Pcb = `(kicad_pcb
  (footprint "R_0603" (layer "F.Cu") (at 10 10)
    (property "Reference" "R1") (property "Value" "1k")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "SIG"))
  )
  (footprint "R_0603" (layer "F.Cu") (at 20 10)
    (property "Reference" "R2") (property "Value" "1k")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "SIG"))
  )
  (segment (start 10 10) (end 20 10) (width 0.25) (layer "B.Cu") (net "SIG"))
)`;
    const k10Model = parseElectronicsFile("pcb/k10.kicad_pcb", kicad10Pcb);
    expect(k10Model.nets.map((n) => n.name)).toContain("SIG");
    const k10Val = runBuiltinCircuitValidation(k10Model);
    expect(k10Val.issues.some((i) => i.code === "unrouted_pcb_net" && i.net === "SIG")).toBe(true);

    // Circuit JSON: two traces sharing one source_net_id unify even with different display_names
    const cjTwoTraces = JSON.stringify([
      {
        type: "source_component",
        source_component_id: "c1",
        name: "R1",
        ftype: "simple_resistor",
        resistance: 1000,
      },
      {
        type: "source_component",
        source_component_id: "c2",
        name: "R2",
        ftype: "simple_resistor",
        resistance: 2000,
      },
      { type: "source_port", source_port_id: "p1", source_component_id: "c1", pin_number: 1 },
      { type: "source_port", source_port_id: "p2", source_component_id: "c2", pin_number: 1 },
      { type: "source_net", source_net_id: "sn1", name: "SHARED_BUS" },
      {
        type: "source_trace",
        display_name: "seg_a",
        connected_source_port_ids: ["p1"],
        connected_source_net_ids: ["sn1"],
      },
      {
        type: "source_trace",
        display_name: "seg_b",
        connected_source_port_ids: ["p2"],
        connected_source_net_ids: ["sn1"],
      },
    ]);
    const cjModel = parseElectronicsFile("two.circuit.json", cjTwoTraces);
    const cjTrace = traceCircuitPath(cjModel, { from: "R1.1", to: "R2.1" });
    expect(cjTrace.connected).toBe(true);
    expect(cjTrace.directNet).toBe("SHARED_BUS");
  });

  it("handles deep (extends ...) chains in O(N), PCB T-junctions, PCB passive copper checks, and exact AC ranges", () => {
    // Deep 30-level derived symbol chain must resolve quickly without exponential blowup
    const libEntries: string[] = [
      `    (symbol "Base:Sym0" (symbol "Sym0_1_1" (pin passive line (at 0 0 0) (length 1) (name "1") (number "1"))))`,
    ];
    for (let i = 1; i <= 30; i += 1) {
      libEntries.push(`    (symbol "Base:Sym${i}" (extends "Base:Sym${i - 1}"))`);
    }
    const deepExtendsSch = `(kicad_sch
  (lib_symbols
${libEntries.join("\n")}
  )
  (symbol (lib_id "Base:Sym30") (at 10 10 0) (unit 1) (property "Reference" "R1") (property "Value" "10k"))
)`;
    const deepModel = parseElectronicsFile("sch/deep_extends.kicad_sch", deepExtendsSch);
    expect(deepModel.components.find((c) => c.ref === "R1")?.pins).toHaveLength(1);

    // PCB T-junction: (0,0)->(10,0) with branch (5,0)->(5,5) must connect R1.1, R2.1, and R3.1
    const tJunctionPcb = `(kicad_pcb
  (footprint "R_0603" (layer "F.Cu") (at 0 0)
    (property "Reference" "R1") (property "Value" "1k")
    (pad "1" smd rect (at 0 0) (size 0.6 0.6) (layers "F.Cu") (net "BUS"))
  )
  (footprint "R_0603" (layer "F.Cu") (at 10 0)
    (property "Reference" "R2") (property "Value" "1k")
    (pad "1" smd rect (at 0 0) (size 0.6 0.6) (layers "F.Cu") (net "BUS"))
  )
  (footprint "R_0603" (layer "F.Cu") (at 5 5)
    (property "Reference" "R3") (property "Value" "1k")
    (pad "1" smd rect (at 0 0) (size 0.6 0.6) (layers "F.Cu") (net "BUS"))
  )
  (segment (start 0 0) (end 10 0) (width 0.25) (layer "F.Cu") (net "BUS"))
  (segment (start 5 0) (end 5 5) (width 0.25) (layer "F.Cu") (net "BUS"))
)`;
    const tjModel = parseElectronicsFile("pcb/tjunction.kicad_pcb", tJunctionPcb);
    const tjVal = runBuiltinCircuitValidation(tjModel);
    expect(tjVal.issues.some((i) => i.code === "unrouted_pcb_net")).toBe(false);
    expect(traceCircuitPath(tjModel, { from: "R1.1", to: "R3.1" }).connected).toBe(true);

    // PCB multi-hop passive trace: J1.1 -> R1 -> J2.1 with ZERO tracks must return connected: false
    const unroutedPassivePcb = `(kicad_pcb
  (footprint "Conn" (layer "F.Cu") (at 0 0)
    (property "Reference" "J1") (property "Value" "IN")
    (pad "1" smd rect (at 0 0) (size 0.6 0.6) (layers "F.Cu") (net "NET_A"))
  )
  (footprint "R_0603" (layer "F.Cu") (at 10 0)
    (property "Reference" "R1") (property "Value" "1k")
    (pad "1" smd rect (at -1 0) (size 0.6 0.6) (layers "F.Cu") (net "NET_A"))
    (pad "2" smd rect (at 1 0) (size 0.6 0.6) (layers "F.Cu") (net "NET_B"))
  )
  (footprint "Conn" (layer "F.Cu") (at 20 0)
    (property "Reference" "J2") (property "Value" "OUT")
    (pad "1" smd rect (at 0 0) (size 0.6 0.6) (layers "F.Cu") (net "NET_B"))
  )
)`;
    const unroutedModel = parseElectronicsFile(
      "pcb/unrouted_passive.kicad_pcb",
      unroutedPassivePcb,
    );
    const unroutedTrace = traceCircuitPath(unroutedModel, { from: "J1.1", to: "J2.1" });
    expect(unroutedTrace.connected).toBe(false);
    expect(unroutedTrace.warnings.some((w) => /unrouted/i.test(w))).toBe(true);

    // Once copper tracks route both NET_A and NET_B, the same passive path connects with 1000 Ω
    const routedPassivePcb = `${unroutedPassivePcb.slice(0, -1)}
  (segment (start 0 0) (end 9 0) (width 0.25) (layer "F.Cu") (net "NET_A"))
  (segment (start 11 0) (end 20 0) (width 0.25) (layer "F.Cu") (net "NET_B"))
)`;
    const routedModel = parseElectronicsFile("pcb/routed_passive.kicad_pcb", routedPassivePcb);
    const routedTrace = traceCircuitPath(routedModel, { from: "J1.1", to: "J2.1" });
    expect(routedTrace.connected).toBe(true);
    expect(routedTrace.estimatedResistanceOhms).toBeCloseTo(1000, 3);

    // Explicit narrow AC sweep 100..200 Hz must stop at 200 Hz (not 1000 Hz) and reject reversed range
    const rcModel = parseElectronicsFile(
      "sim/narrow_ac.cir",
      "* Narrow AC\nV1 in 0 AC 1\nR1 in out 1k\nC1 out 0 100n\n.end\n",
    );
    const narrowAc = runBuiltinMnaSimulation(rcModel, {
      kind: "ac_sweep",
      outputNode: "OUT",
      startFreqHz: 100,
      stopFreqHz: 200,
      pointsPerDecade: 12,
    });
    const pts = narrowAc.series[0]!.points;
    expect(pts[0]!.x).toBeCloseTo(100, 1);
    expect(pts[pts.length - 1]!.x).toBeCloseTo(200, 1);
    expect(() =>
      runBuiltinMnaSimulation(rcModel, { kind: "ac_sweep", startFreqHz: 200, stopFreqHz: 100 }),
    ).toThrow(/stopFreqHz > startFreqHz/i);

    // Explicit unknown outputNode or ground node on AC must fail loudly instead of silently plotting `out`
    expect(() =>
      runBuiltinMnaSimulation(rcModel, { kind: "ac_sweep", outputNode: "typo" }),
    ).toThrow(/not found/i);
    expect(() => runBuiltinMnaSimulation(rcModel, { kind: "ac_sweep", outputNode: "GND" })).toThrow(
      /ground/i,
    );
    const gndDc = runBuiltinMnaSimulation(rcModel, { kind: "dc_op", outputNode: "GND" });
    expect(gndDc.metrics[0]).toEqual({ name: "V(GND)", value: 0, unit: "V" });
  });

  it("enforces pad-geometry copper clearance, multi-net connector routing, KiCad 10 numeric nets, SPICE 1M trace resistance, and Circuit JSON rail shorts", () => {
    // 0.20mm square pad centered 0.40mm from a 0.10mm trace has a 0.25mm copper gap -> MUST NOT connect
    const padGapPcb = `(kicad_pcb
  (footprint "Tiny" (layer "F.Cu") (at 0 0)
    (property "Reference" "R1") (property "Value" "1k")
    (pad "1" smd rect (at 0 0) (size 0.2 0.2) (layers "F.Cu") (net "SIG"))
  )
  (footprint "Tiny" (layer "F.Cu") (at 10 0)
    (property "Reference" "R2") (property "Value" "1k")
    (pad "1" smd rect (at 0 0) (size 0.2 0.2) (layers "F.Cu") (net "SIG"))
  )
  (segment (start 0.4 0) (end 9.6 0) (width 0.1) (layer "F.Cu") (net "SIG"))
)`;
    const padGapModel = parseElectronicsFile("pcb/pad_gap.kicad_pcb", padGapPcb);
    expect(traceCircuitPath(padGapModel, { from: "R1.1", to: "R2.1" }).connected).toBe(false);
    expect(
      runBuiltinCircuitValidation(padGapModel).issues.some((i) => i.code === "unrouted_pcb_net"),
    ).toBe(true);

    // Multi-pin connectors sharing one unrouted net AND one routed net: component trace must find the routed net
    const dualConnPcb = `(kicad_pcb
  (footprint "Conn2" (layer "F.Cu") (at 0 0)
    (property "Reference" "J1") (property "Value" "CON")
    (pad "1" smd rect (at 0 0) (size 0.6 0.6) (layers "F.Cu") (net "UNROUTED"))
    (pad "2" smd rect (at 0 5) (size 0.6 0.6) (layers "F.Cu") (net "ROUTED"))
  )
  (footprint "Conn2" (layer "F.Cu") (at 10 0)
    (property "Reference" "J2") (property "Value" "CON")
    (pad "1" smd rect (at 0 0) (size 0.6 0.6) (layers "F.Cu") (net "UNROUTED"))
    (pad "2" smd rect (at 0 5) (size 0.6 0.6) (layers "F.Cu") (net "ROUTED"))
  )
  (segment (start 0 5) (end 10 5) (width 0.25) (layer "F.Cu") (net "ROUTED"))
)`;
    const dualConnModel = parseElectronicsFile("pcb/dual_conn.kicad_pcb", dualConnPcb);
    const connTrace = traceCircuitPath(dualConnModel, { from: "J1", to: "J2" });
    expect(connTrace.connected).toBe(true);
    expect(connTrace.directNet).toBe("ROUTED");

    // KiCad 10 name-based numeric net `(net "12")` without a legacy net table must NOT be dropped
    const k10NumericPcb = `(kicad_pcb
  (footprint "R_0603" (layer "F.Cu") (at 0 0)
    (property "Reference" "R1") (property "Value" "1k")
    (pad "1" smd rect (at 0 0) (size 0.6 0.6) (layers "F.Cu") (net "12"))
  )
  (footprint "R_0603" (layer "F.Cu") (at 10 0)
    (property "Reference" "R2") (property "Value" "1k")
    (pad "1" smd rect (at 0 0) (size 0.6 0.6) (layers "F.Cu") (net "12"))
  )
  (segment (start 0 0) (end 10 0) (width 0.25) (layer "F.Cu") (net "12"))
)`;
    const k10NumModel = parseElectronicsFile("pcb/k10_num.kicad_pcb", k10NumericPcb);
    expect(k10NumModel.nets.map((n) => n.name)).toContain("12");
    expect(traceCircuitPath(k10NumModel, { from: "R1.1", to: "R2.1" }).connected).toBe(true);

    // SPICE path trace through `R1 in out 1M` must report 0.001 Ω (SPICE milli), NOT 1,000,000 Ω
    const spiceMilliModel = parseElectronicsFile(
      "sim/milli.cir",
      "* Shunt\nV1 in 0 5\nR1 in out 1M\nR2 out 0 10\n.end\n",
    );
    const spiceMilliTrace = traceCircuitPath(spiceMilliModel, { from: "in", to: "out" });
    expect(spiceMilliTrace.connected).toBe(true);
    expect(spiceMilliTrace.estimatedResistanceOhms).toBeCloseTo(0.001, 6);
    expect(spiceMilliTrace.warnings.some((w) => /High series resistance/i.test(w))).toBe(false);

    // Circuit JSON joining VCC and GND must preserve both rail names and trigger power_rail_short
    const cjShort = JSON.stringify([
      {
        type: "source_component",
        source_component_id: "c1",
        name: "J1",
        ftype: "simple_pin_header",
      },
      { type: "source_port", source_port_id: "p1", source_component_id: "c1", pin_number: 1 },
      { type: "source_port", source_port_id: "p2", source_component_id: "c1", pin_number: 2 },
      { type: "source_net", source_net_id: "n_gnd", name: "GND" },
      { type: "source_net", source_net_id: "n_vcc", name: "VCC" },
      {
        type: "source_trace",
        connected_source_port_ids: ["p1", "p2"],
        connected_source_net_ids: ["n_gnd", "n_vcc"],
      },
    ]);
    const cjShortModel = parseElectronicsFile("short.circuit.json", cjShort);
    const cjShortVal = runBuiltinCircuitValidation(cjShortModel);
    expect(cjShortVal.issues.some((i) => i.code === "power_rail_short")).toBe(true);

    // Circuit JSON joining ground aliases (GND + VSS) must NOT falsely flag power_rail_short
    const cjGndAliases = JSON.stringify([
      {
        type: "source_component",
        source_component_id: "c1",
        name: "J1",
        ftype: "simple_pin_header",
      },
      { type: "source_port", source_port_id: "p1", source_component_id: "c1", pin_number: 1 },
      { type: "source_port", source_port_id: "p2", source_component_id: "c1", pin_number: 2 },
      { type: "source_net", source_net_id: "n_gnd", name: "GND" },
      { type: "source_net", source_net_id: "n_vss", name: "VSS" },
      {
        type: "source_trace",
        connected_source_port_ids: ["p1", "p2"],
        connected_source_net_ids: ["n_gnd", "n_vss"],
      },
    ]);
    const cjGndModel = parseElectronicsFile("gnd_alias.circuit.json", cjGndAliases);
    expect(
      runBuiltinCircuitValidation(cjGndModel).issues.some((i) => i.code === "power_rail_short"),
    ).toBe(false);

    // Circular 2mm pad at (0,0) with 0.1mm trace starting at (0.9, 0.9) has a ~0.223mm gap -> MUST NOT connect
    const circleGapPcb = `(kicad_pcb
  (footprint "C1" (layer "F.Cu") (at 0 0)
    (property "Reference" "R1") (property "Value" "1k")
    (pad "1" smd circle (at 0 0) (size 2 2) (layers "F.Cu") (net "SIG"))
  )
  (footprint "C2" (layer "F.Cu") (at 5 5)
    (property "Reference" "R2") (property "Value" "1k")
    (pad "1" smd circle (at 0 0) (size 2 2) (layers "F.Cu") (net "SIG"))
  )
  (segment (start 0.9 0.9) (end 5 5) (width 0.1) (layer "F.Cu") (net "SIG"))
)`;
    const circleGapModel = parseElectronicsFile("pcb/circle_gap.kicad_pcb", circleGapPcb);
    expect(traceCircuitPath(circleGapModel, { from: "R1.1", to: "R2.1" }).connected).toBe(false);
    expect(
      runBuiltinCircuitValidation(circleGapModel).issues.some((i) => i.code === "unrouted_pcb_net"),
    ).toBe(true);

    // Rotated 45° 4x4mm square pad at (2.9, 0) crosses grid boundary x=5 and touches trace at (5.55, 0)
    const rotPadPcb = `(kicad_pcb
  (footprint "Big" (layer "F.Cu") (at 2.9 0)
    (property "Reference" "R1") (property "Value" "1k")
    (pad "1" smd rect (at 0 0 45) (size 4 4) (layers "F.Cu") (net "BUS"))
  )
  (footprint "End" (layer "F.Cu") (at 10 0)
    (property "Reference" "R2") (property "Value" "1k")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "BUS"))
  )
  (segment (start 5.55 0) (end 10 0) (width 0.2) (layer "F.Cu") (net "BUS"))
)`;
    const rotPadModel = parseElectronicsFile("pcb/rot_pad.kicad_pcb", rotPadPcb);
    expect(traceCircuitPath(rotPadModel, { from: "R1.1", to: "R2.1" }).connected).toBe(true);

    // Omitted pad angle on a 90° footprint means board-frame 0° (horizontal 4x1 pad reaches x=1.9)
    const fpRot90Pcb = `(kicad_pcb
  (footprint "HPad" (layer "F.Cu") (at 0 0 90)
    (property "Reference" "R1") (property "Value" "1k")
    (pad "1" smd rect (at 0 0) (size 4 1) (layers "F.Cu") (net "BUS"))
  )
  (footprint "End" (layer "F.Cu") (at 5 0)
    (property "Reference" "R2") (property "Value" "1k")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "BUS"))
  )
  (segment (start 1.9 0) (end 5 0) (width 0.2) (layer "F.Cu") (net "BUS"))
)`;
    const fpRot90Model = parseElectronicsFile("pcb/fp_rot90.kicad_pcb", fpRot90Pcb);
    expect(traceCircuitPath(fpRot90Model, { from: "R1.1", to: "R2.1" }).connected).toBe(true);

    // Spaced schematic resistor value "1 kΩ" parses as 1000 Ω (divider outputs 2.5 V, not 4.995 V)
    const spacedValSch = `(kicad_sch
  (lib_symbols
    (symbol "Device:R"
      (symbol "R_1_1"
        (pin passive line (at 0 2 270) (length 1) (name "1") (number "1"))
        (pin passive line (at 0 -2 90) (length 1) (name "2") (number "2"))
      )
    )
    (symbol "Simulation_SPICE:VDC"
      (symbol "VDC_1_1"
        (pin power_out line (at 0 2 270) (length 1) (name "+") (number "1"))
        (pin power_in line (at 0 -2 90) (length 1) (name "-") (number "2"))
      )
    )
    (symbol "power:GND" (power)
      (symbol "GND_0_1"
        (pin power_in line (at 0 0 90) (length 0) (name "GND") (number "1"))
      )
    )
  )
  (symbol (lib_id "Simulation_SPICE:VDC") (at 10 25 0) (unit 1) (property "Reference" "V1") (property "Value" "5"))
  (symbol (lib_id "Device:R") (at 20 20 0) (unit 1) (property "Reference" "R1") (property "Value" "1 kΩ"))
  (symbol (lib_id "Device:R") (at 20 30 0) (unit 1) (property "Reference" "R2") (property "Value" "1k"))
  (symbol (lib_id "power:GND") (at 20 32 0) (unit 1) (property "Reference" "#PWR01") (property "Value" "GND"))
  (wire (pts (xy 10 23) (xy 10 18)))
  (wire (pts (xy 10 18) (xy 20 18)))
  (wire (pts (xy 10 27) (xy 10 32)))
  (wire (pts (xy 10 32) (xy 20 32)))
  (wire (pts (xy 20 22) (xy 20 28)))
  (label "MID" (at 20 25 0))
)`;
    const spacedModel = parseElectronicsFile("sch/spaced.kicad_sch", spacedValSch);
    const spacedDc = runBuiltinMnaSimulation(spacedModel, { kind: "dc_op", outputNode: "MID" });
    expect(spacedDc.nodeVoltages.find((n) => n.node === "MID")?.voltageV).toBeCloseTo(2.5, 4);
  });
});
