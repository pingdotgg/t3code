import type {
  HttpOptions_Style,
  TlsOptions_Version,
  Worker_Binding_CryptoKey_Usage,
} from "./internal/config.capnp.ts";

// TODO: auto-generate this file

export {
  HttpOptions_Style,
  TlsOptions_Version,
  Worker_Binding_CryptoKey_Usage,
} from "./internal/config.capnp.ts";

export const kVoid = Symbol("kVoid");
export type Void = typeof kVoid;

export interface Config {
  services?: Array<Service>;
  sockets?: Array<Socket>;
  v8Flags?: Array<string>;
  extensions?: Array<Extension>;
  autogates?: Array<string>;
  structuredLogging?: boolean;
  logging?: LoggingOptions;
}

export interface LoggingOptions {
  structuredLogging?: boolean;
  stdoutPrefix?: string;
  stderrPrefix?: string;
}

export type Socket = {
  name?: string;
  address?: string;
  service?: ServiceDesignator;
} & ({ http?: HttpOptions } | { https?: Socket_Https } | { tcp?: Socket_Tcp });

export interface Socket_Https {
  options?: HttpOptions;
  tlsOptions?: TlsOptions;
}

export interface Socket_Tcp {
  tlsOptions?: TlsOptions;
}

export type Service = {
  name?: string;
} & (
  | { worker?: Worker }
  | { network?: Network }
  | { external?: ExternalServer }
  | { disk?: DiskDirectory }
);

export interface ServiceDesignator {
  name?: string;
  entrypoint?: string;
  props?: { json: string };
}

export type Worker_DockerConfiguration = {
  socketPath: string;
  /**
   * Image used for the egress interceptor sidecar that routes outbound HTTP
   * from containers back through workerd (e.g. for `interceptOutboundHttp`).
   */
  containerEgressInterceptorImage?: string;
};

export type Worker_ContainerEngine = {
  localDocker: Worker_DockerConfiguration;
};

export type Worker = (
  | { modules?: Array<Worker_Module> }
  | { serviceWorkerScript?: string }
  | { inherit?: string }
) & {
  compatibilityDate?: string;
  compatibilityFlags?: Array<string>;
  bindings?: Array<Worker_Binding>;
  globalOutbound?: ServiceDesignator;
  cacheApiOutbound?: ServiceDesignator;
  durableObjectNamespaces?: Array<Worker_DurableObjectNamespace>;
  durableObjectUniqueKeyModifier?: string;
  durableObjectStorage?: Worker_DurableObjectStorage;
  moduleFallback?: string;
  tails?: Array<ServiceDesignator>;
  streamingTails?: Array<ServiceDesignator>;
  containerEngine?: Worker_ContainerEngine;
};

export type Worker_DurableObjectStorage =
  | { none?: Void }
  | { inMemory?: Void }
  | { localDisk?: string };

export type Worker_Module = {
  name: string;
} & (
  | { esModule?: string }
  | { commonJsModule?: string }
  | { text?: string }
  | { data?: Uint8Array }
  | { wasm?: Uint8Array }
  | { json?: string }
  | { pythonModule?: string }
  | { pythonRequirement?: string }
);

export type Worker_Binding = {
  name?: string;
} & (
  | { parameter?: Worker_Binding_Parameter }
  | { text?: string }
  | { data?: Uint8Array }
  | { json?: string }
  | { wasmModule?: Uint8Array }
  | { cryptoKey?: Worker_Binding_CryptoKey }
  | { service?: ServiceDesignator }
  | { durableObjectNamespace?: Worker_Binding_DurableObjectNamespaceDesignator }
  | { kvNamespace?: ServiceDesignator }
  | { r2Bucket?: ServiceDesignator }
  | { r2Admin?: ServiceDesignator }
  | { wrapped?: Worker_Binding_WrappedBinding }
  | { queue?: ServiceDesignator }
  | { fromEnvironment?: string }
  | { analyticsEngine?: ServiceDesignator }
  | { hyperdrive?: Worker_Binding_Hyperdrive }
  | { unsafeEval?: Void }
  | { memoryCache?: Worker_Binding_MemoryCache }
  | { durableObjectClass?: ServiceDesignator }
  | { workerLoader?: Worker_Binding_WorkerLoader }
  | { workerdDebugPort?: Void }
);

