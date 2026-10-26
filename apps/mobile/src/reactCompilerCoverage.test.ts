// @effect-diagnostics nodeBuiltinImport:off - compiles real source files on disk.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const mobileRoot = NodePath.resolve(__dirname, "..");
const requireFromMobile = NodeModule.createRequire(NodePath.join(mobileRoot, "package.json"));
const babel: {
  transformFileSync: (file: string, options: Record<string, unknown>) => unknown;
} = requireFromMobile("@babel/core");
const metroConfig: Promise<{ transformer: { babelTransformerPath: string } }> =
  requireFromMobile("./metro.config.js");

// Remove bailout entries and manual memoization when compilation starts; this check rejects stale entries.
const KNOWN_BAILOUTS: Record<string, string> = {
  "src/components/ComposerAttachmentStrip.tsx": "unsupported syntax",
  "src/components/ui/Menu.tsx": "ref read during render",
  "src/features/diffs/nativeReviewDiffSurface.ts": "ref read during render",
  "src/features/home/thread-swipe-actions.tsx": "ref read during render",
  "src/features/threads/ThreadArrangementSheet.tsx": "ref read during render",
  "src/features/voice-input/VoiceInputProvider.tsx": "ref read during render",
  "src/features/voice-input/useVoiceInputController.ts": "ref read during render",
  "src/native/T3ComposerEditor.ios.tsx": "ref read during render",
  "src/native/T3ComposerEditor.native.tsx": "ref read during render",
};

// Use Metro's iOS release flags; experiments.reactCompiler enables supportsReactCompiler.
const metroCaller = {
  name: "metro",
  bundler: "metro",
  platform: "ios",
  isDev: false,
  isServer: false,
  isNodeModule: false,
  supportsStaticESM: true,
  supportsReactCompiler: true,
};

const sourceFiles = NodeFS.readdirSync(NodePath.join(mobileRoot, "src"), { recursive: true })
  .map(String)
  .filter((file) => /\.tsx?$/.test(file) && !/\.(test\.tsx?|d\.ts)$/.test(file))
  .map((file) => `src/${file.split(NodePath.sep).join("/")}`)
  .sort();

type CompilerLoc = { readonly start?: { readonly line?: number } } | null;

interface CompilerEvent {
  readonly kind: string;
  readonly detail?: {
    readonly options?: {
      readonly category?: string;
      readonly reason?: string;
      readonly loc?: CompilerLoc;
      readonly details?: readonly { readonly loc?: CompilerLoc }[];
    };
  };
}

// babel.config.js is the file Metro loads; the logger rides on the preset's
// own react-compiler option so the plugin runs with Metro's exact settings.
function compileLikeMetro(file: string, events: CompilerEvent[], output: Record<string, unknown>) {
  const babelConfig = requireFromMobile("./babel.config.js")({ cache: () => {} });
  const presets = babelConfig.presets.map(([name, options]: [string, object]) =>
    name === "babel-preset-expo"
      ? [
          requireFromMobile.resolve(name),
          {
            ...options,
            "react-compiler": {
              logger: { logEvent: (_: string, event: CompilerEvent) => events.push(event) },
            },
          },
        ]
      : [name, options],
  );
  return babel.transformFileSync(NodePath.join(mobileRoot, file), {
    babelrc: false,
    configFile: false,
    cwd: mobileRoot,
    presets,
    caller: metroCaller,
    code: false,
    ...output,
  });
}

function compilerBailouts(file: string): string[] {
  const events: CompilerEvent[] = [];
  compileLikeMetro(file, events, {});
  return events
    .filter((event) => event.kind === "CompileError" || event.kind === "CompileSkip")
    .map(
      (event) =>
        `line ${(event.detail?.options?.loc ?? event.detail?.options?.details?.[0]?.loc)?.start?.line ?? "?"}: ${event.detail?.options?.category ?? event.kind} ${event.detail?.options?.reason ?? ""}`,
    );
}

interface AstNode {
  readonly type: string;
  readonly [key: string]: unknown;
}

const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";

function walkAst(
  value: unknown,
  visit: (node: AstNode, ancestors: readonly AstNode[]) => void,
  ancestors: readonly AstNode[] = [],
) {
  if (typeof value !== "object" || value === null) return;
  const node = isAstNode(value) ? value : null;
  if (node) visit(node, ancestors);
  const childAncestors = node ? [...ancestors, node] : ancestors;
  for (const child of Object.values(value)) walkAst(child, visit, childAncestors);
}

// For each call to `callee`, whether it runs only on the cache-miss branch of
// an `if ($[n] !== dep)` block rather than on every render.
function compilerCachedCalls(file: string, callee: string): boolean[] {
  const result = compileLikeMetro(file, [], { ast: true });
  const cached: boolean[] = [];
  if (typeof result !== "object" || result === null || !("ast" in result)) return cached;
  walkAst(result.ast, (node, ancestors) => {
    if (node.type !== "CallExpression" || !isAstNode(node.callee)) return;
    if (node.callee.type !== "Identifier" || node.callee.name !== callee) return;
    cached.push(
      ancestors.some(
        (ancestor, index) =>
          ancestor.type === "IfStatement" &&
          ancestors[index + 1] === ancestor.consequent &&
          JSON.stringify(ancestor.test).includes('"name":"$"'),
      ),
    );
  });
  return cached;
}

describe("React Compiler coverage", () => {
  it("Metro's transformer applies the compiler", async () => {
    const { transformer } = await metroConfig;
    const metroTransformer = requireFromMobile(transformer.babelTransformerPath);
    const filename = NodePath.join(
      mobileRoot,
      "src/features/archive/ArchivedThreadsRouteScreen.tsx",
    );
    const transformed = (reactCompiler: string) => {
      const { ast } = metroTransformer.transform({
        filename,
        src: NodeFS.readFileSync(filename, "utf8"),
        plugins: [],
        options: {
          dev: false,
          hot: false,
          platform: "ios",
          projectRoot: mobileRoot,
          type: "module",
          enableBabelRCLookup: false,
          experimentalImportSupport: false,
          customTransformOptions: { reactCompiler, routerRoot: "app" },
        },
      });
      return JSON.stringify(ast.program.body);
    };
    expect(transformed("true")).toContain("react/compiler-runtime");
    expect(transformed("false")).not.toContain("react/compiler-runtime");
  });

  it.each(sourceFiles)("compiles %s", (file) => {
    const bailouts = compilerBailouts(file);
    if (file in KNOWN_BAILOUTS) {
      expect(bailouts, `${file} compiles now; remove it from KNOWN_BAILOUTS`).not.toEqual([]);
    } else {
      expect(bailouts).toEqual([]);
    }
  });

  // The compiler once silently dropped this cache, so every
  // ThreadFeed render rebuilt the feed and handed LegendList a new data array.
  it("caches the thread feed derivation", () => {
    expect(
      compilerCachedCalls("src/features/threads/ThreadFeed.tsx", "deriveThreadFeedPresentation"),
    ).toEqual([true]);
  });

  it("lists only files that exist", () => {
    expect(Object.keys(KNOWN_BAILOUTS).filter((file) => !sourceFiles.includes(file))).toEqual([]);
  });
});
