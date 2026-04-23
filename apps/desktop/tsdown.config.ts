import { defineConfig } from "tsdown";

const shared = {
  format: "cjs" as const,
  outDir: "dist-electron",
  sourcemap: true,
  outExtensions: () => ({ js: ".cjs" }),
};

const EMBEDDED_JIRA_KEYS = ["MARCODE_JIRA_REDIRECT_URI", "MARCODE_JIRA_TOKEN_PROXY_URL"] as const;

const embeddedJiraDefines: Record<string, string> = {};
for (const key of EMBEDDED_JIRA_KEYS) {
  const value = process.env[key];
  embeddedJiraDefines[`__EMBEDDED_${key}__`] = JSON.stringify(value ?? "");
}

export default defineConfig([
  {
    ...shared,
    entry: ["src/main.ts"],
    clean: true,
    noExternal: (id) => id.startsWith("@marcode/") || id.startsWith("effect-acp"),
    define: embeddedJiraDefines,
  },
  {
    ...shared,
    entry: ["src/preload.ts"],
  },
]);
