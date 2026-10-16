import { CuaApplication } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const PREFIX = "t3-app://v1?";
const isApplication = Schema.is(CuaApplication);
const LINKS = /\[([^\]\n]{1,200})\]\((t3-app:\/\/v1\?[^\s)]{1,8192})\)/gu;

export function formatNativeAppMention(app: CuaApplication, environmentId: string): string {
  const params = new URLSearchParams({ name: app.name, environment: environmentId });
  if (app.bundleId) params.set("bundleId", app.bundleId);
  if (app.launchPath) params.set("launchPath", app.launchPath);
  const label = app.name.replace(/[[\]\\\r\n]/gu, " ");
  return `[${label}](${PREFIX}${params})`;
}

export function parseNativeAppMention(href: string) {
  if (!href.startsWith(PREFIX) || href.length > 8192) return null;
  const params = new URLSearchParams(href.slice(PREFIX.length));
  const app = {
    name: params.get("name"),
    ...(params.has("bundleId") ? { bundleId: params.get("bundleId") } : {}),
    ...(params.has("launchPath") ? { launchPath: params.get("launchPath") } : {}),
  };
  const environmentId = params.get("environment");
  return isApplication(app) && environmentId && environmentId.length <= 200
    ? { app, environmentId }
    : null;
}

export function collectNativeAppMentions(text: string) {
  return Array.from(text.matchAll(LINKS)).flatMap((match) => {
    const parsed = parseNativeAppMention(match[2]!);
    return parsed
      ? [
          {
            ...parsed,
            source: match[0],
            href: match[2]!,
            start: match.index,
            end: match.index + match[0].length,
          },
        ]
      : [];
  });
}

export function projectNativeAppMentions(text: string): string {
  const mentions = collectNativeAppMentions(text);
  if (!mentions.length) return text;
  let result = text;
  for (let index = mentions.length - 1; index >= 0; index--) {
    const mention = mentions[index]!;
    const fields = [
      `Application: ${mention.app.name}`,
      `environment: ${mention.environmentId}`,
      ...(mention.app.bundleId ? [`bundle_id: ${mention.app.bundleId}`] : []),
      ...(mention.app.launchPath ? [`launch_path: ${mention.app.launchPath}`] : []),
      "Use the computer-use tools on this environment; resolve the app's current window before interacting.",
    ];
    result = result.slice(0, mention.start) + fields.join("\n") + result.slice(mention.end);
  }
  return result;
}
