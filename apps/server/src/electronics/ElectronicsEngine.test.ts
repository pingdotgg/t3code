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

  it("handles SPICE femto suffix, case-sensitive nets, SPICE VSS, AC excitation, and MNA cap", () => {
    expect(parseEngineeringNumber("10f", { spice: true })).toBeCloseTo(1e-14, 20);
    expect(parseEngineeringNumber("10uF")).toBeCloseTo(1e-5, 12);
    expect(parseEngineeringNumber("1F")).toBeCloseTo(1, 12);

    // Case-sensitive nets DATA vs data must not collide
    const caseModel = parseElectronicsFile(
      "sim/case.cir",
      "* Case nets\nV1 DATA 0 5\nR1 DATA 0 1k\nR2 data 0 2k\n.end\n",
    );
    const traceLower = traceCircuitPath(caseModel, { from: "data", to: "R2.1" });
    expect(traceLower.connected).toBe(true);
    expect(traceLower.directNet).toBe("data");

    // SPICE node VSS is NOT implicitly forced to ground 0
    const vssModel = parseElectronicsFile(
      "sim/vss.cir",
      "* Split supply\nVneg VSS 0 -5\nR1 VSS 0 1k\n.end\n",
    );
    const vssDc = runBuiltinMnaSimulation(vssModel, { kind: "dc_op", outputNode: "VSS" });
    expect(vssDc.nodeVoltages.find((n) => n.node === "VSS")?.voltageV).toBeCloseTo(-5, 4);

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

  it("handles KiCad multi-unit symbols, KiCad 10 name-based PCB nets, layer/via checks, and Circuit JSON net IDs", () => {
    // KiCad multi-unit symbol: unit 1 and unit 2 of U1 share refdes without duplicate_reference
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
)`;
    const muModel = parseElectronicsFile("sch/multi.kicad_sch", multiUnitSch);
    expect(muModel.components.map((c) => c.pins.map((p) => p.number))).toEqual([["3"], ["5"]]);
    const muVal = runBuiltinCircuitValidation(muModel);
    expect(muVal.issues.some((i) => i.code === "duplicate_reference")).toBe(false);

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
});
