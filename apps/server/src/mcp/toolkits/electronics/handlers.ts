import {
  ElectronicsError,
  type ElectronicsToolInspectResult,
  type ElectronicsToolListResult,
  type ElectronicsToolOpenResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ElectronicsService from "../../../electronics/ElectronicsService.ts";
import { threadWorkspaceRoot } from "../../../project/threadWorkspaceRoot.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ElectronicsToolkit } from "./tools.ts";

const requireElectronicsAgentAccess = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const threadScope = yield* McpInvocationContext.requireThreadScope(scope, "Electronics tools");
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const settings = yield* settingsService.getSettings.pipe(
    Effect.mapError(
      (err) =>
        new ElectronicsError({
          code: "internal",
          message: `Could not read settings: ${err.message}`,
        }),
    ),
  );
  if (!settings.enableElectronicsWorkbench || !settings.enableAgentElectronicsAccess) {
    return yield* new ElectronicsError({
      code: "disabled",
      message:
        "Agent access to Electronics Workbench is turned off. Enable it in Settings → Electronics.",
    });
  }
  const cwd = yield* threadWorkspaceRoot(threadScope.thread.threadId);
  if (!cwd) {
    return yield* new ElectronicsError({
      code: "not_found",
      message: "This thread does not have an attached workspace root.",
    });
  }
  return { threadId: threadScope.thread.threadId, cwd };
});

const handlers = {
  electronics_list: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { threadId, cwd } = yield* requireElectronicsAgentAccess;
      const service = yield* ElectronicsService.ElectronicsService;
      if (input.refreshToolchain) {
        yield* service.getToolchainStatus(true);
      }
      const listed = yield* service.listFiles(cwd);
      const session = yield* service.getThreadSession(threadId);
      return {
        files: listed.files,
        ...(session !== undefined ? { openFilePath: session.filePath } : {}),
        toolchain: {
          kicadCli: listed.toolchain.kicadCli.available,
          ...(listed.toolchain.kicadCli.version !== undefined
            ? { kicadVersion: listed.toolchain.kicadCli.version }
            : {}),
          ngspice: listed.toolchain.ngspice.available,
          ...(listed.toolchain.ngspice.version !== undefined
            ? { ngspiceVersion: listed.toolchain.ngspice.version }
            : {}),
        },
      } satisfies ElectronicsToolListResult;
    }),
  ),

  electronics_open: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { threadId, cwd } = yield* requireElectronicsAgentAccess;
      const service = yield* ElectronicsService.ElectronicsService;
      const model = yield* service.inspect(cwd, input.filePath);
      const session = yield* service.openPanel({
        threadId,
        cwd,
        filePath: input.filePath,
        ...(input.activeTab !== undefined ? { activeTab: input.activeTab } : {}),
        ...(input.selectedNet !== undefined ? { selectedNet: input.selectedNet } : {}),
      });
      return {
        filePath: session.filePath,
        format: session.format,
        activeTab: session.activeTab,
        componentCount: model.components.filter((c) => c.kind !== "power_symbol").length,
        netCount: model.nets.length,
      } satisfies ElectronicsToolOpenResult;
    }),
  ),

  electronics_inspect: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { cwd } = yield* requireElectronicsAgentAccess;
      const service = yield* ElectronicsService.ElectronicsService;
      const model = yield* service.inspect(cwd, input.filePath);
      const nonPower = model.components.filter((c) => c.kind !== "power_symbol");
      return {
        filePath: model.filePath,
        format: model.format,
        ...(model.title !== undefined ? { title: model.title } : {}),
        componentCount: nonPower.length,
        netCount: model.nets.length,
        powerNets: model.nets.filter((n) => n.isPower).map((n) => n.name),
        groundNets: model.nets.filter((n) => n.isGround).map((n) => n.name),
        components: nonPower.map((c) => ({
          ref: c.ref,
          value: c.value,
          kind: c.kind,
          ...(c.footprint !== undefined ? { footprint: c.footprint } : {}),
          pins: c.pins.map((p) => ({
            number: p.number,
            ...(p.name !== undefined ? { name: p.name } : {}),
            type: p.electricalType,
            ...(p.net !== undefined ? { net: p.net } : {}),
          })),
        })),
        nets: model.nets.map((n) => ({
          name: n.name,
          isPower: n.isPower,
          isGround: n.isGround,
          pins: n.pins.map((p) => `${p.ref}.${p.pin}`),
        })),
        bom: model.bom,
        parseWarnings: model.parseWarnings,
      } satisfies ElectronicsToolInspectResult;
    }),
  ),

  electronics_trace_path: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { threadId, cwd } = yield* requireElectronicsAgentAccess;
      const service = yield* ElectronicsService.ElectronicsService;
      return yield* service.tracePath(
        {
          cwd,
          filePath: input.filePath,
          from: input.from,
          ...(input.to !== undefined ? { to: input.to } : {}),
          ...(input.traversePassives !== undefined
            ? { traversePassives: input.traversePassives }
            : {}),
          ...(input.maxHops !== undefined ? { maxHops: input.maxHops } : {}),
        },
        threadId,
      );
    }),
  ),

  electronics_validate: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { threadId, cwd } = yield* requireElectronicsAgentAccess;
      const service = yield* ElectronicsService.ElectronicsService;
      return yield* service.validate(
        {
          cwd,
          filePath: input.filePath,
          ...(input.useExternalToolchain !== undefined
            ? { useExternalToolchain: input.useExternalToolchain }
            : {}),
        },
        threadId,
      );
    }),
  ),

  electronics_simulate: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { threadId, cwd } = yield* requireElectronicsAgentAccess;
      const service = yield* ElectronicsService.ElectronicsService;
      return yield* service.simulate(
        {
          cwd,
          filePath: input.filePath,
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.outputNode !== undefined ? { outputNode: input.outputNode } : {}),
          ...(input.startFreqHz !== undefined ? { startFreqHz: input.startFreqHz } : {}),
          ...(input.stopFreqHz !== undefined ? { stopFreqHz: input.stopFreqHz } : {}),
          ...(input.stopTimeSeconds !== undefined
            ? { stopTimeSeconds: input.stopTimeSeconds }
            : {}),
        },
        threadId,
      );
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof ElectronicsToolkit.tools>;

export const layer = McpToolAccess.toLayer(ElectronicsToolkit, handlers);
