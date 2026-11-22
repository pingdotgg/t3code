import {
  type ElectronicsCircuitModel,
  type ElectronicsDesignFormat,
  type ElectronicsPanelTab,
  type ElectronicsSimulationKind,
  type ElectronicsSimulationResult,
  type ElectronicsTracePathResult,
  type ElectronicsValidationIssue,
  type ElectronicsValidationReport,
  type ElectronicsWorkspaceFile,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import {
  ActivityIcon,
  CircuitBoardIcon,
  ListChecksIcon,
  PackageIcon,
  RefreshCwIcon,
  RouteIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { useStableCallback } from "../../hooks/useStableCallback";
import { electronicsEnvironment, useElectronicsState } from "../../state/electronics";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { BomPanel } from "./BomPanel";
import { CircuitCanvas } from "./CircuitCanvas";
import { PathTracerPanel } from "./PathTracerPanel";
import { SimulationPanel } from "./SimulationPanel";
import { ValidationPanel } from "./ValidationPanel";

export interface ElectronicsPanelProps {
  readonly threadRef: ScopedThreadRef;
  readonly workspaceRoot: string | undefined;
  readonly initialFilePath?: string | undefined;
  readonly visible: boolean;
}

export function ElectronicsPanel(props: ElectronicsPanelProps) {
  const { threadRef, workspaceRoot, initialFilePath } = props;
  const gt = useGT();
  const { state: serviceState } = useElectronicsState(threadRef.environmentId);

  const listFilesCmd = useStableCallback(
    useAtomCommand(electronicsEnvironment.listFiles, { reportFailure: false }),
  );
  const inspectCmd = useStableCallback(
    useAtomCommand(electronicsEnvironment.inspect, { reportFailure: false }),
  );
  const traceCmd = useAtomCommand(electronicsEnvironment.tracePath, { reportFailure: false });
  const validateCmd = useAtomCommand(electronicsEnvironment.validate, { reportFailure: false });
  const simulateCmd = useAtomCommand(electronicsEnvironment.simulate, { reportFailure: false });

  const formatBadgeLabel = (format: ElectronicsDesignFormat): string => {
    switch (format) {
      case "kicad_sch":
        return gt("KiCad SCH");
      case "kicad_pcb":
        return gt("KiCad PCB");
      case "spice":
        return gt("SPICE");
      case "circuit_json":
        return gt("Circuit JSON");
    }
  };

  const threadSession =
    serviceState.sessions.find((s) => s.threadId === threadRef.threadId) ?? null;

  const [files, setFiles] = useState<ReadonlyArray<ElectronicsWorkspaceFile>>([]);
  const [selectedFile, setSelectedFile] = useState<string>(
    initialFilePath ?? threadSession?.filePath ?? "",
  );
  const [activeTab, setActiveTab] = useState<ElectronicsPanelTab>(
    threadSession?.activeTab ?? "canvas",
  );
  const [model, setModel] = useState<ElectronicsCircuitModel | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingModel, setLoadingModel] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [selectedNet, setSelectedNet] = useState<string | null>(threadSession?.selectedNet ?? null);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);

  const [traceFrom, setTraceFrom] = useState("");
  const [traceTo, setTraceTo] = useState("");
  const [traversePassives, setTraversePassives] = useState(true);
  const [traceRunning, setTraceRunning] = useState(false);
  const [traceResult, setTraceResult] = useState<ElectronicsTracePathResult | null>(
    threadSession?.lastTrace ?? null,
  );

  const [validationRunning, setValidationRunning] = useState(false);
  const [validationReport, setValidationReport] = useState<ElectronicsValidationReport | null>(
    threadSession?.lastValidation ?? null,
  );

  const [simKind, setSimKind] = useState<ElectronicsSimulationKind>("dc_op");
  const [simOutputNode, setSimOutputNode] = useState("");
  const [simRunning, setSimRunning] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);
  const [simResult, setSimResult] = useState<ElectronicsSimulationResult | null>(
    threadSession?.lastSimulation ?? null,
  );

  const [lastSyncedAt, setLastSyncedAt] = useState<string>("");
  const [lastSyncedTraceKey, setLastSyncedTraceKey] = useState<string>("");
  const [traceError, setTraceError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const activeContextRef = useRef({
    env: threadRef.environmentId,
    cwd: workspaceRoot,
    file: selectedFile,
  });
  const reqSeqRef = useRef({ files: 0, model: 0, trace: 0, validate: 0, sim: 0 });

  // Reset running/transient states cleanly whenever the active environment, workspace, or file changes.
  const resetPendingOperations = useStableCallback(() => {
    reqSeqRef.current.trace += 1;
    reqSeqRef.current.validate += 1;
    reqSeqRef.current.sim += 1;
    setTraceRunning(false);
    setValidationRunning(false);
    setSimRunning(false);
    setTraceError(null);
    setValidationError(null);
    setSimError(null);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks latest active context and clears pending operation flags so stale async completions never strand buttons disabled
  useEffect(() => {
    activeContextRef.current = {
      env: threadRef.environmentId,
      cwd: workspaceRoot,
      file: selectedFile,
    };
    resetPendingOperations();
  }, [threadRef.environmentId, workspaceRoot, selectedFile, resetPendingOperations]);

  const isCurrentFileContext = (env: string, cwd: string | null, file: string) =>
    activeContextRef.current.env === env &&
    activeContextRef.current.cwd === cwd &&
    activeContextRef.current.file === file;

  if (threadSession && threadSession.updatedAt !== lastSyncedAt) {
    setLastSyncedAt(threadSession.updatedAt);
    if (threadSession.filePath !== selectedFile) {
      setSelectedFile(threadSession.filePath);
      setModel(null);
      setSelectedNet(null);
      setSelectedRef(null);
      setTraceResult(null);
      setValidationReport(null);
      setSimResult(null);
      setSimOutputNode("");
      setTraceError(null);
      setValidationError(null);
      setSimError(null);
      setTraceRunning(false);
      setValidationRunning(false);
      setSimRunning(false);
    }
    setActiveTab(threadSession.activeTab);
    if (threadSession.selectedNet !== undefined) {
      setSelectedNet(threadSession.selectedNet);
    }
    if (threadSession.lastTrace !== undefined) {
      const traceKey = `${threadSession.filePath}:${threadSession.lastTrace.from}:${threadSession.lastTrace.to ?? ""}:${threadSession.lastTrace.hops.length}`;
      setTraceResult(threadSession.lastTrace);
      if (traceKey !== lastSyncedTraceKey) {
        setLastSyncedTraceKey(traceKey);
        setTraceFrom(threadSession.lastTrace.from);
        setTraceTo(threadSession.lastTrace.to ?? "");
      }
    }
    if (threadSession.lastValidation !== undefined) {
      setValidationReport(threadSession.lastValidation);
    }
    if (threadSession.lastSimulation !== undefined) {
      setSimResult(threadSession.lastSimulation);
      setSimKind(threadSession.lastSimulation.kind);
    }
  }

  const triggerFilesRefresh = () => {
    if (!workspaceRoot) return;
    const reqEnv = threadRef.environmentId;
    const reqCwd = workspaceRoot;
    const seq = ++reqSeqRef.current.files;
    setLoadingFiles(true);
    void listFilesCmd({
      environmentId: reqEnv,
      input: { cwd: reqCwd },
    }).then((result) => {
      if (
        reqSeqRef.current.files !== seq ||
        activeContextRef.current.env !== reqEnv ||
        activeContextRef.current.cwd !== reqCwd
      ) {
        return;
      }
      setLoadingFiles(false);
      if (result._tag === "Success") {
        setFiles(result.value.files);
        setErrorMessage(null);
        setSelectedFile((current) => current || result.value.files[0]?.relativePath || "");
      } else {
        setErrorMessage(formatEnvironmentQueryError(result.cause));
      }
    });
  };

  const triggerModelRefresh = () => {
    if (!workspaceRoot || !selectedFile) return;
    const reqEnv = threadRef.environmentId;
    const reqCwd = workspaceRoot;
    const reqFile = selectedFile;
    const seq = ++reqSeqRef.current.model;
    setLoadingModel(true);
    void inspectCmd({
      environmentId: reqEnv,
      input: { cwd: reqCwd, filePath: reqFile },
    }).then((result) => {
      if (reqSeqRef.current.model !== seq || !isCurrentFileContext(reqEnv, reqCwd, reqFile)) {
        return;
      }
      setLoadingModel(false);
      if (result._tag === "Success") {
        setModel(result.value);
        setErrorMessage(null);
      } else {
        setModel(null);
        setErrorMessage(formatEnvironmentQueryError(result.cause));
      }
    });
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads workspace electronics catalog on mount and workspace switch
  useEffect(() => {
    if (!workspaceRoot) return;
    let active = true;
    const seq = ++reqSeqRef.current.files;
    void listFilesCmd({
      environmentId: threadRef.environmentId,
      input: { cwd: workspaceRoot },
    }).then((result) => {
      if (!active || reqSeqRef.current.files !== seq) return;
      setLoadingFiles(false);
      if (result._tag === "Success") {
        setFiles(result.value.files);
        setErrorMessage(null);
        setSelectedFile((current) => current || result.value.files[0]?.relativePath || "");
      } else {
        setErrorMessage(formatEnvironmentQueryError(result.cause));
      }
    });
    return () => {
      active = false;
    };
  }, [workspaceRoot, threadRef.environmentId, listFilesCmd]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches parsed circuit model when user or agent selects a file
  useEffect(() => {
    if (!workspaceRoot || !selectedFile) return;
    let active = true;
    const seq = ++reqSeqRef.current.model;
    void inspectCmd({
      environmentId: threadRef.environmentId,
      input: { cwd: workspaceRoot, filePath: selectedFile },
    }).then((result) => {
      if (!active || reqSeqRef.current.model !== seq) return;
      setLoadingModel(false);
      if (result._tag === "Success") {
        setModel(result.value);
        setErrorMessage(null);
      } else {
        setModel(null);
        setErrorMessage(formatEnvironmentQueryError(result.cause));
      }
    });
    return () => {
      active = false;
    };
  }, [selectedFile, workspaceRoot, threadRef.environmentId, inspectCmd]);

  const handleRunTrace = () => {
    if (!workspaceRoot || !selectedFile || traceFrom.trim().length === 0) return;
    const reqEnv = threadRef.environmentId;
    const reqCwd = workspaceRoot;
    const reqFile = selectedFile;
    const seq = ++reqSeqRef.current.trace;
    setTraceRunning(true);
    setTraceError(null);
    void traceCmd({
      environmentId: reqEnv,
      input: {
        cwd: reqCwd,
        filePath: reqFile,
        from: traceFrom.trim(),
        ...(traceTo.trim().length > 0 ? { to: traceTo.trim() } : {}),
        traversePassives,
      },
    }).then((result) => {
      if (reqSeqRef.current.trace !== seq || !isCurrentFileContext(reqEnv, reqCwd, reqFile)) {
        return;
      }
      setTraceRunning(false);
      if (result._tag === "Success") {
        setTraceResult(result.value);
        if (result.value.highlightedNets[0]) {
          setSelectedNet(result.value.highlightedNets[0]);
        }
      } else {
        setTraceError(formatEnvironmentQueryError(result.cause));
      }
    });
  };

  const handleRunValidate = () => {
    if (!workspaceRoot || !selectedFile) return;
    const reqEnv = threadRef.environmentId;
    const reqCwd = workspaceRoot;
    const reqFile = selectedFile;
    const seq = ++reqSeqRef.current.validate;
    setValidationRunning(true);
    setValidationError(null);
    void validateCmd({
      environmentId: reqEnv,
      input: { cwd: reqCwd, filePath: reqFile, useExternalToolchain: true },
    }).then((result) => {
      if (reqSeqRef.current.validate !== seq || !isCurrentFileContext(reqEnv, reqCwd, reqFile)) {
        return;
      }
      setValidationRunning(false);
      if (result._tag === "Success") {
        setValidationReport(result.value);
      } else {
        setValidationError(formatEnvironmentQueryError(result.cause));
      }
    });
  };

  const handleRunSimulate = () => {
    if (!workspaceRoot || !selectedFile) return;
    const reqEnv = threadRef.environmentId;
    const reqCwd = workspaceRoot;
    const reqFile = selectedFile;
    const seq = ++reqSeqRef.current.sim;
    setSimRunning(true);
    setSimError(null);
    void simulateCmd({
      environmentId: reqEnv,
      input: {
        cwd: reqCwd,
        filePath: reqFile,
        kind: simKind,
        ...(simOutputNode ? { outputNode: simOutputNode } : {}),
        useExternalToolchain: true,
      },
    }).then((result) => {
      if (reqSeqRef.current.sim !== seq || !isCurrentFileContext(reqEnv, reqCwd, reqFile)) {
        return;
      }
      setSimRunning(false);
      if (result._tag === "Success") {
        setSimResult(result.value);
      } else {
        setSimError(formatEnvironmentQueryError(result.cause));
      }
    });
  };

  const handleFocusIssue = (issue: ElectronicsValidationIssue) => {
    if (issue.net) setSelectedNet(issue.net);
    if (issue.refs[0]) setSelectedRef(issue.refs[0]);
    setActiveTab("canvas");
  };

  const handleStartTraceFrom = (endpoint: string) => {
    setTraceFrom(endpoint);
    setActiveTab("trace");
  };

  const kicadAvailable = serviceState.toolchain.kicadCli.available;
  const ngspiceAvailable = serviceState.toolchain.ngspice.available;
  const errorCount = validationReport?.errorCount ?? 0;
  const warningCount = validationReport?.warningCount ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <CircuitBoardIcon className="size-4 shrink-0 text-primary" />
        <select
          aria-label={gt("Circuit design file")}
          value={selectedFile}
          onChange={(e) => {
            const next = e.target.value;
            setSelectedFile(next);
            setModel(null);
            setLoadingModel(next.length > 0);
            setSelectedNet(null);
            setSelectedRef(null);
            setTraceResult(null);
            setTraceFrom("");
            setTraceTo("");
            setValidationReport(null);
            setSimResult(null);
            setSimOutputNode("");
            setTraceError(null);
            setValidationError(null);
            setSimError(null);
            setTraceRunning(false);
            setValidationRunning(false);
            setSimRunning(false);
          }}
          className="h-7 min-w-0 flex-1 truncate rounded-md border border-border bg-card px-2 font-mono text-xs text-foreground"
        >
          {files.length === 0 ? (
            <option value="">{gt("No circuit files detected")}</option>
          ) : (
            files.map((f) => (
              <option key={f.relativePath} value={f.relativePath}>
                [{formatBadgeLabel(f.format)}] {f.relativePath}
              </option>
            ))
          )}
        </select>

        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            triggerFilesRefresh();
            if (selectedFile) triggerModelRefresh();
          }}
          disabled={loadingFiles || loadingModel}
          aria-label={gt("Refresh workspace circuit files")}
        >
          <RefreshCwIcon
            className={loadingFiles || loadingModel ? "size-3.5 animate-spin" : "size-3.5"}
          />
        </Button>

        <div className="hidden items-center gap-1 sm:flex">
          <span
            className={
              kicadAvailable
                ? "rounded-full bg-success/15 px-1.5 py-0.5 font-mono text-3xs text-success"
                : "rounded-full bg-muted px-1.5 py-0.5 font-mono text-3xs text-muted-foreground"
            }
          >
            kicad-cli
          </span>
          <span
            className={
              ngspiceAvailable
                ? "rounded-full bg-success/15 px-1.5 py-0.5 font-mono text-3xs text-success"
                : "rounded-full bg-muted px-1.5 py-0.5 font-mono text-3xs text-muted-foreground"
            }
          >
            ngspice
          </span>
        </div>
      </div>

      <div className="flex items-center gap-1 overflow-x-auto border-b border-border bg-muted/20 px-2 py-1 text-xs">
        {(
          [
            { id: "canvas", label: gt("Canvas"), icon: CircuitBoardIcon },
            { id: "trace", label: gt("Path Tracer"), icon: RouteIcon },
            { id: "checks", label: gt("Checks"), icon: ShieldCheckIcon },
            { id: "simulate", label: gt("Simulate"), icon: ActivityIcon },
            { id: "bom", label: gt("BOM"), icon: PackageIcon },
          ] as const
        ).map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={
                active
                  ? "flex shrink-0 items-center gap-1.5 rounded-md bg-background px-2.5 py-1 font-medium text-foreground shadow-2xs ring-1 ring-border"
                  : "flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              }
            >
              <Icon className="size-3.5" />
              <span>{tab.label}</span>
              {tab.id === "checks" && validationReport && (
                <span
                  className={
                    errorCount > 0
                      ? "rounded-full bg-destructive/15 px-1.5 font-mono text-3xs text-destructive"
                      : warningCount > 0
                        ? "rounded-full bg-warning/15 px-1.5 font-mono text-3xs text-warning"
                        : "rounded-full bg-success/15 px-1.5 font-mono text-3xs text-success"
                  }
                >
                  {errorCount > 0 ? errorCount : warningCount > 0 ? warningCount : "✓"}
                </span>
              )}
              {tab.id === "bom" && model && (
                <span className="font-mono text-3xs text-muted-foreground">{model.bom.length}</span>
              )}
            </button>
          );
        })}
      </div>

      {!workspaceRoot ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground">
          <CircuitBoardIcon className="size-8 opacity-40" />
          <p>
            <T>Open a project workspace to inspect schematics, PCBs, and SPICE circuits.</T>
          </p>
        </div>
      ) : loadingModel && !model ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-4" />
          <T>Parsing circuit…</T>
        </div>
      ) : errorMessage && !model ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs">
          <p className="text-destructive">{errorMessage}</p>
          <Button size="xs" variant="outline" onClick={triggerFilesRefresh}>
            <T>Retry</T>
          </Button>
        </div>
      ) : !model ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-xs text-muted-foreground">
          <ListChecksIcon className="size-8 opacity-40" />
          <div className="max-w-sm space-y-1">
            <p className="font-medium text-foreground">
              <T>No electronics design files found in this workspace</T>
            </p>
            <p>
              <T>
                Add a KiCad schematic (.kicad_sch), KiCad PCB (.kicad_pcb), SPICE netlist (.cir /
                .spice), or tscircuit Circuit JSON (*.circuit.json) to inspect nets, validate
                circuit paths, run ERC/DRC, and simulate waveforms.
              </T>
            </p>
          </div>
          <Button size="xs" variant="outline" onClick={triggerFilesRefresh}>
            <T>Scan Workspace</T>
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 border-b border-border/60 bg-card/30 px-3 py-1 font-mono text-2xs text-muted-foreground">
            <span>{formatBadgeLabel(model.format)}</span>
            <span>·</span>
            <span>
              {gt("{count} components", {
                count: model.components.filter((c) => c.kind !== "power_symbol").length,
              })}
            </span>
            <span>·</span>
            <span>{gt("{count} nets", { count: model.nets.length })}</span>
            {model.title && (
              <>
                <span>·</span>
                <span className="truncate text-foreground">{model.title}</span>
              </>
            )}
          </div>

          {activeTab === "canvas" && (
            <CircuitCanvas
              model={model}
              selectedNet={selectedNet}
              selectedRef={selectedRef}
              activeTrace={traceResult}
              validationIssues={validationReport?.issues ?? []}
              onSelectNet={setSelectedNet}
              onSelectRef={setSelectedRef}
              onStartTraceFrom={handleStartTraceFrom}
            />
          )}

          {activeTab === "trace" && (
            <>
              {traceError && (
                <div className="mx-3 mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
                  {traceError}
                </div>
              )}
              <PathTracerPanel
                model={model}
                fromValue={traceFrom}
                toValue={traceTo}
                traversePassives={traversePassives}
                running={traceRunning}
                result={traceResult}
                onChangeFrom={setTraceFrom}
                onChangeTo={setTraceTo}
                onChangeTraversePassives={setTraversePassives}
                onRunTrace={handleRunTrace}
                onHighlightOnCanvas={(net, ref) => {
                  if (net) setSelectedNet(net);
                  if (ref) setSelectedRef(ref);
                  setActiveTab("canvas");
                }}
              />
            </>
          )}

          {activeTab === "checks" && (
            <>
              {validationError && (
                <div className="mx-3 mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
                  {validationError}
                </div>
              )}
              <ValidationPanel
                report={validationReport}
                running={validationRunning}
                onRunValidate={handleRunValidate}
                onFocusIssue={handleFocusIssue}
              />
            </>
          )}

          {activeTab === "simulate" && (
            <SimulationPanel
              model={model}
              kind={simKind}
              outputNode={simOutputNode}
              running={simRunning}
              error={simError}
              result={simResult}
              onChangeKind={setSimKind}
              onChangeOutputNode={setSimOutputNode}
              onRunSimulate={handleRunSimulate}
            />
          )}

          {activeTab === "bom" && (
            <BomPanel
              bom={model.bom}
              onSelectRef={(ref) => {
                setSelectedRef(ref);
                setActiveTab("canvas");
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
