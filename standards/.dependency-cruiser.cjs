const BOARD_ENTRIES = [
  "\\.d\\.ts$",
  "\\.test\\.[cm]?[jt]sx?$",
  "^apps/board/scripts/",
  "^apps/board/vite\\.config\\.ts$",
  "^apps/board/src/main\\.tsx$",
  "^apps/board/electron/(main|preload)\\.ts$",
];

/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-cross-app-imports",
      comment: "An app never imports another app's files.",
      severity: "error",
      from: { path: "^apps/([^/]+)/" },
      to: { path: "^apps/([^/]+)/", pathNot: "^apps/$1/" },
    },
    {
      name: "board-reaches-t3-through-contracts",
      comment:
        "apps/board reaches T3 only through @t3tools/contracts, @t3tools/client-runtime, and @t3tools/shared subpaths.",
      severity: "error",
      from: { path: "^apps/board/" },
      to: { path: "^packages/", pathNot: "^packages/(contracts|client-runtime|shared)/" },
    },
    {
      name: "packages-not-apps",
      comment: "Nothing under packages/ imports from apps/.",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
    {
      name: "renderer-not-main",
      comment: "The renderer never imports the Electron main process.",
      severity: "error",
      from: { path: "^apps/board/src/" },
      to: { path: "^apps/board/electron/" },
    },
    {
      name: "renderer-not-main",
      comment: "The renderer never imports a Node built-in.",
      severity: "error",
      from: { path: "^apps/board/src/", pathNot: "\\.test\\.[cm]?[jt]sx?$" },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "renderer-not-main",
      comment: "The Electron main process never imports react.",
      severity: "error",
      from: { path: "^apps/board/electron/" },
      to: { path: "node_modules/react(-dom)?/" },
    },
    {
      name: "domain-is-pure",
      comment: "apps/board/src/domain imports only other domain files and effect.",
      severity: "error",
      from: { path: "^apps/board/src/domain/" },
      to: { pathNot: ["^apps/board/src/domain/", "node_modules/effect/"] },
    },
    {
      name: "no-circular",
      severity: "error",
      from: { path: "^(apps|packages)/" },
      to: { circular: true },
    },
    {
      name: "no-orphans",
      comment: "Every apps/board module is an entry point or is imported.",
      severity: "error",
      from: { orphan: true, path: "^apps/board/", pathNot: BOARD_ENTRIES },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(dist|dist-electron|build|coverage|\\.repos|\\.agents|\\.claude)/" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types"],
    },
  },
};