export interface Worker_Binding_Parameter {
  type?: Worker_Binding_Type;
  optional?: boolean;
}

export type Worker_Binding_Type =
  | { text?: Void }
  | { data?: Void }
  | { json?: Void }
  | { wasm?: Void }
  | { cryptoKey?: Array<Worker_Binding_CryptoKey_Usage> }
  | { service?: Void }
  | { durableObjectNamespace: Void }
  | { kvNamespace?: Void }
  | { r2Bucket?: Void }
  | { r2Admin?: Void }
  | { queue?: Void }
  | { analyticsEngine?: Void }
  | { hyperdrive?: Void }
  | { durableObjectClass?: Void }
  | { workerdDebugPort?: Void };

export type Worker_Binding_DurableObjectNamespaceDesignator = {
  className?: string;
  serviceName?: string;
};

export type Worker_Binding_CryptoKey = (
  | { raw?: Uint8Array }
  | { hex?: string }
  | { base64?: string }
  | { pkcs8?: string }
  | { spki?: string }
  | { jwk?: string }
) & {
  algorithm?: Worker_Binding_CryptoKey_Algorithm;
  extractable?: boolean;
  usages?: Array<Worker_Binding_CryptoKey_Usage>;
};

export interface Worker_Binding_WrappedBinding {
  moduleName?: string;
  entrypoint?: string;
  innerBindings?: Array<Worker_Binding>;
}

export type Worker_Binding_CryptoKey_Algorithm =
  | { name?: string }
  | { json?: string };

export interface Worker_Binding_Hyperdrive {
  designator?: ServiceDesignator;
  database?: string;
  user?: string;
  password?: string;
  scheme?: string;
}

export interface Worker_Binding_WorkerLoader {
  id?: string;
}

export interface Worker_Binding_MemoryCache {
  id?: string;
  limits?: Worker_Binding_MemoryCacheLimits;
}

export interface Worker_Binding_MemoryCacheLimits {
  maxKeys?: number;
  maxValueSize?: number;
  maxTotalValueSize?: number;
}

/**
 * Matches {@link Worker_DurableObjectNamespace_ContainerOptions} in config.capnp.
 */
export interface Worker_DurableObjectNamespace_ContainerOptions {
  /**
   * Image name to be used to create the container using supported provider.
   * By default, we pull the "latest" tag of this image.
   */
  imageName: string;
}

export type Worker_DurableObjectNamespace = {
  className?: string;
  preventEviction?: boolean;
  enableSql?: boolean;
  /**
   * If present, Durable Objects in this namespace have attached containers.
   * workerd will talk to the configured container engine to start containers for each
   * Durable Object based on the given image.
   */
  container?: Worker_DurableObjectNamespace_ContainerOptions;
} & ({ uniqueKey?: string } | { ephemeralLocal?: Void });

export type ExternalServer = { address?: string } & (
  | { http: HttpOptions }
  | { https: ExternalServer_Https }
  | { tcp: ExternalServer_Tcp }
);

export interface ExternalServer_Https {
  options?: HttpOptions;
  tlsOptions?: TlsOptions;
  certificateHost?: string;
}

export interface ExternalServer_Tcp {
  tlsOptions?: TlsOptions;
  certificateHost?: string;
}

export interface Network {
  allow?: Array<string>;
  deny?: Array<string>;
  tlsOptions?: TlsOptions;
}

export interface DiskDirectory {
  path?: string;
  writable?: boolean;
  allowDotfiles?: boolean;
}

export interface HttpOptions {
  style?: HttpOptions_Style;
  forwardedProtoHeader?: string;
  cfBlobHeader?: string;
  injectRequestHeaders?: Array<HttpOptions_Header>;
  injectResponseHeaders?: Array<HttpOptions_Header>;
  capnpConnectHost?: string;
}

export interface HttpOptions_Header {
  name?: string;
  value?: string;
}

export interface TlsOptions {
  keypair?: TlsOptions_Keypair;
  requireClientCerts?: boolean;
  trustBrowserCas?: boolean;
  trustedCertificates?: Array<string>;
  minVersion?: TlsOptions_Version;
  cipherList?: string;
}

export interface TlsOptions_Keypair {
  privateKey?: string;
  certificateChain?: string;
}

export interface Extension {
  modules?: Array<Extension_Module>;
}

export interface Extension_Module {
  name?: string;
  internal?: boolean;
  esModule?: string;
}
