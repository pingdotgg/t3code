interface DebugSource {
  fileName: string;
  lineNumber?: number;
  columnNumber?: number;
}

interface ReactFiber {
  return?: ReactFiber | null;
  type?: unknown;
  elementType?: unknown;
  _debugSource?: DebugSource;
}

const SKIP_COMPONENT_NAMES = new Set([
  "Fragment",
  "Suspense",
  "StrictMode",
  "Route",
  "Routes",
  "Router",
  "HotReload",
  "PreviewShell",
  "PreviewFeedbackOverlay",
  "FeedbackHoverFrame",
  "FeedbackComposer",
  "FeedbackMarker",
  "PendingFeedbackMarker",
  "PreviewErrorBoundary",
  "DefaultPreviewWrapper",
]);

function getFiberFromElement(element: HTMLElement): ReactFiber | null {
  const fiberKey = Object.keys(element).find(
    (key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"),
  );
  if (!fiberKey) {
    return null;
  }
  return (element as Record<string, ReactFiber | undefined>)[fiberKey] ?? null;
}

function getComponentName(candidate: unknown): string | null {
  if (!candidate || typeof candidate === "string") {
    return null;
  }
  if (typeof candidate === "function") {
    return candidate.displayName || candidate.name || null;
  }
  if (typeof candidate === "object") {
    const component = candidate as {
      displayName?: string;
      name?: string;
      render?: { displayName?: string; name?: string };
      type?: unknown;
    };
    return (
      component.displayName ||
      component.name ||
      component.render?.displayName ||
      component.render?.name ||
      getComponentName(component.type)
    );
  }
  return null;
}

function normalizeSourceFileName(fileName: string): string {
  try {
    const url = new URL(fileName);
    return decodeURIComponent(url.pathname);
  } catch {
    return fileName.replace(/[?#].*$/, "");
  }
}

export function formatSourceLocation(source: DebugSource | null): string | null {
  if (!source?.fileName) {
    return null;
  }
  const fileName = normalizeSourceFileName(source.fileName);
  return source.lineNumber ? `${fileName}:${source.lineNumber}` : fileName;
}

export function readReactMetadata(element: HTMLElement): {
  componentPath: string | null;
  sourceFile: string | null;
} {
  const fiber = getFiberFromElement(element);
  if (!fiber) {
    return { componentPath: null, sourceFile: null };
  }

  const names: string[] = [];
  const seenNames = new Set<string>();
  let current: ReactFiber | null | undefined = fiber;
  let source: DebugSource | null = null;

  while (current) {
    const name = getComponentName(current.type ?? current.elementType);
    if (name && !SKIP_COMPONENT_NAMES.has(name) && !seenNames.has(name)) {
      names.push(name);
      seenNames.add(name);
    }
    if (!source && current._debugSource?.fileName) {
      source = current._debugSource;
    }
    current = current.return;
  }

  return {
    componentPath:
      names.length > 0
        ? names
            .toReversed()
            .map((name) => `<${name}>`)
            .join(" ")
        : null,
    sourceFile: formatSourceLocation(source),
  };
}
