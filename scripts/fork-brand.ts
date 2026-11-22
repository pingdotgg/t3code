#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off -- A plain file rewriter run before fork builds.

/**
 * Applies the UP Orchestrator brand right before a fork build. Source keeps upstream's wording so
 * merges stay clean; internal identifiers (bundle id, schemes, data dirs) keep the upstream name.
 * `node scripts/fork-brand.ts` brands the tree; `--check` verifies every rule and writes nothing.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

export const UPSTREAM_NAME = "T3 Code";
export const BRAND_NAME = "UP Orchestrator";

/** Client UI: every upstream product-name string here is user-facing. */
const UI_ROOTS = ["apps/web/src", "apps/mobile/src"];
const UI_SKIP = /\.test\.|\/showcase\//;

/** Server, desktop and package files whose product-name strings are all user-facing. */
const BRANDED_FILES = [
  "apps/desktop/package.json",
  "apps/desktop/scripts/electron-launcher.mjs",
  "apps/desktop/src/app/DesktopApp.ts",
  "apps/desktop/src/app/DesktopAppActivation.ts",
  "apps/desktop/src/app/DesktopAppActivationBroker.ts",
  "apps/desktop/src/app/DesktopCliShim.ts",
  "apps/desktop/src/app/DesktopEnvironment.ts",
  "apps/desktop/src/backend/DesktopBackendPool.ts",
  "apps/desktop/src/backend/DesktopLocalEnvironmentAuth.ts",
  "apps/desktop/src/electron/WindowsForeground.ts",
  "apps/desktop/src/permissions/MacPermissionHelper.ts",
  "apps/desktop/src/preview/BrowserSession.ts",
  "apps/desktop/src/snapShot/DesktopSnapShot.ts",
  "apps/desktop/src/snapShot/GnomeCaptureSetup.ts",
  "apps/desktop/src/snapShot/HyprlandSnapShot.ts",
  "apps/desktop/src/snapShot/KdeSnapShot.ts",
  "apps/desktop/src/snapShot/LinuxSnapShot.ts",
  "apps/desktop/src/snapShot/MacModifierPairShortcutProcess.ts",
  "apps/desktop/src/snapShot/NiriCaptureShortcut.ts",
  "apps/desktop/src/snapShot/NiriSnapShot.ts",
  "apps/desktop/src/snapShot/PortalCaptureShortcut.ts",
  "apps/desktop/src/snapShot/SnapShotTransition.ts",
  "apps/desktop/src/snapShot/snapShot.ts",
  "apps/desktop/src/ssh/DesktopSshEnvironment.ts",
  "apps/desktop/src/ssh/DesktopSshPasswordPrompts.ts",
  "apps/desktop/src/window/DesktopApplicationMenu.ts",
  "apps/desktop/src/wsl/DesktopWslBackend.ts",
  "apps/desktop/src/wsl/DesktopWslEnvironment.ts",
  "apps/mobile/app.config.ts",
  "apps/server/src/auth/McpOAuth.ts",
  "apps/server/src/binCli.ts",
  "apps/server/src/cli/acpMcpBridge.ts",
  "apps/server/src/cli/app.ts",
  "apps/server/src/cli/config.ts",
  "apps/server/src/cli/connect.ts",
  "apps/server/src/cli/doctor.ts",
  "apps/server/src/cli/pair.ts",
  "apps/server/src/cli/server.ts",
  "apps/server/src/cli/service.ts",
  "apps/server/src/cli/theme.ts",
  "apps/server/src/cli/triage.ts",
  "apps/server/src/cli/uninstall.ts",
  "apps/server/src/cli/update.ts",
  "apps/server/src/cli/updateProgress.ts",
  "apps/server/src/cloud/bootService.ts",
  "apps/server/src/cloud/cliAuthHtml.ts",
  "apps/server/src/cloud/relayResponse.ts",
  "apps/server/src/cloud/selfUpdate.ts",
  "apps/server/src/cloud/servicePreflight.ts",
  "apps/server/src/desktopUpdate/DesktopAppUpdate.ts",
  "apps/server/src/orchestration-v2/RestartContinuation.ts",
  "apps/server/src/orchestration-v2/UserFacingErrors.ts",
  "apps/server/src/persistence/DatabaseMaintenance.ts",
  "apps/server/src/project/ManagedProjectFolders.ts",
  "apps/server/src/provider/AntigravityProvider.ts",
  "apps/server/src/provider/ClaudeProvider.ts",
  "apps/server/src/provider/CodexAuthCallbackPage.ts",
  "apps/server/src/provider/CodexInstallation.ts",
  "apps/server/src/provider/CodexProvider.ts",
  "apps/server/src/provider/ProviderAuthService.ts",
  "apps/server/src/provider/providerCompatibility.ts",
  "apps/server/src/provider/providerInstallation.ts",
  "apps/server/src/provider/providerMaintenanceRunner.ts",
  "apps/server/src/serverOwnership.ts",
  "apps/server/src/serverRuntimeStartup.ts",
  "apps/server/src/serviceLauncher.ts",
  "apps/server/src/startupAccess.ts",
  "apps/web/index.html",
  "apps/web/vite.config.ts",
  "apps/web/public/manifest.webmanifest",
  "packages/client-runtime/src/connection/compatibility.ts",
  "packages/client-runtime/src/connection/outdatedHostUpdate.ts",
  "packages/client-runtime/src/relay/errorPresentation.ts",
  "packages/client-runtime/src/state/pullRequestDiffHttp.ts",
  "packages/contracts/src/browserImport.ts",
  "packages/contracts/src/pullRequest.ts",
  "packages/contracts/src/t3ProjectFile.ts",
  "packages/provider-acp-registry/src/server/driver.ts",
  "packages/provider-acp/src/server/mcpOverAcpBridge.ts",
  "packages/provider-core/src/server/maintenanceResolver.ts",
  "packages/provider-cursor/src/server/accountUsage.ts",
  "packages/provider-cursor/src/server/status.ts",
  "packages/provider-cursor/src/server/textGeneration.ts",
  "packages/provider-cursor/src/server/usageLimits.ts",
  "packages/provider-grok/src/server/status.ts",
  "packages/provider-muse/src/server/adapter.ts",
  "packages/provider-muse/src/server/status.ts",
  "packages/provider-muse/src/server/textGeneration.ts",
  "packages/provider-opencode/src/server/OpenCodeRuntime.ts",
  "packages/provider-opencode/src/server/status.ts",
  "packages/provider-opencode/src/server/v2/adapter.ts",
  "packages/provider-opencode/src/server/versionProbe.ts",
  "packages/provider-opencode/src/settings.ts",
  "packages/provider-pi/src/server/mcpExtensionSource.ts",
  "packages/provider-pi/src/server/mcpInjection.ts",
  "packages/provider-pi/src/server/status.ts",
  "packages/shared/src/codexAuthCallback.ts",
  "packages/shared/src/codexAuthHandoff.ts",
  "packages/shared/src/otelEnvironment.ts",
  "packages/shared/src/promptLinks.ts",
  "packages/shared/src/relayClient.ts",
  "packages/source-control-gitcafe/src/server/GitCafePullRequestProvider.ts",
  "scripts/build-desktop-artifact.ts",
];

