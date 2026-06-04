import * as PrPackage from "@alchemy.run/pr-package";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";

export const ALCHEMY_HOSTS = [
  "pkg.alchemy.run",
  "xn--cu8h.alchemy.run", // 📦.alchemy.run
];

export const DISTILLED_HOSTS = [
  "pkg.distilled.cloud",
  "xn--cu8h.distilled.cloud", // 📦.distilled.cloud
];

const parseAliasUrl: PrPackage.ParseAliasUrl = (url) => {
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });

  if (url.hostname === "pkg.ing" || ALCHEMY_HOSTS.includes(url.hostname)) {
    if (segments.length === 2) {
      return { pkgName: segments[0]!, tag: segments[1]! };
    }
    if (segments.length === 3 && segments[0]!.startsWith("@")) {
      return { pkgName: `${segments[0]!}/${segments[1]!}`, tag: segments[2]! };
    }
  } else if (DISTILLED_HOSTS.includes(url.hostname)) {
    if (segments.length === 2) {
      return { pkgName: `@distilled.cloud/${segments[0]!}`, tag: segments[1]! };
    }
  }
  return null;
};

export default class Api extends Cloudflare.Worker<Api>()(
  "PrPackageWorker",
  Stack.useSync(({ stage }) => ({
    main: import.meta.filename,
    url: true,
    domain:
      stage === "prod"
        ? ["pkg.ing", ...ALCHEMY_HOSTS, ...DISTILLED_HOSTS]
        : undefined,
    compatibility: {
      flags: ["nodejs_compat"],
      date: "2026-03-17",
    },
  })),
  PrPackage.handler({ parseAliasUrl }),
) {}
