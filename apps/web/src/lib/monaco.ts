import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

type MonacoEnvironmentShape = {
  getWorker(_: string, label: string): Worker;
};

let configured = false;

function createWorker(label: string): Worker {
  switch (label) {
    case "json":
      return new jsonWorker();
    case "css":
    case "scss":
    case "less":
      return new cssWorker();
    case "html":
    case "handlebars":
    case "razor":
      return new htmlWorker();
    case "typescript":
    case "javascript":
      return new tsWorker();
    default:
      return new editorWorker();
  }
}

export function ensureMonacoConfigured(): void {
  if (configured) {
    return;
  }

  loader.config({ monaco });
  Object.assign(globalThis as typeof globalThis & { MonacoEnvironment?: MonacoEnvironmentShape }, {
    MonacoEnvironment: {
      getWorker: (_workerId: string, label: string) => createWorker(label),
    } satisfies MonacoEnvironmentShape,
  });
  configured = true;
}
