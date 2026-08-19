import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ProcessRunner from "../processRunner.ts";
import {
  makeWithOptions,
  parseCursorMarketplaceHtml,
  type CodexPluginRuntime,
} from "./CodexPluginMarketplace.ts";
import type { McpOAuthRuntime } from "./McpOAuthRuntime.ts";
import { PluginMarketplaceUnavailableError } from "@t3tools/contracts";

const processOutput = (stdout: string) => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const unavailableProcessOutput = {
  ...processOutput(""),
  code: ChildProcessSpawner.ExitCode(1),
};

function cursorMarketplaceHtml(plugins: ReadonlyArray<unknown>): string {
  const escaped = JSON.stringify(JSON.stringify(plugins)).slice(1, -1);
  return `x:\\"initialPlugins\\":${escaped},\\"initialTemplates\\":[]`;
}

const unusedHttpClient = HttpClient.make(() =>
  Effect.die("Cursor HTTP should not run in plugin marketplace tests."),
);

const makeTestMarketplace = makeWithOptions({
  readCursorMarketplaceHtml: () =>
    new PluginMarketplaceUnavailableError({
      reason: "marketplaces_unavailable",
      cause: new Error("Marketplace unavailable in test."),
    }),
}).pipe(Effect.provideService(HttpClient.HttpClient, unusedHttpClient));

const testLayer = it.layer(NodeServices.layer);