/** Upstream-name strings inside branded files that identify things rather than name the product. */
export const PROTECTED = [
  // Codex sees this as the client name; changing it changes Codex-side behavior.
  'CODEX_CLIENT_NAME = "T3 Code"',
  // Existing CLI shims are recognised by this marker.
  "Written by T3 Code:",
  // Installed systemd units carry this description.
  "Description=T3 Code server",
  // Refers to real upstream releases.
  "a T3 Code version before",
];

interface Edit {
  readonly file: string;
  readonly find: RegExp | string;
  readonly replace: string;
}

/** Edits beyond the name swap. Each must match, so upstream drift fails loudly. */
const EDITS: ReadonlyArray<Edit> = [
  // The wordmark renders "UP"; the caption beside it reads "Orchestrator" instead of "Code".
  {
    file: "apps/web/src/components/sidebar/SidebarChrome.tsx",
    find: '{"Code"}',
    replace: '{"Orchestrator"}',
  },
  {
    file: "apps/web/src/components/sidebar/SidebarChrome.tsx",
    find: 'aria-label="T3"',
    replace: 'aria-label="UP"',
  },
  {
    file: "apps/mobile/src/components/CompactBrandTitle.tsx",
    find: 'const WORDMARK_SUFFIX = "Code";',
    replace: 'const WORDMARK_SUFFIX = "Orchestrator";',
  },
  // New projects get a README credit; t3.codes is not this product's site.
  {
    file: "apps/server/src/project/ManagedProjectFolders.ts",
    find: `[${BRAND_NAME}](https://t3.codes)`,
    replace: BRAND_NAME,
  },
  {
    file: "scripts/build-desktop-artifact.ts",
    find: 'artifactName: "T3-Code-${version}-${arch}.${ext}"',
    replace: 'artifactName: "UP-Orchestrator-${version}-${arch}.${ext}"',
  },
  // Stable fork builds are just the product name; Dev and Nightly keep their stage.
  // Squirrel.Mac swaps the bundle in place, so the installed .app path survives the rename.
  {
    file: "apps/desktop/package.json",
    find: `"productName": "${BRAND_NAME} (Beta)"`,
    replace: `"productName": "${BRAND_NAME}"`,
  },
  {
    file: "apps/desktop/scripts/electron-launcher.mjs",
    find: `: "${BRAND_NAME} (Beta)";`,
    replace: `: "${BRAND_NAME}";`,
  },
  {
    file: "apps/desktop/src/app/DesktopEnvironment.ts",
    find: "displayName: `${APP_BASE_NAME} (${stageLabel})`,",
    replace:
      'displayName: stageLabel === "Beta" ? APP_BASE_NAME : `${APP_BASE_NAME} (${stageLabel})`,',
  },
  {
    file: "apps/desktop/src/app/DesktopAppIdentity.ts",
    find: "`${environment.branding.baseName} ${environment.branding.stageLabel}`,",
    replace:
      'environment.branding.stageLabel === "Beta" ? environment.branding.baseName : `${environment.branding.baseName} ${environment.branding.stageLabel}`,',
  },
  // formatAppDisplayName drops the suffix for "Latest", the hosted stable channel's label.
  // vite.config.ts stamps index.html's title through the same function.
  {
    file: "apps/web/src/branding.logic.ts",
    find: '(input.development ? "Dev" : "Beta")',
    replace: '(input.development ? "Dev" : "Latest")',
  },
  {
    file: "apps/mobile/src/components/BrandMark.tsx",
    find: '<View className="rounded-full bg-subtle px-2 py-1">',
    replace: '{stageLabel !== "Beta" ? (<View className="rounded-full bg-subtle px-2 py-1">',
  },
  {
    file: "apps/mobile/src/components/BrandMark.tsx",
    find: /(\{stageLabel\}\s*<\/Text>\s*<\/View>)/,
    replace: "$1) : null}",
  },
  {
    file: "apps/mobile/src/components/CompactBrandTitle.tsx",
    find: "{showStage ? (",
    replace: '{showStage && stageLabel !== "Beta" ? (',
  },
  // Spotlight indexes kMDItemAlternateNames, so searching the old name still finds the app.
  {
    file: "scripts/build-desktop-artifact.ts",
    find: "NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac: true,",
    replace: `NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac: true,\n        CFBundleAlternateNames: ["${UPSTREAM_NAME}"],`,
  },
];

