import type {
  DurableObjectNamespace,
  HyperdriveOrigin,
  QueueConsumer,
  RuntimeWorker,
  Workflow,
} from "@alchemy.run/cloudflare-runtime/core";
import type { BundleOutput } from "../../Bundle/Bundle.ts";
import type { WorkerBinding } from "./WorkerBinding.ts";
import type { WorkerAssetsConfig, WorkerSourceDescriptor } from "./Worker.ts";

/**
 * Default first port of the local dev-server range. Vite and
 * cloudflare-runtime advance to the next available port when it is taken,
 * unless `strictPort` is set.
 */
export const DEFAULT_DEV_PORT = 1337;

/** Plain-data configuration transferred from the provider to a Vite child. */
export interface ViteChildConfig {
  rootDir: string;
  publicUrl: string;
  accountId: string;
  storageDirectory: string;
  stack: { name: string; stage: string };
  env: Record<string, unknown>;
  source?: {
    descriptor: WorkerSourceDescriptor;
    id: string;
    assets: WorkerAssetsConfig | undefined;
  };
  worker: {
    name: string;
    compatibility: { date: string; flags: string[] };
    main: string | undefined;
    viteEnvironments: { entry?: string; children?: string[] } | undefined;
    hasAssets: boolean;
    bindingDescriptors: WorkerBinding[];
    /** Binding name → opt-out of local emulation (`Alchemy.remote()`). */
    devRemote: Record<string, boolean>;
    /** Simulated Cloudflare Access config (`dev: { access: ... }`). */
    devAccess?: { aud?: string; identity?: Record<string, unknown> };
    durableObjectNamespaces: (DurableObjectNamespace & {
      uniqueKey: string;
    })[];
    workflows: Workflow[];
    hyperdrives: Record<string, Required<HyperdriveOrigin>>;
    queueConsumers: QueueConsumer[];
    assets: RuntimeWorker["assets"];
  };
}

export const VITE_CHILD_READY_PREFIX = "<ALCHEMY_VITE_ADDRESS>";
export const VITE_CHILD_READY_SUFFIX = "</ALCHEMY_VITE_ADDRESS>";

/**
 * Plain-data configuration transferred from the provider to a one-shot
 * Vite *build* child (`ViteBuildChildRunner.ts`). Deliberately much
 * smaller than {@link ViteChildConfig}: a production build needs no
 * workerd runtime, credentials, or binding materialization.
 */
export interface ViteBuildChildConfig {
  /** Absolute project root; also the child process's working directory. */
  rootDir: string;
  /**
   * `VITE_`-prefixed env entries — the only ones the build consumes
   * (inlined as `import.meta.env.*` defines).
   */
  env: Record<string, unknown>;
  main: string | undefined;
  compatibilityDate: string | undefined;
  compatibilityFlags: string[] | undefined;
  viteEnvironments: { entry?: string; children?: string[] } | undefined;
  /** Absolute path the child writes the V8-serialized result to. */
  outputPath: string;
}

/** Result the build child writes to `outputPath` (V8-serialized). */
export interface ViteBuildChildResult {
  clientDirectory: string | undefined;
  base: string | undefined;
  serverBundle: BundleOutput | undefined;
  externalWorkspaces: string[];
}
