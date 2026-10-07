import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { AlchemyContext } from "../../AlchemyContext.ts";
import type { MemoOptions } from "../../Command/Memo.ts";
import * as Output from "../../Output.ts";
import { ProviderModePolicy } from "../../ProviderMode.ts";
import type { WebsiteAssetsProps } from "../../Website/assets.ts";
import { Server, type ServerDevProps } from "../../Website/Server.ts";
import type { Branch } from "../Branch.ts";
import type { BranchScope } from "../BranchScope.ts";
import { CustomDomain } from "../CustomDomain.ts";
import { Function, type FunctionCommonProps } from "../Function.ts";
import { Project } from "../Project.ts";
import type { Providers } from "../Providers.ts";
import { WebsiteArtifact } from "./Artifact.ts";

/** Deployment controls; the composition owns code, environment, and runtime wiring. */
export type WebsiteFunctionOptions = Pick<FunctionCommonProps, "slug" | "name">;

/** Shared framework configuration, independent of backend scope. */
export interface FrameworkSiteOptions {
  /** Application directory containing package.json and framework configuration. @default "." */
  rootDir?: string;
  /** Build input hashing. Set false to rebuild every deployment. @default true */
  memo?: MemoOptions | boolean;
  /** Build, development, and runtime values. Public framework prefixes are browser-visible; Redacted does not prevent build tools from embedding a value. */
  env?: Record<
    string,
    string | Redacted.Redacted<string> | Output.Output<string | undefined>
  >;
  /** Static-file routing within the Function, not a separate CDN. */
  assets?: WebsiteAssetsProps;
  /** Native framework dev server, including external-server mode. */
  dev?: ServerDevProps;
  /** Custom hostname. Publish domain.cnameTarget as a DNS-only CNAME and verify HTTPS separately. */
  domain?: string;
  /** Supported Function controls; memory, listening ports, and Docker options are not available. */
  function?: WebsiteFunctionOptions;
}

/** Scope references are forwarded to the composed resources without resolution. */
export type WebsiteScope =
  | { branch: Branch | NonNullable<BranchScope["branch"]>; project?: never }
  | { project: Project | NonNullable<BranchScope["project"]>; branch?: never }
  | { project?: never; branch?: never };

/** Explicit branch or project, or an Ohio project owned only on live deployments. */
export type FrameworkSiteProps = FrameworkSiteOptions & WebsiteScope;

/** Outputs of a Neon framework or static website. */
export interface Website {
  /** Native dev URL locally, otherwise the Function or configured custom-domain URL. */
  url: string | Output.Output<string | undefined> | undefined;
  /** Function serving the artifact; absent during native development. */
  function: Function | undefined;
  /** Explicit or owned project reference; explicit references are preserved locally. */
  project: WebsiteScope["project"];
  /** Explicit branch reference, preserved locally without transferring ownership. */
  branch: WebsiteScope["branch"];
  /** Custom-domain registration and DNS target; absent during native development. */
  domain: CustomDomain | undefined;
}

/** Internal framework-to-Fetch target wiring. */
export interface FrameworkSiteConfig {
  /** Framework integration module. */
  framework: string;
  /** Neon Fetch deploy-target module. */
  target: string;
  /** Serializable native framework overrides. */
  options?: Record<string, unknown>;
  /** Next.js keeps output and configuration beside its entrypoint. */
  layout?: "output" | "next";
  /** Default unmatched-path behavior. */
  notFoundHandling?: "none" | "spa" | "404-page";
  /** Default extensionless HTML behavior. */
  htmlHandling?: "none" | "drop-trailing-slash";
}

/** Unwrap build values without changing the runtime's redacted props. */
export const websiteBuildEnv = (env: FrameworkSiteProps["env"]) =>
  env === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(env).map(([key, value]) => [
          key,
          Redacted.isRedacted(value) ? Redacted.value(value) : value,
        ]),
      );

/** Live composition; explicit projects and branches remain independently owned. */
export const deployWebsite = Effect.fn(function* (
  props: Omit<FrameworkSiteOptions, "dev"> & WebsiteScope,
  artifact: WebsiteArtifact,
): Effect.fn.Return<Website, never, Providers> {
  const project = props.branch
    ? undefined
    : (props.project ??
      (yield* Project("Project", {
        // Validate the artifact before provisioning an implicit backend.
        region: Output.map(artifact.hash, () => "aws-us-east-2" as const),
      })));
  const scope =
    props.branch !== undefined
      ? { branch: props.branch }
      : { project: project! };
  const fn = yield* Function("Function", {
    ...props.function,
    ...scope,
    artifact: { zip: artifact.artifactPath },
    env: { ...props.env, NODE_ENV: "production" },
  });
  const domain = props.domain
    ? yield* CustomDomain("Domain", { function: fn, hostname: props.domain })
    : undefined;
  return {
    url: domain ? domain.url : fn.url,
    function: fn,
    project,
    branch: props.branch,
    domain,
  };
});

/** Compose native development or a production Fetch build with a traced artifact. */
export const makeFrameworkSite = Effect.fn(function* (
  _id: string,
  props: FrameworkSiteProps,
  config: FrameworkSiteConfig,
) {
  const context = yield* AlchemyContext;
  const remote = yield* ProviderModePolicy;
  if (props.project !== undefined && props.branch !== undefined) {
    return yield* Effect.die(
      new Error("Specify branch or project, never both."),
    );
  }
  const handling = props.assets?.notFoundHandling;
  const targetConfig = {
    notFoundHandling:
      handling === "single-page-application"
        ? "spa"
        : (handling ?? config.notFoundHandling),
    htmlHandling: props.assets?.htmlHandling ?? config.htmlHandling,
  };
  const build = yield* Server("Build", {
    framework: config.framework,
    target: config.target,
    root: props.rootDir,
    env: websiteBuildEnv(props.env),
    options: { ...config.options, ...targetConfig, targetConfig },
    memo: props.memo,
    dev: props.dev,
  });
  if (context.dev && remote !== true) {
    return {
      url: build.url,
      function: undefined,
      project: props.project,
      branch: props.branch,
      domain: undefined,
    } satisfies Website;
  }
  const requiredPath = (value: string | undefined) =>
    value === undefined
      ? Effect.die(
          new Error(
            `The ${config.framework} build produced no Neon Fetch output.`,
          ),
        )
      : Effect.succeed(value);
  const artifact = yield* WebsiteArtifact("Artifact", {
    root: props.rootDir ?? ".",
    distDir: Output.mapEffect(requiredPath)(build.distDir),
    serverEntry: Output.mapEffect(requiredPath)(build.serverEntry),
    layout: config.layout,
    buildHash: build.hash.output,
  });
  return yield* deployWebsite(props, artifact);
});
