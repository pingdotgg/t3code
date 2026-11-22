import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { parseElectronicsFile } from "./parsers.ts";
import {
  parseKiCadJsonViolations,
  parseNgspiceBatchOutput,
  runNgspiceSimulation,
  sanitizeSpiceDeckLines,
} from "./toolchain.ts";

const makeMockSpawner = (
  handler: (cmd: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd?: string;
  }) => { readonly stdout: string; readonly exitCode?: number },
) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const std = command._tag === "StandardCommand" ? command : null;
      const result = handler({
        command: std?.command ?? "",
        args: (std?.args ?? []).map((a) => String(a)),
        ...(typeof std?.options.cwd === "string" ? { cwd: std.options.cwd } : {}),
      });
      const bytes = new TextEncoder().encode(result.stdout);
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(12345),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode ?? 0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(bytes),
          stderr: Stream.empty,
          all: Stream.make(bytes),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );

describe("ElectronicsToolchain", () => {
  it("blocks dangerous SPICE directives, XSPICE A-elements, comment commands, and ';'-hidden tokens", () => {
    for (const bad of [
      "* bad\n.codemodel /tmp/evil.cm\nV1 in 0 5\n.end",
      "* bad\n.control\nshell id\n.endc\nV1 in 0 5\n.end",
      "* bad\n.shell whoami\nV1 in 0 5\n.end",
      '* bad\nA1 [out] fs\n.model fs filesource(file="/etc/passwd")\n.end',
      '* bad\n.model fs\n+ filesource(file="/etc/passwd")\n.end',
      '* bad\n.model p d_process(process_file="/bin/sh")\n.end',
      '* bad\n.model c d_cosim(simulation="./evil.so")\n.end',
      '* bad\n.model s d_state(state_file="/etc/passwd")\n.end',
      "* bad\nA1 [in] [out] my_xspice_model\n.end",
      '* bad\nR1 in out 1k ; file="/etc/passwd"\n.end',
    ]) {
      const res = sanitizeSpiceDeckLines(bad);
      expect(res.blockedReasons.length).toBeGreaterThan(0);
    }

    // Comment lines including ngspice '*#' control directives are stripped completely
    const commentDeck = sanitizeSpiceDeckLines("* Title\n*#shell id\nV1 in 0 5\nR1 in 0 1k\n.end");
    expect(commentDeck.blockedReasons).toEqual([]);
    expect(commentDeck.lines.some((l) => l.startsWith("*"))).toBe(false);
    expect(commentDeck.lines).toEqual(["V1 in 0 5", "R1 in 0 1k"]);

    // Included files (allowTitleLine: false) must NEVER exempt line 0
    const incFirstLine = sanitizeSpiceDeckLines('V1 in 0 PWL file="/etc/passwd"\n', {
      allowTitleLine: false,
    });
    expect(incFirstLine.blockedReasons.length).toBeGreaterThan(0);
  });

  it("parses real ngspice .op tables (including numeric nodes) and .ac tuples with spaces/tabs after commas", () => {
    const opOut = ["Circuit: * Divider", "v(in) = 5.000000e+00", "v(out) = 2.500000e+00"].join(
      "\n",
    );
    const parsedOp = parseNgspiceBatchOutput(opOut, "dc_op");
    expect(parsedOp.nodeVoltages).toEqual([
      { node: "in", voltageV: 5 },
      { node: "out", voltageV: 2.5 },
    ]);

    const tabularOp = [
      "Node                                  Voltage",
      "----                                  -------",
      "1                                 5.000000e+00",
      "2                                 2.500000e+00",
      "",
      "Source                                Current",
      "------                                -------",
      "v1#branch                        -2.500000e-04",
    ].join("\n");
    const parsedTab = parseNgspiceBatchOutput(tabularOp, "dc_op");
    expect(parsedTab.nodeVoltages).toEqual([
      { node: "1", voltageV: 5 },
      { node: "2", voltageV: 2.5 },
    ]);

    // Real ngspice -b places whitespace/tab after comma in complex AC output
    const acOut = [
      "Index   frequency   vdb(out)   vp(out)",
      "0   1.000000e+02,\t0.000000e+00   -3.010300e+00,\t0.000000e+00   -7.853982e-01,  0.000000e+00",
    ].join("\n");
    const parsedAc = parseNgspiceBatchOutput(acOut, "ac_sweep");
    expect(parsedAc.points.length).toBe(1);
    expect(parsedAc.points[0]!.x).toBe(100);
    expect(parsedAc.points[0]!.y).toBeCloseTo(-3.0103, 3);
    expect(parsedAc.points[0]!.phaseDeg).toBeCloseTo(-45, 1);
  });

  it("validates KiCad JSON report structure and rejects malformed or truncated JSON", () => {
    expect(parseKiCadJsonViolations("{not valid", "kicad_erc").valid).toBe(false);
    expect(parseKiCadJsonViolations("{}", "kicad_drc").valid).toBe(false);
    const ok = parseKiCadJsonViolations(
      JSON.stringify({
        violations: [{ type: "clearance", severity: "error", description: "Too close" }],
      }),
      "kicad_drc",
    );
    expect(ok.valid).toBe(true);
    if (ok.valid) {
      expect(ok.issues.length).toBe(1);
      expect(ok.issues[0]!.severity).toBe("error");
    }
  });

  it.effect(
    "inlines safe workspace includes, passes -n to ngspice, and rejects nested escape includes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ng-root-" });
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ng-out-" });
        yield* fs.writeFileString(path.join(outside, "secret.cir"), "Rsecret a b 1k\n");
        yield* fs.writeFileString(path.join(root, "good.lib"), "R2 out 0 10k\n");
        yield* fs.writeFileString(
          path.join(root, "nested_bad.lib"),
          `.include "${path.join(outside, "secret.cir")}"\n`,
        );

        const goodDeck = `* Divider\nV1 in 0 5\nR1 in out 10k\n.include "good.lib"\n.end\n`;
        const model = parseElectronicsFile("div.cir", goodDeck);
        const capturedCalls: Array<{ args: ReadonlyArray<string>; deckText: string }> = [];

        const spawnerLayer = makeMockSpawner((cmd) => {
          const deckArg = cmd.args[cmd.args.length - 1]!;
          capturedCalls.push({ args: cmd.args, deckText: deckArg });
          return { stdout: "v(in) = 5.000000e+00\nv(out) = 2.500000e+00\n" };
        });

        const goodOutcome = yield* runNgspiceSimulation({
          model,
          spiceSource: goodDeck,
          workspaceRoot: root,
          sourceFilePath: path.join(root, "div.cir"),
          kind: "dc_op",
          outputNode: "out",
        }).pipe(Effect.provide(spawnerLayer));

        expect(goodOutcome.result).not.toBeNull();
        expect(goodOutcome.result?.engine).toBe("ngspice");
        expect(goodOutcome.result?.nodeVoltages.find((n) => n.node === "out")?.voltageV).toBe(2.5);
        expect(capturedCalls[0]?.args[0]).toBe("-n");
        expect(capturedCalls[0]?.args[1]).toBe("-b");

        // Nested include escaping workspace must be rejected BEFORE spawning ngspice
        const badDeck = `* Bad\nV1 in 0 5\n.include "nested_bad.lib"\n.end\n`;
        const badOutcome = yield* runNgspiceSimulation({
          model,
          spiceSource: badDeck,
          workspaceRoot: root,
          sourceFilePath: path.join(root, "bad.cir"),
          kind: "dc_op",
        }).pipe(Effect.provide(spawnerLayer));

        expect(badOutcome.result).toBeNull();
        expect(badOutcome.rejectionNote).toMatch(/Disallowed|escapes/i);
        expect(capturedCalls.length).toBe(1);

        // .spiceinit include must be rejected
        yield* fs.writeFileString(path.join(root, ".spiceinit"), "shell id\n");
        const initDeck = `* Init\nV1 in 0 5\n.include ".spiceinit"\n.end\n`;
        const initOutcome = yield* runNgspiceSimulation({
          model,
          spiceSource: initDeck,
          workspaceRoot: root,
          sourceFilePath: path.join(root, "init.cir"),
          kind: "dc_op",
        }).pipe(Effect.provide(spawnerLayer));
        expect(initOutcome.result).toBeNull();
        expect(initOutcome.rejectionNote).toMatch(/Disallowed/i);

        // First-line unsafe element in an included file AND cross-file '+' continuation attack must be rejected
        yield* fs.writeFileString(
          path.join(root, "firstline_bad.lib"),
          'Vleak a 0 PWL file="/etc/passwd"\n',
        );
        const firstLineOutcome = yield* runNgspiceSimulation({
          model,
          spiceSource: `* Test\nV1 in 0 5\n.include "firstline_bad.lib"\n.end\n`,
          workspaceRoot: root,
          sourceFilePath: path.join(root, "firstline.cir"),
          kind: "dc_op",
        }).pipe(Effect.provide(spawnerLayer));
        expect(firstLineOutcome.result).toBeNull();
        expect(firstLineOutcome.rejectionNote).toMatch(/Disallowed/i);

        yield* fs.writeFileString(
          path.join(root, "cont_bad.lib"),
          '+ filesource(file="/etc/passwd")\n',
        );
        const contOutcome = yield* runNgspiceSimulation({
          model,
          spiceSource: `* Test\n.model leak\n.include "cont_bad.lib"\nV1 in 0 5\n.end\n`,
          workspaceRoot: root,
          sourceFilePath: path.join(root, "cont.cir"),
          kind: "dc_op",
        }).pipe(Effect.provide(spawnerLayer));
        expect(contOutcome.result).toBeNull();
        expect(contOutcome.rejectionNote).toMatch(/Disallowed/i);

        // Non-zero ngspice exit code must be rejected even if partial stdout looks parseable
        const failingSpawner = makeMockSpawner(() => ({
          stdout: "v(out) = 2.500000e+00\n",
          exitCode: 1,
        }));
        const nonzeroOutcome = yield* runNgspiceSimulation({
          model,
          spiceSource: goodDeck,
          workspaceRoot: root,
          sourceFilePath: path.join(root, "div.cir"),
          kind: "dc_op",
        }).pipe(Effect.provide(failingSpawner));
        expect(nonzeroOutcome.result).toBeNull();
        expect(nonzeroOutcome.rejectionNote).toMatch(/non-zero status 1/i);

        // Reversed AC frequency range must be rejected
        const reversedAc = yield* runNgspiceSimulation({
          model,
          spiceSource: goodDeck,
          workspaceRoot: root,
          sourceFilePath: path.join(root, "div.cir"),
          kind: "ac_sweep",
          startFreqHz: 200,
          stopFreqHz: 100,
        }).pipe(Effect.provide(spawnerLayer));
        expect(reversedAc.result).toBeNull();
        expect(reversedAc.rejectionNote).toMatch(/startFreqHz < stopFreqHz/i);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