const WEB_WORDMARK = `import type { SVGProps } from "react";

export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 34 17.3" xmlns="http://www.w3.org/2000/svg">
      <text
        x="0"
        y="17.3"
        fontSize="24"
        fontWeight="700"
        textLength="34"
        lengthAdjust="spacingAndGlyphs"
        fill="currentColor"
      >
        UP
      </text>
    </svg>
  );
}
`;

const MOBILE_WORDMARK = `import type { ColorValue } from "react-native";
import Svg, { Text } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedText = withUniwind(Text);

export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg accessibilityLabel="UP" height={props.height} width={props.height * (34 / 17.3)} viewBox="0 0 34 17.3">
      <ThemedText
        x="0"
        y="17.3"
        fontSize="24"
        fontWeight="700"
        textLength="34"
        lengthAdjust="spacingAndGlyphs"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      >
        UP
      </ThemedText>
    </Svg>
  );
}
`;

/** Whole-file replacements for the vector wordmark, which has no text to rename. */
const OVERLAYS: Readonly<Record<string, string>> = {
  "apps/web/src/components/T3Wordmark.tsx": WEB_WORDMARK,
  "apps/mobile/src/components/T3Wordmark.tsx": MOBILE_WORDMARK,
};

/** Swaps the product name while leaving protected identifiers untouched. */
export function renameProduct(source: string): string {
  const placeholders = PROTECTED.map((text, index) => [text, `\u0000fork-brand-${index}\u0000`]);
  let result = source;
  for (const [text, placeholder] of placeholders) result = result.replaceAll(text!, placeholder!);
  result = result.replaceAll(UPSTREAM_NAME, BRAND_NAME);
  for (const [text, placeholder] of placeholders) result = result.replaceAll(placeholder!, text!);
  return result;
}