testLayer("CodexPluginMarketplace", (it) => {
  it("extracts the published Cursor plugin payload", () => {
    const html = String.raw`<script>self.__next_f.push([1,"x:{\"initialPlugins\":[{\"id\":\"730\",\"name\":\"posthog\"}],\"initialTemplates\":[]}"])</script>`;

    assert.deepStrictEqual(parseCursorMarketplaceHtml(html), [{ id: "730", name: "posthog" }]);
  });

  it.effect("loads real manifest, skill, MCP, app, and artwork metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-marketplace-" });
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-outside-" });
      yield* fs.makeDirectory(path.join(root, ".codex-plugin"), { recursive: true });
      yield* fs.makeDirectory(path.join(root, "skills", "computer-use"), { recursive: true });
      yield* fs.makeDirectory(path.join(root, "assets"), { recursive: true });
      yield* fs.writeFileString(
        path.join(outside, "SKILL.md"),
        "---\nname: escaped\ndescription: Must not be returned.\n---",
      );
      yield* fs.symlink(outside, path.join(root, "skills", "escaped"));
      yield* fs.writeFileString(
        path.join(root, ".codex-plugin", "plugin.json"),
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          name: "computer-use",
          version: "1.0.1000633",
          description: "Control local apps.",
          homepage: "https://user:secret@/computer-use?token=hidden",
          skills: "./skills",
          mcpServers: "./.mcp.json",
          apps: "./.app.json",
          interface: {
            displayName: "Computer Use",
            shortDescription: "Control Mac apps from Codex",
            longDescription: "Use Codex to operate approved Mac applications.",
            developerName: "OpenAI",
            category: "Productivity",
            logo: "./assets/app-icon.png",
            defaultPrompt: "Play a playlist to help me focus",
          },
        }),
      );
      yield* fs.writeFileString(
        path.join(root, "skills", "computer-use", "SKILL.md"),
        [
          "---",
          "name: computer-use",
          "description: Operate local Mac application UI.",
          "---",
          "Use the bundled MCP server.",
        ].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(root, ".mcp.json"),
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          mcpServers: {
            "computer-use": {
              command: "computer-use",
              args: ["serve"],
              env: { COMPUTER_USE_TOKEN: "never-return-this-value" },
            },
          },
        }),
      );
      yield* fs.writeFileString(
        path.join(root, ".app.json"),
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({ apps: { "computer-use": { id: "computer-use-connector" } } }),
      );
      yield* fs.writeFile(path.join(root, "assets", "app-icon.png"), new Uint8Array(60 * 1024));

      const record = {
        pluginId: "computer-use@openai-bundled",
        name: "computer-use",
        marketplaceName: "openai-bundled",
        version: "1.0.1000633",
        installed: true,
        enabled: true,
        source: { source: "git", path: root },
        marketplaceSource: { sourceType: "git", source: "openai/plugins" },
        installPolicy: "AVAILABLE",
        authPolicy: "ON_INSTALL",
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const catalogJson = JSON.stringify({ installed: [record], available: [] });
      let codexCommand = "/tools/custom-codex";
      let codexEnvironment: NodeJS.ProcessEnv | undefined;
      const observedCommands: Array<string> = [];
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) => {
          observedCommands.push(input.command);
          if (input.command !== codexCommand) {
            return Effect.succeed(unavailableProcessOutput);
          }
          codexEnvironment = input.env;
          if (input.args.includes("remove")) {
            return Effect.succeed({
              ...unavailableProcessOutput,
              stderr: "token=never-return-this-token /private/workspace",
            });
          }
          return Effect.succeed(processOutput(catalogJson));
        },
      });
      const marketplace = yield* makeWithOptions({
        resolveCommand: (harness) =>
          Effect.succeed(
            harness === "codex"
              ? {
                  command: codexCommand,
                  env: { ...process.env, CODEX_HOME: "/custom/codex-home" },
                }
              : undefined,
          ),
        readCursorMarketplaceHtml: () =>
          new PluginMarketplaceUnavailableError({
            reason: "marketplaces_unavailable",
            cause: new Error("Marketplace unavailable in test."),
          }),
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.provideService(HttpClient.HttpClient, unusedHttpClient),
      );

      const catalog = yield* marketplace.catalog();
      const detail = yield* marketplace.detail(`codex:${record.pluginId}`);
      const logo = yield* marketplace.logo(`codex:${record.pluginId}`);

      assert.strictEqual(catalog.plugins[0]?.name, "Computer Use");
      assert.strictEqual(catalog.plugins[0]?.hasLocalLogo, true);
      assert.strictEqual(catalog.plugins[0]?.logoDataUrl, null);
      expect(logo.dataUrl).toMatch(/^data:image\/png;base64,/u);
      expect(detail.logoDataUrl).toBe(logo.dataUrl);
      expect(detail.homepage).not.toContain("secret");
      expect(detail.homepage).not.toContain("hidden");
      assert.strictEqual(codexEnvironment?.CODEX_HOME, "/custom/codex-home");
      assert.deepStrictEqual(detail.skills, [
        {
          id: "computer-use",
          name: "computer-use",
          description: "Operate local Mac application UI.",
          invocation: "$computer-use:computer-use",
        },
      ]);
      assert.deepStrictEqual(detail.mcpServers, [
        {
          id: "computer-use",
          name: "Computer Use",
          transport: "stdio",
          url: null,
          oauthResource: null,
          note: null,
          toolTimeoutSeconds: null,
          environmentVariables: ["COMPUTER_USE_TOKEN"],
        },
      ]);
      assert.deepStrictEqual(detail.apps, [
        { id: "computer-use", name: "Computer Use", connectorId: "computer-use-connector" },
      ]);
      assert.deepStrictEqual(detail.defaultPrompts, ["Play a playlist to help me focus"]);
      expect(detail.mcpServers[0]?.environmentVariables).not.toContain("never-return-this-value");
      codexCommand = "/tools/updated-codex";
      const error = yield* marketplace.remove(`codex:${record.pluginId}`).pipe(Effect.flip);
      assert.strictEqual(observedCommands.at(-1), "/tools/updated-codex");
      if (error._tag !== "PluginMarketplaceOperationError") {
        return assert.fail(`Expected an operation error, received ${error._tag}.`);
      }
      assert.strictEqual(error.detail, "The provider exited with status 1.");
      expect(error.detail).not.toContain("never-return-this-token");
      assert.strictEqual(error.cause, undefined);
      assert.strictEqual(error.exitCode, 1);
    }),
  );

  it.effect("maps remote MCP OAuth through the installed harness", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-oauth-" });
      yield* fs.makeDirectory(path.join(root, ".codex-plugin"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, ".codex-plugin", "plugin.json"),
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({ name: "figma", mcpServers: "./.mcp.json" }),
      );
      yield* fs.writeFileString(
        path.join(root, ".mcp.json"),
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          mcpServers: {
            figma: { type: "http", url: "https://mcp.figma.com/mcp" },
          },
        }),
      );
      const record = {
        pluginId: "figma@openai-curated",
        name: "figma",
        marketplaceName: "openai-curated",
        version: "2.0.17",
        installed: true,
        enabled: true,
        source: { source: "local", path: root },
        installPolicy: "AVAILABLE",
        authPolicy: "ON_INSTALL",
      };
      const starts: Array<string> = [];
      const oauthRuntime = {
        status: () =>
          Effect.succeed([
            {
              name: "figma",
              url: "https://mcp.figma.com/mcp",
              status: "not_connected",
              detail: "Sign in with Codex to use this MCP server",
              authorizationUrl: null,
              canConnect: true,
              canDisconnect: false,
            },
          ]),
        start: (_harness, name) =>
          Effect.sync(() => {
            starts.push(name);
            return {
              authorizationUrl: "https://accounts.figma.com/oauth",
              callbackRequired: false,
            };
          }),
        complete: () => Effect.void,
        disconnect: () => Effect.void,
      } satisfies McpOAuthRuntime["Service"];
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.succeed(
            input.command === "codex"
              ? processOutput(JSON.stringify({ installed: [record], available: [] }))
              : unavailableProcessOutput,
          ),
      });
      const marketplace = yield* makeWithOptions({
        mcpOAuthRuntime: oauthRuntime,
        readCursorMarketplaceHtml: () =>
          new PluginMarketplaceUnavailableError({
            reason: "marketplaces_unavailable",
            cause: new Error("Marketplace unavailable in test."),
          }),
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.provideService(HttpClient.HttpClient, unusedHttpClient),
      );
      const pluginId = `codex:${record.pluginId}`;

      const state = yield* marketplace.mcpAuth(pluginId);
      assert.strictEqual(state.connections[0]?.status, "not_connected");
      assert.strictEqual(state.connections[0]?.canConnect, true);
      const started = yield* marketplace.startMcpAuth(pluginId, "codex", "figma");
      assert.strictEqual(started.authorizationUrl, "https://accounts.figma.com/oauth");
      assert.deepStrictEqual(starts, ["figma"]);
    }),
  );

  it.effect("groups same-name packages and keeps each harness installable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-shared-" });
      const codexRecord = {
        pluginId: "figma@openai-curated",
        name: "figma",
        marketplaceName: "openai-curated",
        version: "2.0.0",
        installed: false,
        enabled: false,
        source: { source: "git", path: root },
        installPolicy: "AVAILABLE",
        authPolicy: "ON_INSTALL",
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const codexCatalog = JSON.stringify({ installed: [], available: [codexRecord] });
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const claudeCatalog = JSON.stringify({
        installed: [],
        available: [
          {
            pluginId: "figma@claude-plugins-official",
            name: "figma",
            description: "Figma design tools",
            marketplaceName: "claude-plugins-official",
            source: { source: "git", url: "https://example.com/figma.git" },
          },
        ],
      });
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) => {
          if (input.command === "codex") return Effect.succeed(processOutput(codexCatalog));
          if (input.args[1] === "list") return Effect.succeed(processOutput(claudeCatalog));
          if (input.args[1] === "marketplace") return Effect.succeed(processOutput("[]"));
          return Effect.succeed(unavailableProcessOutput);
        },
      });
      const marketplace = yield* makeTestMarketplace.pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
      );

      const catalog = yield* marketplace.catalog();
      const detail = yield* marketplace.detail("codex:figma@openai-curated");
      const claudeDetail = yield* marketplace.detail("claude:figma@claude-plugins-official");

      assert.strictEqual(catalog.plugins.length, 1);
      assert.strictEqual(catalog.plugins[0]?.id, "codex:figma@openai-curated");
      assert.deepStrictEqual(
        catalog.plugins[0]?.support.map((entry) => entry.harness),
        ["codex", "claude"],
      );
      assert.deepStrictEqual(
        detail.installTargets.map((target) => ({
          pluginId: target.pluginId,
          harness: target.harness,
          installed: target.installed,
        })),
        [
          { pluginId: "codex:figma@openai-curated", harness: "codex", installed: false },
          {
            pluginId: "claude:figma@claude-plugins-official",
            harness: "claude",
            installed: false,
          },
        ],
      );
      assert.deepStrictEqual(
        claudeDetail.installTargets.map((target) => target.pluginId),
        detail.installTargets.map((target) => target.pluginId),
      );
    }),
  );

  it.effect("previews remote Claude package skills, MCP servers, hooks, and artwork", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const claudeCatalog = JSON.stringify({
        installed: [],
        available: [
          {
            pluginId: "figma@claude-plugins-official",
            name: "figma",
            description: "Figma design tools",
            marketplaceName: "claude-plugins-official",
            source: {
              source: "url",
              url: "https://github.com/figma/mcp-server-guide.git",
              ref: "feature/oauth-preview",
            },
          },
        ],
      });
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) => {
          if (input.command === "codex") return Effect.succeed(unavailableProcessOutput);
          if (input.args[1] === "list") return Effect.succeed(processOutput(claudeCatalog));
          if (input.args[1] === "marketplace") return Effect.succeed(processOutput("[]"));
          return Effect.succeed(unavailableProcessOutput);
        },
      });
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const tree = JSON.stringify({
        truncated: false,
        tree: [
          { type: "blob", path: ".claude-plugin/plugin.json" },
          { type: "blob", path: ".mcp.json" },
          { type: "blob", path: "Figma Icon.svg" },
          { type: "blob", path: "hooks/hooks.json" },
          { type: "blob", path: "skills/design-to-code/SKILL.md" },
        ],
      });
      const remoteUrls: Array<string> = [];
      const marketplace = yield* makeWithOptions({
        readCursorMarketplaceHtml: () =>
          new PluginMarketplaceUnavailableError({
            reason: "marketplaces_unavailable",
            cause: new Error("Marketplace unavailable in test."),
          }),
        readRemoteText: (url) =>
          Effect.sync(() => {
            remoteUrls.push(url);
            return url.includes("/commits/")
              ? '{"sha":"abc123"}'
              : url.includes("/git/trees/")
                ? tree
                : url.endsWith("/.claude-plugin/plugin.json")
                  ? '{"name":"figma","version":"2.2.95","description":"Figma plugin for design workflows","author":{"name":"Figma"}}'
                  : url.endsWith("/skills/design-to-code/SKILL.md")
                    ? [
                        "---",
                        "name: design-to-code",
                        "description: Turn Figma designs into implementation-ready code.",
                        "---",
                      ].join("\n")
                    : url.endsWith("/.mcp.json")
                      ? '{"mcpServers":{"figma":{"type":"http","url":"https://mcp.figma.com/mcp"}}}'
                      : null;
          }),
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.provideService(HttpClient.HttpClient, unusedHttpClient),
      );

      const detail = yield* marketplace.detail("claude:figma@claude-plugins-official");

      assert.strictEqual(detail.version, "2.2.95");
      assert.strictEqual(detail.skills[0]?.id, "design-to-code");
      assert.strictEqual(detail.mcpServers[0]?.url, "https://mcp.figma.com/mcp");
      assert.strictEqual(detail.extensions[0]?.kind, "hook");
      assert.strictEqual(detail.contents.hookCount, 1);
      expect(detail.logoUrl).toMatch(/Figma%20Icon\.svg$/u);
      expect(remoteUrls).toContain(
        "https://api.github.com/repos/figma/mcp-server-guide/commits/feature%2Foauth-preview",
      );
      expect(remoteUrls.some((url) => url.includes("/abc123/"))).toBe(true);
    }),
  );

  it.effect("uses Cursor publisher artwork and exposes editor-specific components", () =>
    Effect.gen(function* () {
      const runner = ProcessRunner.ProcessRunner.of({
        run: () => Effect.succeed(unavailableProcessOutput),
      });
      const html = cursorMarketplaceHtml([
        {
          id: "730",
          name: "posthog",
          displayName: "PostHog",
          description: "Product analytics for Cursor",
          repositoryUrl: "https://github.com/PostHog/posthog",
          publisher: {
            name: "posthog",
            displayName: "PostHog",
            logoUrl: "https://cdn.example.com/posthog.png",
          },
          marketplace: { name: "cursor-public", displayName: "Cursor Marketplace" },
          curatedCategoryKeys: ["data-analytics"],
          skills: [{ name: "analytics", description: "Analyze product usage" }],
          commands: [{ name: "query", description: "Run a product query" }],
          rules: [{ name: "tracking", description: "Apply tracking conventions" }],
          subagents: [{ name: "analyst", description: "Analyze product data" }],
          hooks: [{ name: "sessionstart", description: "Load project context" }],
        },
      ]);
      const marketplace = yield* makeWithOptions({
        readCursorMarketplaceHtml: () => Effect.succeed(html),
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.provideService(HttpClient.HttpClient, unusedHttpClient),
      );

      const catalog = yield* marketplace.catalog();
      const detail = yield* marketplace.detail("cursor:730");

      assert.strictEqual(catalog.plugins[0]?.logoUrl, "https://cdn.example.com/posthog.png");
      assert.strictEqual(catalog.plugins[0]?.category, "Data & Analytics");
      assert.deepStrictEqual(
        detail.extensions.map((extension) => extension.kind),
        ["agent", "command", "hook", "rule"],
      );
      assert.strictEqual(detail.contents.commandCount, 1);
      assert.strictEqual(detail.contents.agentCount, 1);
      assert.strictEqual(detail.contents.ruleCount, 1);
      assert.strictEqual(detail.contents.hookCount, 1);
    }),
  );

  it.effect("includes ChatGPT public directory plugins that Codex marketplaces omit", () =>
    Effect.gen(function* () {
      const runner = ProcessRunner.ProcessRunner.of({
        run: () => Effect.succeed(unavailableProcessOutput),
      });
      const marketplace = yield* makeWithOptions({
        readCursorMarketplaceHtml: () =>
          new PluginMarketplaceUnavailableError({
            reason: "marketplaces_unavailable",
            cause: new Error("Marketplace unavailable in test."),
          }),
        readChatGptPublicPlugins: () =>
          Effect.succeed([
            {
              id: "ticktick-public",
              name: "ticktick",
              displayName: "TickTick:To-Do List & Calendar",
              description: "Reminder, Planner, Countdown",
              developer: "TickTick",
              category: "Productivity",
              version: "1.2.0",
              logoUrl: "https://ticktick.com/icon.png",
              homepage: "https://ticktick.com",
              appCount: 1,
              skillCount: 0,
            },
          ]),
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.provideService(HttpClient.HttpClient, unusedHttpClient),
      );

      const catalog = yield* marketplace.catalog();
      const detail = yield* marketplace.detail("codex:ticktick@chatgpt-public");

      assert.strictEqual(catalog.plugins.length, 1);
      assert.strictEqual(catalog.plugins[0]?.name, "TickTick:To-Do List & Calendar");
      assert.strictEqual(catalog.plugins[0]?.marketplaceName, "ChatGPT Public");
      assert.strictEqual(detail.installTargets[0]?.installPolicy, "EXTERNAL");
      assert.strictEqual(detail.contents.appCount, 1);
      expect(detail.marketplaceUrl).toContain("chatgpt.com/plugins?q=");
    }),
  );

  it.effect("merges ChatGPT public search hits that the browse catalog omits", () =>
    Effect.gen(function* () {
      const runner = ProcessRunner.ProcessRunner.of({
        run: () => Effect.succeed(unavailableProcessOutput),
      });
      const marketplace = yield* makeWithOptions({
        readCursorMarketplaceHtml: () =>
          new PluginMarketplaceUnavailableError({
            reason: "marketplaces_unavailable",
            cause: new Error("Marketplace unavailable in test."),
          }),
        readChatGptPublicPlugins: () =>
          Effect.succeed([
            {
              id: "github-public",
              name: "github",
              displayName: "GitHub",
              description: "Triage PRs and issues",
              developer: "GitHub",
              category: "Developer Tools",
              version: "Latest",
              logoUrl: null,
              homepage: null,
              appCount: 1,
              skillCount: 0,
            },
          ]),
        searchChatGptPublicPlugins: (query) =>
          Effect.succeed(
            query.includes("tick")
              ? [
                  {
                    id: "ticktick-public",
                    name: "app-69ddbaba3fb48191a825f22c21b0599d",
                    displayName: "TickTick:To-Do List & Calendar",
                    description: "Reminder, Planner, Countdown",
                    developer: "Appest Inc",
                    category: "Productivity",
                    version: "1.0.0",
                    logoUrl: "https://ticktick.com/icon.png",
                    homepage: "https://ticktick.com",
                    appCount: 1,
                    skillCount: 0,
                  },
                ]
              : [],
          ),
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.provideService(HttpClient.HttpClient, unusedHttpClient),
      );

      const browse = yield* marketplace.catalog();
      const search = yield* marketplace.catalog("tick");
      const detail = yield* marketplace.detail(
        "codex:app-69ddbaba3fb48191a825f22c21b0599d@chatgpt-public",
      );

      assert.deepStrictEqual(
        browse.plugins.map((plugin) => plugin.name),
        ["GitHub"],
      );
      assert.deepStrictEqual(
        search.plugins.map((plugin) => plugin.name),
        ["GitHub", "TickTick:To-Do List & Calendar"],
      );
      assert.strictEqual(detail.marketplaceName, "ChatGPT Public");
      assert.strictEqual(detail.installTargets[0]?.installPolicy, "EXTERNAL");
    }),
  );

  it.effect("does not duplicate a ChatGPT public plugin already listed by Codex", () =>
    Effect.gen(function* () {
      const record = {
        pluginId: "hubspot@openai-curated",
        name: "hubspot",
        marketplaceName: "openai-curated",
        version: "2.0.0",
        installed: false,
        enabled: false,
        source: { source: "git", path: "/tmp/hubspot" },
        installPolicy: "AVAILABLE",
        authPolicy: "ON_INSTALL",
      };
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.succeed(
            input.command === "codex"
              ? processOutput(JSON.stringify({ installed: [], available: [record] }))
              : unavailableProcessOutput,
          ),
      });
      const marketplace = yield* makeWithOptions({
        readCursorMarketplaceHtml: () =>
          new PluginMarketplaceUnavailableError({
            reason: "marketplaces_unavailable",
            cause: new Error("Marketplace unavailable in test."),
          }),
        readChatGptPublicPlugins: () =>
          Effect.succeed([
            {
              id: "hubspot-public",
              name: "hubspot",
              displayName: "HubSpot",
              description: "Insights to action in HubSpot",
              developer: "HubSpot",
              category: "Business & Operations",
              version: "Latest",
              logoUrl: null,
              homepage: null,
              appCount: 1,
              skillCount: 0,
            },
          ]),
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.provideService(HttpClient.HttpClient, unusedHttpClient),
      );

      const catalog = yield* marketplace.catalog();
      assert.deepStrictEqual(
        catalog.plugins.map((plugin) => plugin.id),
        ["codex:hubspot@openai-curated"],
      );
      const detail = yield* marketplace.detail("codex:hubspot@openai-curated");
      assert.deepStrictEqual(detail.installTargets.map((target) => target.pluginId).toSorted(), [
        "codex:hubspot@chatgpt-public",
        "codex:hubspot@openai-curated",
      ]);
    }),
  );

  it.effect("installs only the catalog-resolved package through Codex", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-install-" });
      const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> =
        [];
      const record = {
        pluginId: "computer-use@openai-bundled",
        name: "computer-use",
        marketplaceName: "openai-bundled",
        version: "1.0.1000633",
        installed: false,
        enabled: false,
        source: { source: "git", path: root },
        installPolicy: "AVAILABLE",
        authPolicy: "ON_INSTALL",
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const catalogJson = JSON.stringify({ installed: [], available: [record] });
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const installJson = JSON.stringify({ pluginId: record.pluginId, installed: true });
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.sync(() => {
            commands.push({ command: input.command, args: input.args });
            if (input.command !== "codex") return unavailableProcessOutput;
            return processOutput(input.args[1] === "list" ? catalogJson : installJson);
          }),
      });
      const marketplace = yield* makeTestMarketplace.pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
      );

      const publicId = `codex:${record.pluginId}`;
      const result = yield* marketplace.install(publicId);

      assert.deepStrictEqual(result, { pluginId: publicId, installed: true });
      expect(commands).toContainEqual({
        command: "codex",
        args: ["plugin", "list", "--available", "--json"],
      });
      expect(commands).toContainEqual({
        command: "codex",
        args: ["plugin", "add", record.pluginId, "--json"],
      });
    }),
  );

  it.effect("removes only the catalog-resolved package through Codex", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-remove-" });
      const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> =
        [];
      const record = {
        pluginId: "apollo@openai-curated",
        name: "apollo",
        marketplaceName: "openai-curated",
        version: "1.0.0",
        installed: true,
        enabled: true,
        source: { source: "git", path: root },
        installPolicy: "AVAILABLE",
        authPolicy: "ON_INSTALL",
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const catalogJson = JSON.stringify({ installed: [record], available: [] });
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.sync(() => {
            commands.push({ command: input.command, args: input.args });
            if (input.command !== "codex") return unavailableProcessOutput;
            return processOutput(input.args[1] === "list" ? catalogJson : "");
          }),
      });
      const marketplace = yield* makeTestMarketplace.pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
      );

      const publicId = `codex:${record.pluginId}`;
      const result = yield* marketplace.remove(publicId);

      assert.deepStrictEqual(result, { pluginId: publicId, installed: false });
      expect(commands).toContainEqual({
        command: "codex",
        args: ["plugin", "remove", record.pluginId, "--json"],
      });
    }),
  );

  it.effect("uses Codex runtime state and backend ids for official plugins", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-runtime-" });
      const runtimeInstalls: Array<string> = [];
      const runtimeRemovals: Array<string> = [];
      const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> =
        [];
      const record = {
        pluginId: "hyperframes@openai-curated",
        name: "hyperframes",
        marketplaceName: "openai-curated",
        version: "0.1.2",
        installed: true,
        enabled: true,
        source: { source: "local", path: root },
        installPolicy: "AVAILABLE",
        authPolicy: "ON_INSTALL",
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const catalogJson = JSON.stringify({ installed: [record], available: [] });
      let runtimeInstalled = false;
      let failLegacyRemoval = false;
      const runtime = {
        installed: () =>
          Effect.succeed(
            runtimeInstalled
              ? [
                  {
                    id: "hyperframes@openai-curated-remote",
                    name: "hyperframes",
                    marketplaceName: "openai-curated-remote",
                    remotePluginId: "Plugin_hyperframes",
                    installed: true,
                    enabled: true,
                  },
                ]
              : [],
          ),
        install: (pluginName) =>
          Effect.sync(() => {
            runtimeInstalls.push(pluginName);
            runtimeInstalled = true;
          }),
        remove: (pluginId) =>
          Effect.sync(() => {
            runtimeRemovals.push(pluginId);
            runtimeInstalled = false;
          }),
      } satisfies CodexPluginRuntime["Service"];
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.sync(() => {
            commands.push({ command: input.command, args: input.args });
            if (input.command === "codex" && input.args[1] === "list") {
              return processOutput(catalogJson);
            }
            if (input.args.includes("remove") && failLegacyRemoval) {
              return unavailableProcessOutput;
            }
            return processOutput("");
          }),
      });
      const makeMarketplace = () =>
        makeWithOptions({
          codexPluginRuntime: runtime,
          readCursorMarketplaceHtml: () =>
            new PluginMarketplaceUnavailableError({
              reason: "marketplaces_unavailable",
              cause: new Error("Marketplace unavailable in test."),
            }),
        }).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, runner),
          Effect.provideService(HttpClient.HttpClient, unusedHttpClient),
        );

      const marketplace = yield* makeMarketplace();
      const publicId = `codex:${record.pluginId}`;
      assert.strictEqual((yield* marketplace.detail(publicId)).installed, false);
      assert.deepStrictEqual(yield* marketplace.install(publicId), {
        pluginId: publicId,
        installed: true,
      });
      assert.deepStrictEqual(runtimeInstalls, ["hyperframes"]);
      expect(commands).not.toContainEqual({
        command: "codex",
        args: ["plugin", "add", record.pluginId, "--json"],
      });
      expect(commands).toContainEqual({
        command: "codex",
        args: ["plugin", "remove", record.pluginId, "--json"],
      });

      const installedMarketplace = yield* makeMarketplace();
      assert.strictEqual((yield* installedMarketplace.detail(publicId)).installed, true);
      failLegacyRemoval = true;
      const removalError = yield* installedMarketplace.remove(publicId).pipe(Effect.flip);
      assert.strictEqual(removalError._tag, "PluginMarketplaceOperationError");
      assert.deepStrictEqual(runtimeRemovals, ["hyperframes@openai-curated-remote"]);
      assert.strictEqual((yield* installedMarketplace.detail(publicId)).installed, false);
    }),
  );

  it.effect("installs Claude marketplace packages through the Claude Code CLI", () =>
    Effect.gen(function* () {
      const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> =
        [];
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const claudeCatalog = JSON.stringify({
        installed: [],
        available: [
          {
            pluginId: "agent-sdk-dev@claude-plugins-official",
            name: "agent-sdk-dev",
            description: "Claude Agent SDK development tools",
            marketplaceName: "claude-plugins-official",
            source: { source: "git-subdir", url: "https://example.com/plugins.git" },
          },
        ],
      });
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.sync(() => {
            commands.push({ command: input.command, args: input.args });
            if (input.command === "codex") return unavailableProcessOutput;
            if (input.args[1] === "list") return processOutput(claudeCatalog);
            if (input.args[1] === "marketplace") return processOutput("[]");
            return processOutput("");
          }),
      });
      const marketplace = yield* makeTestMarketplace.pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
      );
      const publicId = "claude:agent-sdk-dev@claude-plugins-official";

      const result = yield* marketplace.install(publicId);

      assert.deepStrictEqual(result, { pluginId: publicId, installed: true });
      expect(commands).toContainEqual({
        command: "claude",
        args: [
          "plugin",
          "install",
          "agent-sdk-dev@claude-plugins-official",
          "--scope",
          "user",
          "--yes",
        ],
      });
    }),
  );

  it.effect("opens the signed Computer Use app and macOS permission settings", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const codexHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-computer-use-home-" });
      const pluginRoot = path.join(
        codexHome,
        ".tmp",
        "bundled-marketplaces",
        "openai-bundled",
        "plugins",
        "computer-use",
      );
      const appPath = path.join(codexHome, "computer-use", "Codex Computer Use.app");
      yield* fs.makeDirectory(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
      yield* fs.makeDirectory(appPath, { recursive: true });
      yield* fs.writeFileString(
        path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          name: "computer-use",
          version: "1.0.1000633",
          description: "Control local Mac apps.",
          interface: { displayName: "Computer Use", category: "Productivity" },
        }),
      );

      const record = {
        pluginId: "computer-use@openai-bundled",
        name: "computer-use",
        marketplaceName: "openai-bundled",
        version: "1.0.1000633",
        installed: true,
        enabled: true,
        source: { source: "git", path: pluginRoot },
        installPolicy: "AVAILABLE",
        authPolicy: "ON_INSTALL",
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const codexCatalog = JSON.stringify({ installed: [record], available: [] });
      const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> =
        [];
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.sync(() => {
            commands.push({ command: input.command, args: input.args });
            return processOutput(input.command === "codex" ? codexCatalog : "[]");
          }),
      });
      const marketplace = yield* makeWithOptions({
        platform: "darwin",
        readCursorMarketplaceHtml: () =>
          new PluginMarketplaceUnavailableError({
            reason: "marketplaces_unavailable",
            cause: new Error("Marketplace unavailable in test."),
          }),
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.provideService(HttpClient.HttpClient, unusedHttpClient),
      );

      const pluginId = "codex:computer-use@openai-bundled";
      const detail = yield* marketplace.detail(pluginId);
      assert.deepStrictEqual(
        detail.installTargets.map((target) => target.harness),
        ["codex"],
      );
      assert.deepStrictEqual(
        detail.support.map((support) => support.harness),
        ["codex"],
      );
      assert.deepStrictEqual(yield* marketplace.setup(pluginId, "permissions"), {
        pluginId,
        action: "permissions",
        opened: true,
      });
      assert.deepStrictEqual(yield* marketplace.setup(pluginId, "automation"), {
        pluginId,
        action: "automation",
        opened: true,
      });
      expect(commands).toContainEqual({ command: "/usr/bin/open", args: [appPath] });
      expect(commands).toContainEqual({
        command: "/usr/bin/open",
        args: ["x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"],
      });
    }),
  );
});
