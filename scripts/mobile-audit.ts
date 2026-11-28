#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  renderBeforeAfterComparison,
  renderSingleAnnotatedImage,
} from "./mobile-audit/annotate.ts";
import {
  AgentDeviceEnvelopeSchema,
  AuditCaptureSchema,
  AuditPayloadSchema,
  AuditPlatformSchema,
  RawSnapshotDataSchema,
  buildOverlayBoxes,
  diffAuditCaptures,
  findingTag,
  isPlatformNoise,
  renderMarkdownReport,
  resolveViewport,
  unitForPlatform,
  type AuditCapture,
  type AuditPlatform,
  type ScreenDiff,
} from "./mobile-audit/diff.ts";

class MobileAuditError extends Schema.TaggedError<
  MobileAuditError,
  { readonly brand: unique symbol }
>()("MobileAuditError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `${this.operation}: ${this.detail}`;
  }
}

const decodeEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentDeviceEnvelopeSchema));
const decodeAuditPayload = Schema.decodeUnknownEffect(AuditPayloadSchema);
const decodeRawSnapshot = Schema.decodeUnknownEffect(RawSnapshotDataSchema);
const decodeAuditCapture = Schema.decodeUnknownEffect(Schema.fromJsonString(AuditCaptureSchema));
const encodeAuditCapture = Schema.encodeEffect(fromJsonStringPretty(AuditCaptureSchema));
const encodePrettyJson = Schema.encodeEffect(fromJsonStringPretty(Schema.Unknown));

