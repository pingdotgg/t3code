import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeURL from "node:url";

export function profileStartupModules(session, events, threadId) {
  const now = () => NodePerfHooks.performance.now();
  const origin = NodePerfHooks.performance.timeOrigin;
  const loaded = new Map();
  const compiling = new Map();
  const evaluating = new Map();
  const registryKey = "__t3codeStartupModuleProfiler";
  const previousRegistry = globalThis[registryKey];
  const previousModuleRegistry = NodeModule.default[registryKey];
  const restorers = [];
  let active = true;
  let installed = false;
  let breakpoint;
  let currentLink;
  let nextLink = 0;

  const record = (stage, url, start, end, attributes = {}) => {
    if (!active) return;
    events.push({
      name: `${stage} ${url}`,
      cat: "module.detail",
      ph: "X",
      pid: process.pid,
      tid: threadId,
      ts: (origin + start) * 1000,
      dur: (end - start) * 1000,
      args: { stage, url, ...attributes },
    });
  };
  const toUrl = (file) =>
    file instanceof URL
      ? file.href
      : typeof file === "string"
        ? file.startsWith("file:")
          ? file
          : NodeURL.pathToFileURL(file).href
        : undefined;
  const inject = (source, statement, preserveDirectives) => {
    let offset = source.startsWith("#!") ? source.indexOf("\n") + 1 : 0;
    if (preserveDirectives) {
      for (;;) {
        const trivia = /^(?:\s+|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/.exec(
          source.slice(offset),
        )[0];
        offset += trivia.length;
        if (!/^["']/.test(source.slice(offset))) break;
        const directive = /^(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*')\s*;/.exec(
          source.slice(offset),
        );
        // Leave ambiguous semicolon-free prologues untouched rather than changing strict-mode semantics.
        if (!directive) return undefined;
        offset += directive[0].length;
      }
    }
    return source.slice(0, offset) + statement + source.slice(offset);
  };
  const registry = {
    begin(url) {
      if (active) evaluating.set(url, now());
    },
    end(url) {
      const start = evaluating.get(url);
      if (start === undefined) return;
      record("evaluate", url, start, now(), {
        format: "esm",
        boundary: "module body; top-level await included",
      });
      evaluating.delete(url);
    },
    cjsBegin(filename) {
      const url = toUrl(filename),
        pending = compiling.get(url);
      if (!pending) return;
      pending.evaluationStart = now();
      record("prepare", url, pending.start, pending.evaluationStart, {
        format: "commonjs",
        boundary: "_compile entry to module-body entry",
      });
    },
    install(job) {
      if (installed) return;
      installed = true;
      const loader = Object.getPrototypeOf(job.loader);
      for (const method of [
        "loadAndTranslate",
        "loadAndTranslateForRequireInImportedCJS",
        "loadAndTranslateForImportInRequiredESM",
      ]) {
        const original = loader[method];
        if (typeof original !== "function") continue;
        loader[method] = function (url, ...args) {
          const start = now();
          try {
            return original.call(this, url, ...args);
          } finally {
            const moduleUrl = typeof url === "string" ? url : url.url;
            const pending = loaded.get(moduleUrl);
            if (pending && pending.start >= start)
              record("prepare", moduleUrl, pending.start, now(), {
                format: pending.format,
                boundary:
                  "source-ready to loadAndTranslate return; compilation and format preparation",
              });
          }
        };
        restorers.push(() => {
          loader[method] = original;
        });
      }
      const prototype = Object.getPrototypeOf(Object.getPrototypeOf(job)),
        link = prototype.syncLink;
      prototype.syncLink = function (...args) {
        const start = now(),
          parent = currentLink,
          id = ++nextLink;
        currentLink = { id, url: this.url };
        try {
          return link.apply(this, args);
        } finally {
          record("link", this.url, start, now(), {
            id,
            parentId: parent?.id,
            importedBy: parent?.url,
            boundary: "ModuleJob.syncLink; includes recursive dependency loading",
          });
          currentLink = parent;
        }
      };
      restorers.push(() => {
        prototype.syncLink = link;
      });
    },
  };
  globalThis[registryKey] = registry;
  NodeModule.default[registryKey] = registry;

  session.post("Debugger.enable");
  // One pause obtains the live loader; subsequent measurements use synchronous method boundaries.
  const source = process.binding("natives")["internal/modules/esm/module_job"].split("\n");
  const classLine = source.findIndex((line) => line.includes("class ModuleJob extends"));
  const lineNumber = source.findIndex(
    (line, index) => index > classLine && line.includes("this.linked = this.link("),
  );
  const paused = ({ params }) => {
    if (!breakpoint || !params.hitBreakpoints?.includes(breakpoint)) return;
    const start = now();
    session.post("Debugger.removeBreakpoint", { breakpointId: breakpoint });
    breakpoint = undefined;
    session.post(
      "Debugger.evaluateOnCallFrame",
      {
        callFrameId: params.callFrames[0].callFrameId,
        expression: `globalThis.${registryKey}.install(this)`,
        silent: true,
      },
      (error, result) => {
        if (error || result?.exceptionDetails)
          record("instrumentation-error", "node:esm-loader", start, now());
      },
    );
    record("instrumentation-setup", "node:esm-loader", start, now());
    session.post("Debugger.resume");
  };
  session.on("Debugger.paused", paused);
  if (lineNumber >= 0)
    session.post(
      "Debugger.setBreakpointByUrl",
      {
        url: "node:internal/modules/esm/module_job",
        lineNumber,
      },
      (error, result) => {
        if (!error) breakpoint = result.breakpointId;
      },
    );

  const readFileSync = NodeFS.default.readFileSync;
  NodeFS.default.readFileSync = function (file, ...args) {
    const url = toUrl(file);
    if (!url || !/\.[cm]?[jt]sx?(?:$|\?)/.test(url)) return readFileSync.call(this, file, ...args);
    const start = now();
    try {
      return readFileSync.call(this, file, ...args);
    } finally {
      record("read", url, start, now());
    }
  };
  const compile = NodeModule.default.prototype._compile;
  NodeModule.default.prototype._compile = function (source, filename, ...args) {
    const url = toUrl(filename),
      pending = { start: now() };
    const format = args[0] ?? loaded.get(url)?.format;
    const isEsm =
      format === "module" ||
      format === "module-typescript" ||
      /(^|[;\n])\s*(?:import[\s.]|export\s)/.test(source);
    const annotated = isEsm
      ? undefined
      : inject(source, `module.constructor.${registryKey}?.cjsBegin(__filename);`, true);
    compiling.set(url, pending);
    try {
      return compile.call(this, annotated ?? source, filename, ...args);
    } finally {
      const end = now();
      record(isEsm ? "require-esm" : "commonjs", url, pending.start, end, {
        importedBy: this.parent?.filename ? toUrl(this.parent.filename) : undefined,
        sourceBytes: Buffer.byteLength(source),
      });
      if (pending.evaluationStart !== undefined)
        record("evaluate", url, pending.evaluationStart, end, {
          format: "commonjs",
          includesNestedRequires: true,
        });
      compiling.delete(url);
    }
  };
  NodeModule.syncBuiltinESMExports();

  return {
    sourceReady(url, result) {
      if (!url.startsWith("file:")) return result;
      const format = result.format;
      let source = result.source;
      if (typeof source !== "string" && ArrayBuffer.isView(source))
        source = Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString("utf8");
      if (typeof source === "string" && (format === "module" || format === "module-typescript")) {
        // A module-local globalThis binding would put the injected access in its temporal dead zone.
        if (!/\b(?:const|let|var|class|function|as)\s+globalThis\b/.test(source)) {
          source =
            inject(source, `globalThis.${registryKey}?.begin(import.meta.url);`, false) +
            `\n;globalThis.${registryKey}?.end(import.meta.url);\n`;
          result = { ...result, source };
        }
      }
      loaded.set(url, { start: now(), format });
      return result;
    },
    finish() {
      const end = now();
      for (const [url, start] of evaluating)
        record("evaluate", url, start, end, { incomplete: true });
      record("instrumentation-status", "node:esm-loader", end, end, { installed });
      active = false;
      if (breakpoint) session.post("Debugger.removeBreakpoint", { breakpointId: breakpoint });
      session.off("Debugger.paused", paused);
      session.post("Debugger.disable");
      for (const restore of restorers.reverse()) restore();
      NodeFS.default.readFileSync = readFileSync;
      NodeModule.default.prototype._compile = compile;
      NodeModule.syncBuiltinESMExports();
      if (previousRegistry === undefined) delete globalThis[registryKey];
      else globalThis[registryKey] = previousRegistry;
      if (previousModuleRegistry === undefined) delete NodeModule.default[registryKey];
      else NodeModule.default[registryKey] = previousModuleRegistry;
    },
  };
}
