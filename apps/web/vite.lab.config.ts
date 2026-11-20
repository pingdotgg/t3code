// Conn UI lab: the app's own Vite config plus one swap, the connection driver for the fake
// environment (src/lab/labDriver.ts). `vp dev --config vite.lab.config.ts` serves lab.html;
// `vp build --config vite.lab.config.ts` writes a bundle that loads fast over WireGuard.
import { fileURLToPath } from "node:url";
import type { Plugin, UserConfig } from "vite-plus";
import base from "./vite.config";

const src = fileURLToPath(new URL("./src/", import.meta.url));
const pr = `${src}lab/pr/`;
// Real module → lab stand-in. The driver is the fake server; the rest give the PR panel a real
// PR's fixture (src/lab/pr) instead of the source-control RPCs.
const STUBBED: Record<string, string> = {
  [fileURLToPath(
    new URL("../../packages/client-runtime/src/connection/driver.ts", import.meta.url),
  )]: `${src}lab/labDriver.ts`,
  // The icon switch (src/lab/icons): connIcon asks this module for a replacement glyph.
  [`${src}icons/iconOverride.ts`]: `${src}lab/icons/iconOverride.tsx`,
  [`${src}state/session.ts`]: `${pr}session.ts`,
  [`${src}state/sourceControlActions.ts`]: `${pr}sourceControlActions.ts`,
  [`${src}state/use-atom-command.ts`]: `${pr}use-atom-command.ts`,
  [`${src}state/usePullRequestStack.ts`]: `${pr}usePullRequestStack.ts`,
  [`${src}state/pullRequests.ts`]: `${pr}pullRequests.ts`,
  [`${src}components/pullRequest/usePullRequestDetail.ts`]: `${pr}usePullRequestDetail.ts`,
};

function labStubs(): Plugin {
  return {
    name: "conn-lab-driver",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      const stub = resolved ? STUBBED[resolved.id.split("?")[0]!] : undefined;
      // A stand-in reaches the real module it wraps; every other importer gets the stand-in.
      if (!stub || importer.split("?")[0] === stub) return null;
      return stub;
    },
    // Tasks reads Conn's own Orbit fixtures, which only dev builds allow; the lab bundle is a
    // production build, so this one module keeps its dev path.
    transform(code, id) {
      if (!id.split("?")[0]!.endsWith("/src/orbit/tasks/orbitTasksClient.ts")) return null;
      return code.replaceAll("import.meta.env.DEV", "true");
    },
  };
}

export default async (env: Parameters<Extract<typeof base, (...args: never[]) => unknown>>[0]) => {
  const config = (typeof base === "function" ? await base(env) : base) as UserConfig;
  return {
    ...config,
    plugins: [labStubs(), ...(config.plugins ?? [])],
    optimizeDeps: { ...config.optimizeDeps, entries: ["lab.html", "mobile.html"] },
    build: {
      ...config.build,
      outDir: process.env.LAB_OUT_DIR ?? "dist-lab",
      emptyOutDir: true,
      rolldownOptions: {
        ...config.build?.rolldownOptions,
        // mobile.html is the iOS design lab (src/lab/mobile).
        input: { lab: "lab.html", mobile: "mobile.html" },
      },
    },
  } satisfies UserConfig;
};
