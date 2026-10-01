import type {
  ClientCodeView,
  CodeViewDiffProps,
  CodeViewFileProps,
  CodeViewEditorProps,
} from "@t3tools/extension-sdk/environment";
import { lazy, Suspense } from "react";

// The viewer stack (Pierre, the worker pool, Shiki) loads with the first
// plugin view that renders code, not with the installed-extension bootstrap.
const loadRenderers = () => import("./HostCodeViewRenderers");
const LazyDiff = lazy(() => loadRenderers().then((module) => ({ default: module.HostCodeDiff })));
const LazyFile = lazy(() => loadRenderers().then((module) => ({ default: module.HostCodeFile })));
const LazyEditor = lazy(() =>
  loadRenderers().then((module) => ({ default: module.HostCodeEditor })),
);

function CodeViewLoading() {
  return (
    <div
      role="status"
      className="flex min-h-0 flex-1 items-center justify-center p-4 text-xs text-muted-foreground"
    >
      Loading code...
    </div>
  );
}

function Diff(props: CodeViewDiffProps) {
  return (
    <Suspense fallback={<CodeViewLoading />}>
      <LazyDiff {...props} />
    </Suspense>
  );
}

function File(props: CodeViewFileProps) {
  return (
    <Suspense fallback={<CodeViewLoading />}>
      <LazyFile {...props} />
    </Suspense>
  );
}

function Editor(props: CodeViewEditorProps) {
  return (
    <Suspense fallback={<CodeViewLoading />}>
      <LazyEditor {...props} />
    </Suspense>
  );
}

/** The web and desktop `ClientHost.codeView`, shared by every installed client. */
export const hostCodeView: ClientCodeView = { version: 1, Diff, File, Editor };
