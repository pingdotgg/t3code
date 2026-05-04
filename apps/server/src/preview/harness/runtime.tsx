import * as React from "react";
import { createRoot } from "react-dom/client";

import { setPreviewEnvironment } from "./environmentStore.ts";
import {
  applyPreviewRuntimeCommand,
  buildPreviewRuntimeArgNameSet,
  createPreviewRuntimeState,
  type PreviewRuntimeCommand,
} from "./runtimeState.ts";
import type {
  PreviewControlDefinition,
  PreviewDefinition,
  PreviewScenarioDefinition,
} from "./types.ts";

interface RuntimeOptions {
  componentModuleUrl: string;
  framework: "react-next" | "react-remix" | "react-router" | "react-vite" | "unsupported";
  mountElementId: string;
  previewDefinition: PreviewDefinition;
  previewFileRelativePath: string;
  wrapperModule: unknown;
}

interface PreviewControlDescriptor {
  name: string;
  label: string;
  description: string | null;
  type: NonNullable<PreviewControlDefinition["type"]>;
  value: unknown;
  options?: unknown[] | undefined;
  min?: number | null | undefined;
  max?: number | null | undefined;
  step?: number | null | undefined;
}

type WrapperComponent = React.ComponentType<React.PropsWithChildren<Record<string, unknown>>>;

const PREVIEW_PARENT_SOURCE = "forma-preview-parent";
const PREVIEW_RUNTIME_SOURCE = "forma-component-harness";

function postToParent(payload: Record<string, unknown>) {
  window.parent.postMessage(
    {
      source: PREVIEW_RUNTIME_SOURCE,
      ...payload,
    },
    "*",
  );
}

function createRuntimeInstanceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `preview-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function humanizeLabel(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function inferControlType(value: unknown): PreviewControlDescriptor["type"] | null {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "text";
  if (Array.isArray(value)) {
    return value.every((entry) => ["string", "number", "boolean"].includes(typeof entry))
      ? "multi-select"
      : null;
  }
  if (value && typeof value === "object") return "object";
  return null;
}

function buildControlDescriptors(
  controls: readonly PreviewControlDefinition[] | undefined,
  args: Record<string, unknown>,
): PreviewControlDescriptor[] {
  const explicitDescriptors = (controls ?? []).map((control) => ({
    name: control.name,
    label: control.label ?? humanizeLabel(control.name),
    description: control.description ?? null,
    type:
      control.type ??
      inferControlType(args[control.name] ?? control.defaultValue) ??
      (control.options ? "select" : "text"),
    value: args[control.name] ?? control.defaultValue ?? null,
    options: control.options ? [...control.options] : undefined,
    min: control.min,
    max: control.max,
    step: control.step,
  }));

  const explicitNames = new Set(explicitDescriptors.map((descriptor) => descriptor.name));
  const inferredDescriptors = Object.entries(args)
    .filter(([name]) => !explicitNames.has(name))
    .map(([name, value]) => {
      const type = inferControlType(value);
      if (!type) return null;
      return {
        name,
        label: humanizeLabel(name),
        description: null,
        type,
        value,
      } satisfies PreviewControlDescriptor;
    })
    .filter((descriptor): descriptor is PreviewControlDescriptor => descriptor !== null);

  return [...explicitDescriptors, ...inferredDescriptors];
}

function resolveWrapperComponent(wrapperModule: unknown): WrapperComponent {
  if (wrapperModule && typeof wrapperModule === "object") {
    const candidate =
      (wrapperModule as { default?: unknown; PreviewWrapper?: unknown }).default ??
      (wrapperModule as { PreviewWrapper?: unknown }).PreviewWrapper;
    if (typeof candidate === "function") {
      return candidate as WrapperComponent;
    }
  }
  return function DefaultPreviewWrapper(props) {
    return <>{props.children}</>;
  };
}

function resolveComponentExport(moduleExports: Record<string, unknown>, exportName?: string) {
  if (exportName && moduleExports[exportName]) {
    return moduleExports[exportName];
  }
  if (typeof moduleExports.default === "function") {
    return moduleExports.default;
  }
  const firstFunctionExport = Object.values(moduleExports).find(
    (value) => typeof value === "function",
  );
  return firstFunctionExport ?? null;
}

function getRouterModuleSpecifiers(framework: RuntimeOptions["framework"]): readonly string[] {
  if (framework === "react-remix" || framework === "react-router") {
    return ["react-router-dom", "react-router"];
  }
  return [];
}

async function importFirstAvailableModule(
  specifiers: readonly string[],
): Promise<Record<string, unknown> | null> {
  for (const specifier of specifiers) {
    try {
      return (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return null;
}

class PreviewErrorBoundary extends React.Component<
  React.PropsWithChildren<{ onError: (error: Error) => void }>,
  { error: Error | null }
> {
  override state = { error: null };

  static override getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error) {
    this.props.onError(error);
  }

  override render() {
    if (this.state.error) {
      return null;
    }
    return this.props.children;
  }
}

interface PreviewReadyOrStatePayload {
  runtimeInstanceId: string;
  previewFileRelativePath: string;
  scenarioChoices: Array<{ id: string; name: string }>;
  currentScenarioId: string;
  controls: PreviewControlDescriptor[];
  argOverrides: Record<string, unknown>;
  lastAppliedCommandId: number;
}

function buildPreviewReadyOrStatePayload(input: {
  runtimeInstanceId: string;
  previewFileRelativePath: string;
  scenarios: readonly PreviewScenarioDefinition[];
  currentScenarioId: string;
  controls: PreviewControlDescriptor[];
  argOverrides: Record<string, unknown>;
  lastAppliedCommandId: number;
}): PreviewReadyOrStatePayload {
  return {
    runtimeInstanceId: input.runtimeInstanceId,
    previewFileRelativePath: input.previewFileRelativePath,
    scenarioChoices: input.scenarios.map((scenario) => ({ id: scenario.id, name: scenario.name })),
    currentScenarioId: input.currentScenarioId,
    controls: input.controls,
    argOverrides: { ...input.argOverrides },
    lastAppliedCommandId: input.lastAppliedCommandId,
  };
}

function PreviewShell(props: RuntimeOptions) {
  const scenarios = React.useMemo(() => {
    const definedScenarios = props.previewDefinition.scenarios ?? [];
    if (definedScenarios.length > 0) {
      return [...definedScenarios];
    }
    return [{ id: "default", name: "Default", args: {} }] satisfies PreviewScenarioDefinition[];
  }, [props.previewDefinition.scenarios]);
  const runtimeInstanceId = React.useMemo(() => createRuntimeInstanceId(), []);
  const validArgNames = React.useMemo(
    () =>
      buildPreviewRuntimeArgNameSet({
        controls: props.previewDefinition.controls,
        scenarios,
      }),
    [props.previewDefinition.controls, scenarios],
  );
  const [componentModule, setComponentModule] = React.useState<Record<string, unknown> | null>(
    null,
  );
  const [componentError, setComponentError] = React.useState<string | null>(null);
  const [routerModule, setRouterModule] = React.useState<Record<string, unknown> | null>(null);
  const [runtimeState, dispatchRuntimeCommand] = React.useReducer(
    (
      currentState: ReturnType<typeof createPreviewRuntimeState>,
      action:
        | PreviewRuntimeCommand
        | {
            kind: "runtime.sync.scenarios";
            scenarios: readonly PreviewScenarioDefinition[];
          },
    ) => {
      if (action.kind === "runtime.sync.scenarios") {
        if (action.scenarios.some((scenario) => scenario.id === currentState.selectedScenarioId)) {
          return currentState;
        }
        return {
          ...currentState,
          selectedScenarioId: action.scenarios[0]?.id ?? currentState.selectedScenarioId,
        };
      }
      return applyPreviewRuntimeCommand({
        state: currentState,
        command: action,
        scenarios,
        validArgNames,
      });
    },
    undefined,
    () =>
      createPreviewRuntimeState({
        runtimeInstanceId,
        scenarios,
      }),
  );
  const readySentRef = React.useRef(false);

  const selectedScenario =
    scenarios.find((scenario) => scenario.id === runtimeState.selectedScenarioId) ?? scenarios[0]!;
  const activeEnvironment = React.useMemo(
    () => ({
      pathname:
        selectedScenario.env?.pathname ?? props.previewDefinition.envDefaults?.pathname ?? "/",
      searchParams:
        selectedScenario.env?.searchParams ??
        props.previewDefinition.envDefaults?.searchParams ??
        {},
    }),
    [props.previewDefinition.envDefaults, selectedScenario.env],
  );
  const mergedArgs = React.useMemo(
    () => ({
      ...(selectedScenario.args ?? {}),
      ...runtimeState.argOverrides,
    }),
    [runtimeState.argOverrides, selectedScenario.args],
  );
  const previewControls = React.useMemo(
    () => buildControlDescriptors(props.previewDefinition.controls, mergedArgs),
    [mergedArgs, props.previewDefinition.controls],
  );

  React.useEffect(() => {
    dispatchRuntimeCommand({
      kind: "runtime.sync.scenarios",
      scenarios,
    });
  }, [scenarios]);

  React.useEffect(() => {
    let cancelled = false;
    setComponentError(null);
    import(/* @vite-ignore */ props.componentModuleUrl)
      .then((moduleExports) => {
        if (!cancelled) {
          setComponentModule(moduleExports as Record<string, unknown>);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          setComponentError(message);
          postToParent({
            kind: "preview.runtime.error",
            runtimeInstanceId,
            previewFileRelativePath: props.previewFileRelativePath,
            message,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [props.componentModuleUrl, props.previewFileRelativePath, runtimeInstanceId]);

  React.useEffect(() => {
    const routerModuleSpecifiers = getRouterModuleSpecifiers(props.framework);
    if (routerModuleSpecifiers.length === 0) {
      setRouterModule(null);
      return;
    }
    let cancelled = false;
    importFirstAvailableModule(routerModuleSpecifiers)
      .then((moduleExports) => {
        if (!cancelled) {
          setRouterModule(moduleExports);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRouterModule(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [props.framework]);

  React.useEffect(() => {
    setPreviewEnvironment(activeEnvironment);
  }, [activeEnvironment]);

  React.useEffect(() => {
    const payload = buildPreviewReadyOrStatePayload({
      runtimeInstanceId,
      previewFileRelativePath: props.previewFileRelativePath,
      scenarios,
      currentScenarioId: runtimeState.selectedScenarioId,
      controls: previewControls,
      argOverrides: runtimeState.argOverrides,
      lastAppliedCommandId: runtimeState.lastAppliedCommandId,
    });
    if (!readySentRef.current) {
      readySentRef.current = true;
      postToParent({
        kind: "preview.ready",
        ...payload,
      });
      return;
    }
    postToParent({
      kind: "preview.state",
      ...payload,
    });
  }, [
    previewControls,
    props.previewFileRelativePath,
    runtimeInstanceId,
    runtimeState.argOverrides,
    runtimeState.lastAppliedCommandId,
    runtimeState.selectedScenarioId,
    scenarios,
  ]);

  React.useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!event.data || event.data.source !== PREVIEW_PARENT_SOURCE) {
        return;
      }
      if (event.data.previewFileRelativePath !== props.previewFileRelativePath) {
        return;
      }
      if (event.data.runtimeInstanceId !== runtimeInstanceId) {
        return;
      }

      if (
        event.data.kind === "preview.command.restoreSession" &&
        typeof event.data.commandId === "number" &&
        Number.isFinite(event.data.commandId)
      ) {
        dispatchRuntimeCommand({
          kind: "preview.command.restoreSession",
          runtimeInstanceId,
          commandId: event.data.commandId,
          selectedScenarioId:
            typeof event.data.selectedScenarioId === "string"
              ? event.data.selectedScenarioId
              : null,
          argOverrides:
            event.data.argOverrides && typeof event.data.argOverrides === "object"
              ? (event.data.argOverrides as Record<string, unknown>)
              : {},
        });
        return;
      }

      if (
        event.data.kind === "preview.command.selectScenario" &&
        typeof event.data.commandId === "number" &&
        Number.isFinite(event.data.commandId) &&
        typeof event.data.scenarioId === "string"
      ) {
        dispatchRuntimeCommand({
          kind: "preview.command.selectScenario",
          runtimeInstanceId,
          commandId: event.data.commandId,
          scenarioId: event.data.scenarioId,
        });
        return;
      }

      if (
        event.data.kind === "preview.command.setArgsPartial" &&
        typeof event.data.commandId === "number" &&
        Number.isFinite(event.data.commandId) &&
        event.data.argsPartial &&
        typeof event.data.argsPartial === "object"
      ) {
        dispatchRuntimeCommand({
          kind: "preview.command.setArgsPartial",
          runtimeInstanceId,
          commandId: event.data.commandId,
          argsPartial: event.data.argsPartial as Record<string, unknown>,
        });
      }
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [props.previewFileRelativePath, runtimeInstanceId]);

  const Wrapper = React.useMemo(
    () => resolveWrapperComponent(props.wrapperModule),
    [props.wrapperModule],
  );
  const Component = React.useMemo(() => {
    if (!componentModule) return null;
    return resolveComponentExport(
      componentModule,
      props.previewDefinition.componentExport,
    ) as React.ComponentType<Record<string, unknown>> | null;
  }, [componentModule, props.previewDefinition.componentExport]);

  if (componentError) {
    return null;
  }

  if (!Component) {
    return null;
  }

  const previewContent = (
    <PreviewErrorBoundary
      onError={(error) =>
        postToParent({
          kind: "preview.runtime.error",
          runtimeInstanceId,
          previewFileRelativePath: props.previewFileRelativePath,
          message: error.message,
        })
      }
    >
      <Wrapper
        env={activeEnvironment}
        scenario={{
          id: selectedScenario.id,
          name: selectedScenario.name,
          env: selectedScenario.env ?? null,
        }}
        pathname={activeEnvironment.pathname}
        searchParams={activeEnvironment.searchParams}
      >
        <Component {...mergedArgs} />
      </Wrapper>
    </PreviewErrorBoundary>
  );

  if (
    routerModule?.MemoryRouter &&
    (props.framework === "react-remix" || props.framework === "react-router")
  ) {
    const MemoryRouter = routerModule.MemoryRouter as React.ComponentType<{
      initialEntries?: string[];
      children?: React.ReactNode;
    }>;
    const search = new URLSearchParams(activeEnvironment.searchParams).toString();
    const initialEntry =
      search.length > 0 ? `${activeEnvironment.pathname}?${search}` : activeEnvironment.pathname;
    return <MemoryRouter initialEntries={[initialEntry]}>{previewContent}</MemoryRouter>;
  }

  return previewContent;
}

export function startPreviewRuntime(options: RuntimeOptions) {
  const mountElement = document.getElementById(options.mountElementId);
  if (!mountElement) {
    throw new Error(`Preview mount element '${options.mountElementId}' was not found.`);
  }

  const root = createRoot(mountElement);
  root.render(<PreviewShell {...options} />);
}
