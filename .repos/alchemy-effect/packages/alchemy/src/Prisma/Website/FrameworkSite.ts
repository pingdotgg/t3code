import * as Effect from "effect/Effect";
import * as Output from "../../Output.ts";
import * as Redacted from "effect/Redacted";
import { AlchemyContext } from "../../AlchemyContext.ts";
import type { MemoOptions } from "../../Command/Memo.ts";
import { ProviderModePolicy } from "../../ProviderMode.ts";
import type { WebsiteAssetsProps } from "../../Website/assets.ts";
import { Server, type ServerDevProps } from "../../Website/Server.ts";
import { Compute, type ComputeProps } from "../Compute.ts";
import { CustomDomain } from "../CustomDomain.ts";
import { Project } from "../Project.ts";
import type { Providers } from "../Providers.ts";
import type { PrismaRegionId } from "../Types.ts";
import { WebsiteArtifact } from "./Artifact.ts";

/** A Prisma Project resource, ID, or lightweight ID reference. */
export type WebsiteProjectReference =
  | Project
  | string
  | {
      /** Existing Prisma project ID; no project is created or owned by the site. */
      readonly projectId: string | Output.Output<string>;
    };

/** Deployment controls that do not replace the framework build or artifact. */
export type WebsiteComputeOptions = Pick<
  ComputeProps,
  | "appName"
  | "port"
  | "envClass"
  | "start"
  | "skipPromote"
  | "destroyOldDeployment"
  | "timeoutSeconds"
  | "pollIntervalMs"
  | "verifyUrl"
  | "healthCheck"
  | "urlReadinessTimeoutSeconds"
>;

/** Shared contract for Prisma's framework website composites. */
export interface FrameworkSiteProps {
  /** Existing Project or ID reference, optionally produced by an Effect. Omission creates a project without a database, only on live deployments. */
  project?:
    | WebsiteProjectReference
    | Effect.Effect<WebsiteProjectReference, never, Providers>;
  /** Application directory containing package.json and framework configuration. @default "." */
  rootDir?: string;
  /** Build input hashing options. Set false to rebuild on every deployment. @default true */
  memo?: MemoOptions | boolean;
  /** Build, development, and runtime environment. Wrap secrets in Redacted; public framework variables can be compiled into browser assets. */
  env?: Record<
    string,
    string | Redacted.Redacted<string> | Output.Output<string | undefined>
  >;
  /** Origin static-file routing, using the same vocabulary as Fly and Railway websites. */
  assets?: WebsiteAssetsProps;
  /** Native framework development server options, including external-server mode. */
  dev?: ServerDevProps;
  /** Custom hostname attached using Prisma.CustomDomain. Only apps on the default branch support custom domains; configure the returned DNS records before routing traffic. */
  domain?: string;
  /** Compute region. Defaults to the project's default region, then us-east-1. */
  regionId?: PrismaRegionId;
  /** Existing branch ID. Mutually exclusive with branchGitName. */
  branchId?: string;
  /** Existing branch git name. Defaults to the project's default branch. */
  branchGitName?: string;
  /** Compute deployment, readiness, and rollout options. The website owns its build, artifact, and runtime environment. */
  compute?: WebsiteComputeOptions;
  /** Accepted for website API parity; Prisma Compute does not persist resource tags. */
  tags?: Record<string, string>;
}

/** Outputs of a Prisma framework or static website. */
export interface Website {
  /** Native dev-server URL locally; Compute URL or configured custom-domain URL on live deployments. */
  url: string | Output.Output<string | undefined> | undefined;
  /** Compute app serving the artifact. Undefined during native development. */
  compute: Compute | undefined;
  /** Project resource or existing project reference. Undefined during native development. */
  project: WebsiteProjectReference | undefined;
  /** Custom-domain resource, including DNS records and certificate status. Undefined without domain or during native development. */
  domain: CustomDomain | undefined;
}

/** Internal framework-to-Node-target wiring. */
export interface FrameworkSiteConfig {
  /** Framework integration module. */
  framework: string;
  /** Existing Node deploy-target module. */
  target: string;
  /** Serializable framework-specific overrides. */
  options?: Record<string, unknown>;
  /** Artifact layout; Next.js serves from the application root. */
  layout?: "output" | "next";
  /** Default not-found behavior, overridden by assets.notFoundHandling. */
  notFoundHandling?: "none" | "spa" | "404-page";
  /** Default extensionless HTML behavior, overridden by assets.htmlHandling. */
  htmlHandling?: "none" | "drop-trailing-slash";
}

/** Resolve build-time secrets without changing the redacted runtime env props. */
export const websiteBuildEnv = (env: FrameworkSiteProps["env"]) =>
  env === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(env).map(([key, value]) => [
          key,
          Redacted.isRedacted(value) ? Redacted.value(value) : value,
        ]),
      );

/** Shared live half, called only after a build resource has been declared. */
export const deployWebsite = Effect.fn(function* (
  props: Omit<FrameworkSiteProps, "dev">,
  artifact: WebsiteArtifact,
): Effect.fn.Return<Website, never, Providers> {
  const project = Effect.isEffect(props.project)
    ? yield* props.project
    : (props.project ??
      (yield* Project("Project", {
        createDatabase: false,
        region: props.regionId,
      })));
  const port = props.compute?.port ?? 3000;
  const compute = yield* Compute("Compute", {
    ...props.compute,
    project: typeof project === "string" ? project : project.projectId,
    artifactPath: artifact.artifactPath,
    isExternal: true,
    port,
    regionId: props.regionId,
    branchId: props.branchId,
    branchGitName: props.branchGitName,
    env: {
      ...props.env,
      PORT: String(port),
      HOST: "0.0.0.0",
      NODE_ENV: "production",
    },
  });
  const domain = props.domain
    ? yield* CustomDomain("Domain", { app: compute, hostname: props.domain })
    : undefined;
  return {
    url: domain
      ? Output.map(domain.hostname, (hostname) => `https://${hostname}`)
      : compute.url,
    compute,
    project,
    domain,
  };
});

/** Compose a real framework build/dev server with a traced Prisma artifact. */
export const makeFrameworkSite = Effect.fn(function* (
  _id: string,
  props: FrameworkSiteProps,
  config: FrameworkSiteConfig,
) {
  const context = yield* AlchemyContext;
  const remote = yield* ProviderModePolicy;
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
      compute: undefined,
      project: undefined,
      domain: undefined,
    } satisfies Website;
  }
  const requiredPath = (value: string | undefined) =>
    value === undefined
      ? Effect.die(
          new Error(
            `The ${config.framework} Node build produced no deployable server output.`,
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
