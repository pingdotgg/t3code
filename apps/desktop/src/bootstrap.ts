// @effect-diagnostics nodeBuiltinImport:off - compile caching must precede the application runtime.
import * as NodeModule from "node:module";

// Node honors cache overrides and disable flags; an unavailable cache is nonfatal.
NodeModule.enableCompileCache();

// Stay synchronous so Electron's pre-ready configuration cannot miss ready.
NodeModule.createRequire(__filename)("./runtime.cjs");