function listUiFiles(root: string): string[] {
  const files: string[] = [];
  for (const uiRoot of UI_ROOTS) {
    for (const entry of NodeFS.readdirSync(NodePath.join(root, uiRoot), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
      const relative = NodePath.relative(root, NodePath.join(entry.parentPath, entry.name));
      if (!UI_SKIP.test(relative.split(NodePath.sep).join("/"))) files.push(relative);
    }
  }
  return files;
}

export interface BrandResult {
  /** Original contents of every file that changed, keyed by repo-relative path. */
  readonly originals: ReadonlyMap<string, string>;
  readonly branded: ReadonlyMap<string, string>;
}

/** Computes the branded tree without writing. Throws when a rule no longer matches upstream. */
export function planForkBranding(root: string = repoRoot): BrandResult {
  const problems: string[] = [];
  const read = (file: string): string | undefined => {
    const path = NodePath.join(root, file);
    return NodeFS.existsSync(path) ? NodeFS.readFileSync(path, "utf8") : undefined;
  };
  const originals = new Map<string, string>();
  const branded = new Map<string, string>();
  const current = (file: string) => branded.get(file) ?? read(file);
  const write = (file: string, original: string, next: string) => {
    if (next === original && !branded.has(file)) return;
    if (!originals.has(file)) originals.set(file, original);
    branded.set(file, next);
  };

  for (const file of new Set([...listUiFiles(root), ...BRANDED_FILES])) {
    const source = read(file);
    if (source === undefined) {
      problems.push(`Missing branded file ${file}. Update BRANDED_FILES.`);
      continue;
    }
    write(file, source, renameProduct(source));
  }

  for (const edit of EDITS) {
    const source = current(edit.file);
    const original = originals.get(edit.file) ?? read(edit.file);
    if (source === undefined || original === undefined) {
      problems.push(`Missing ${edit.file} for an edit. Update EDITS.`);
      continue;
    }
    const matches =
      typeof edit.find === "string" ? source.includes(edit.find) : edit.find.test(source);
    if (!matches) {
      problems.push(`No match for ${String(edit.find)} in ${edit.file}. Update EDITS.`);
      continue;
    }
    write(edit.file, original, source.replace(edit.find, edit.replace));
  }

  for (const [file, content] of Object.entries(OVERLAYS)) {
    const original = read(file);
    if (original === undefined) {
      problems.push(`Missing ${file} for the wordmark overlay. Update OVERLAYS.`);
      continue;
    }
    write(file, originals.get(file) ?? original, content);
  }

  if (problems.length > 0)
    throw new Error(`Fork branding is out of date:\n  ${problems.join("\n  ")}`);
  return { originals, branded };
}

/** Writes the brand into the working tree and returns a function that puts the originals back. */
export function applyForkBranding(root: string = repoRoot): () => void {
  const { originals, branded } = planForkBranding(root);
  for (const [file, content] of branded) NodeFS.writeFileSync(NodePath.join(root, file), content);
  return () => {
    for (const [file, content] of originals)
      NodeFS.writeFileSync(NodePath.join(root, file), content);
  };
}

if (import.meta.main) {
  try {
    if (process.argv.includes("--check")) {
      const { branded } = planForkBranding();
      process.stdout.write(`Fork branding applies cleanly to ${branded.size} files.\n`);
    } else {
      applyForkBranding();
      process.stdout.write(`Applied ${BRAND_NAME} branding.\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