const execAgentDevice = Effect.fn("mobileAudit.execAgentDevice")(function* (
  bin: Option.Option<string>,
  args: ReadonlyArray<string>,
) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const execPath = yield* HostProcess.ExecutablePath;
  const defaultEntry = path.resolve(
    import.meta.dirname,
    "../scripts/node_modules/agent-device/bin/agent-device.mjs",
  );
  const program = Option.isSome(bin) ? bin.value : execPath;
  const fullArgs = Option.isSome(bin) ? [...args] : [defaultEntry, ...args];

  const child = yield* spawner.spawn(
    ChildProcess.make(program, fullArgs, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      Stream.mkString(Stream.decodeText(child.stdout)),
      Stream.mkString(Stream.decodeText(child.stderr)),
      child.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  if (exitCode !== 0) {
    return yield* new MobileAuditError({
      operation: `agent-device ${args[0] ?? ""}`.trim(),
      detail: `exited with ${exitCode}: ${stderr.trim().slice(-600)}`,
    });
  }
  return stdout;
}, Effect.scoped);

const decodeAgentDeviceJson = <S extends Schema.Top>(
  schema: S,
  decodeData: (input: unknown) => Effect.Effect<S["Type"], Schema.SchemaError>,
) =>
  Effect.fn("mobileAudit.decodeJson")(function* (raw: string, label: string) {
    const envelope = yield* decodeEnvelope(raw).pipe(
      Effect.mapError(
        (cause) =>
          new MobileAuditError({
            operation: label,
            detail: "invalid JSON response",
            cause,
          }),
      ),
    );
    if (envelope.success === false) {
      const hint = envelope.error?.hint ? ` (${envelope.error.hint})` : "";
      return yield* new MobileAuditError({
        operation: label,
        detail: `${envelope.error?.message ?? "unknown error"}${hint}`,
      });
    }
    const payload = envelope.data ?? envelope;
    return yield* decodeData(payload).pipe(
      Effect.mapError(
        (cause) =>
          new MobileAuditError({
            operation: label,
            detail: "unexpected payload shape",
            cause,
          }),
      ),
    );
  });

const decodeAuditJson = decodeAgentDeviceJson(AuditPayloadSchema, decodeAuditPayload);
const decodeRawSnapshotJson = decodeAgentDeviceJson(RawSnapshotDataSchema, decodeRawSnapshot);

const runCapture = Effect.fn("mobileAudit.capture")(function* (input: {
  readonly platform: AuditPlatform;
  readonly screen: string;
  readonly out: string;
  readonly agentDevice: Option.Option<string>;
  readonly agentDeviceArgs: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* HostProcess.WorkingDirectory;
  const outRoot = path.resolve(cwd, input.out);
  const platformDir = path.join(outRoot, input.platform);
  yield* fs.makeDirectory(platformDir, { recursive: true });

  const pngPath = path.join(platformDir, `${input.screen}.png`);
  const screenshotArgs =
    input.platform === "ios"
      ? ["screenshot", "--pixel-density", "3", pngPath, ...input.agentDeviceArgs]
      : ["screenshot", pngPath, ...input.agentDeviceArgs];
  yield* execAgentDevice(input.agentDevice, screenshotArgs);

  const auditRaw = yield* execAgentDevice(input.agentDevice, [
    "audit",
    "--json",
    ...input.agentDeviceArgs,
  ]);
  const auditData = yield* decodeAuditJson(auditRaw, "agent-device audit");

  const snapRaw = yield* execAgentDevice(input.agentDevice, [
    "snapshot",
    "--raw",
    "--json",
    ...input.agentDeviceArgs,
  ]);
  const snapData = yield* decodeRawSnapshotJson(snapRaw, "agent-device snapshot");

  const viewport = resolveViewport({}, snapData);
  const capture: AuditCapture = {
    platform: input.platform,
    screen: input.screen,
    ...(viewport === undefined ? {} : { viewport }),
    pixelDensity: input.platform === "android" ? (snapData.androidSnapshot?.pixelDensity ?? 1) : 1,
    findings: auditData.findings ?? [],
    ...(auditData.guidance === undefined ? {} : { guidance: auditData.guidance }),
    ...(auditData.limitations === undefined ? {} : { limitations: auditData.limitations }),
  };

  yield* fs.writeFileString(path.join(platformDir, `${input.screen}.raw.json`), snapRaw);
  const encodedCapture = yield* encodeAuditCapture(capture);
  yield* fs.writeFileString(
    path.join(platformDir, `${input.screen}.audit.json`),
    `${encodedCapture}\n`,
  );

  const unit = unitForPlatform(input.platform);
  yield* Console.log(
    `[${input.platform}] ${input.screen}: ${capture.findings.length} finding(s) -> ${pngPath}`,
  );
  for (const finding of capture.findings) {
    yield* Console.log(
      `  [${finding.kind}] ${finding.role} ${findingTag(finding, capture.pixelDensity, unit)} ${finding.label ? `"${finding.label}"` : "(unnamed)"}`,
    );
  }
});

const listCapturedScreens = Effect.fn("mobileAudit.listCapturedScreens")(function* (
  rootDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const results: Array<{ readonly platform: AuditPlatform; readonly screen: string }> = [];
  for (const platform of AuditPlatformSchema.literals) {
    const dir = path.join(rootDir, platform);
    if (!(yield* fs.exists(dir))) continue;
    const files = (yield* fs.readDirectory(dir)).filter((f) => f.endsWith(".audit.json")).sort();
    for (const file of files) {
      results.push({ platform, screen: file.replace(/\.audit\.json$/, "") });
    }
  }
  return results;
});

const readCaptureSet = Effect.fn("mobileAudit.readCaptureSet")(function* (
  rootDir: string,
  platform: AuditPlatform,
  screen: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = path.join(rootDir, platform, screen);
  const auditPath = `${base}.audit.json`;
  const capture = yield* fs.readFileString(auditPath).pipe(
    Effect.flatMap(decodeAuditCapture),
    Effect.mapError(
      (cause) =>
        new MobileAuditError({
          operation: "readCaptureSet",
          detail: `failed to read ${auditPath}`,
          cause,
        }),
    ),
  );
  const rawPath = `${base}.raw.json`;
  const raw = (yield* fs.exists(rawPath))
    ? yield* fs
        .readFileString(rawPath)
        .pipe(Effect.flatMap((content) => decodeRawSnapshotJson(content, rawPath)))
    : undefined;
  return {
    capture,
    raw,
    pngPath: `${base}.png`,
  };
});

const runCompare = Effect.fn("mobileAudit.compare")(function* (input: {
  readonly before: string;
  readonly after: string;
  readonly out: string;
  readonly beforeLabel: string;
  readonly afterLabel: string;
  readonly all: boolean;
  readonly failOnRegression: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* HostProcess.WorkingDirectory;
  const beforeDir = path.resolve(cwd, input.before);
  const afterDir = path.resolve(cwd, input.after);
  const outDir = path.resolve(cwd, input.out);

  yield* fs.makeDirectory(outDir, { recursive: true });
  const [beforeScreens, afterScreens] = yield* Effect.all([
    listCapturedScreens(beforeDir),
    listCapturedScreens(afterDir),
  ]);
  const afterSet = new Set(afterScreens.map((s) => `${s.platform}/${s.screen}`));
  const pairs = beforeScreens.filter((s) => afterSet.has(`${s.platform}/${s.screen}`));

  if (pairs.length === 0) {
    return yield* new MobileAuditError({
      operation: "compare",
      detail: `no matching <platform>/<screen>.audit.json captures in both ${beforeDir} and ${afterDir}`,
    });
  }

  const diffs: Array<ScreenDiff & { readonly imagePath?: string }> = [];
  for (const pair of pairs) {
    const [before, after] = yield* Effect.all([
      readCaptureSet(beforeDir, pair.platform, pair.screen),
      readCaptureSet(afterDir, pair.platform, pair.screen),
    ]);
    const diff = diffAuditCaptures({
      before: before.capture,
      after: after.capture,
      beforeRaw: before.raw,
      afterRaw: after.raw,
    });

    const hasDelta = diff.fixed.length > 0 || diff.regressions.length > 0;
    const [hasBeforePng, hasAfterPng] = yield* Effect.all([
      fs.exists(before.pngPath),
      fs.exists(after.pngPath),
    ]);
    let imagePath: string | undefined;
    if ((hasDelta || input.all) && hasBeforePng && hasAfterPng) {
      const { beforeBoxes, afterBoxes } = buildOverlayBoxes(
        diff,
        after.capture.pixelDensity || 1,
        before.capture.pixelDensity || 1,
      );
      const outPng = path.join(outDir, `${pair.platform}-${pair.screen}.png`);
      yield* renderBeforeAfterComparison({
        beforePng: before.pngPath,
        beforeBoxes,
        beforeTitle: `${input.beforeLabel} · ${diff.beforeCount} finding(s)`,
        beforeViewport: resolveViewport(before.capture, before.raw),
        afterPng: after.pngPath,
        afterBoxes,
        afterTitle: `${input.afterLabel} · ${diff.afterCount} finding(s) (${diff.fixed.length} fixed, ${diff.regressions.length} new)`,
        afterBannerBg: diff.regressions.length > 0 ? "#b91c1c" : "#15803d",
        afterViewport: resolveViewport(after.capture, after.raw),
        outPath: outPng,
      });
      imagePath = outPng;
    }

    diffs.push({ ...diff, ...(imagePath === undefined ? {} : { imagePath }) });
  }

  const markdown = renderMarkdownReport(diffs);
  const diffJson = yield* encodePrettyJson(diffs);
  yield* fs.writeFileString(path.join(outDir, "diff.json"), `${diffJson}\n`);
  yield* fs.writeFileString(path.join(outDir, "report.md"), markdown);
  yield* Console.log(markdown.trimEnd());

  const totalRegressions = diffs.reduce((n, d) => n + d.regressions.length, 0);
  if (input.failOnRegression && totalRegressions > 0) {
    return yield* new MobileAuditError({
      operation: "compare",
      detail: `${totalRegressions} accessibility regression(s) detected`,
    });
  }
});

const runReport = Effect.fn("mobileAudit.report")(function* (input: {
  readonly dir: string;
  readonly out: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* HostProcess.WorkingDirectory;
  const dir = path.resolve(cwd, input.dir);
  const outDir = path.resolve(cwd, input.out);
  yield* fs.makeDirectory(outDir, { recursive: true });

  const screens = yield* listCapturedScreens(dir);
  const lines: string[] = [
    "### Mobile accessibility audit report (`agent-device audit`)",
    "",
    "| Platform | Screen | Findings |",
    "| --- | --- | ---: |",
  ];

  for (const entry of screens) {
    const { capture, raw, pngPath } = yield* readCaptureSet(dir, entry.platform, entry.screen);
    const viewport = resolveViewport(capture, raw);
    const findings = capture.findings.filter(
      (f) => !isPlatformNoise(f, capture.platform, viewport),
    );
    lines.push(`| ${entry.platform} | \`${entry.screen}\` | ${findings.length} |`);

    if (findings.length > 0 && (yield* fs.exists(pngPath))) {
      const unit = unitForPlatform(entry.platform);
      const boxes = findings
        .filter((f) => f.rect !== undefined)
        .map((f) => ({
          ...f.rect!,
          tag: findingTag(f, capture.pixelDensity || 1, unit),
          color: "#ef4444",
        }));
      const outPng = path.join(outDir, `${entry.platform}-${entry.screen}.png`);
      yield* renderSingleAnnotatedImage({
        pngPath,
        boxes,
        bannerText: `${entry.platform} · ${entry.screen} · ${findings.length} finding(s)`,
        bannerBg: "#b91c1c",
        viewport,
        outPath: outPng,
      });
    }
  }

  const markdown = `${lines.join("\n")}\n`;
  yield* fs.writeFileString(path.join(outDir, "report.md"), markdown);
  yield* Console.log(markdown.trimEnd());
});

const captureCommand = Command.make(
  "capture",
  {
    platform: Flag.Literals("platform", AuditPlatformSchema.literals).pipe(
      Flag.withDescription("Target mobile platform (ios or android)."),
    ),
    screen: Flag.String("screen").pipe(Flag.withDescription("Screen identifier for output files.")),
    out: Flag.String("out").pipe(Flag.withDescription("Directory to write captured artifacts.")),
    agentDevice: Flag.String("agent-device").pipe(
      Flag.withDescription(
        "Optional path to an agent-device launcher; defaults to the workspace CLI.",
      ),
      Flag.optional,
    ),
    agentDeviceArgs: Argument.String("agent-device-arg").pipe(
      Argument.withDescription("Extra arguments forwarded to agent-device (pass after `--`)."),
      Argument.variadic(),
    ),
  },
  (input) => runCapture(input),
).pipe(
  Command.withDescription(
    "Capture a screenshot, native agent-device audit JSON, and raw accessibility snapshot.",
  ),
);

const compareCommand = Command.make(
  "compare",
  {
    before: Flag.String("before").pipe(Flag.withDescription("Baseline capture directory.")),
    after: Flag.String("after").pipe(Flag.withDescription("Candidate capture directory.")),
    out: Flag.String("out").pipe(
      Flag.withDescription("Output directory for diff.json, report.md, and comparison PNGs."),
    ),
    beforeLabel: Flag.String("before-label").pipe(
      Flag.withDescription("Banner label for the before panel."),
      Flag.withDefault("BEFORE (base)"),
    ),
    afterLabel: Flag.String("after-label").pipe(
      Flag.withDescription("Banner label for the after panel."),
      Flag.withDefault("AFTER (head)"),
    ),
    all: Flag.Boolean("all").pipe(
      Flag.withDescription("Render comparison PNGs even for screens with no delta."),
      Flag.withDefault(false),
    ),
    failOnRegression: Flag.Boolean("fail-on-regression").pipe(
      Flag.withDescription("Exit non-zero if any screen introduces new findings."),
      Flag.withDefault(false),
    ),
  },
  (input) => runCompare(input),
).pipe(
  Command.withDescription(
    "Diff two audit capture directories and render annotated side-by-side PNGs and Markdown.",
  ),
);

const reportCommand = Command.make(
  "report",
  {
    dir: Flag.String("dir").pipe(Flag.withDescription("Capture directory to annotate.")),
    out: Flag.String("out").pipe(
      Flag.withDescription("Output directory for report.md and annotated PNGs."),
    ),
  },
  (input) => runReport(input),
).pipe(Command.withDescription("Annotate a single audit capture directory with hit-box overlays."));

const mobileAuditCommand = Command.make("mobile-audit").pipe(
  Command.withDescription("Capture, diff, and visualize mobile accessibility audits."),
  Command.withSubcommands([captureCommand, compareCommand, reportCommand]),
);

if (import.meta.main) {
  Command.run(mobileAuditCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
