export type FileKind =
  | "resource"
  | "host"
  | "operation"
  | "event-source"
  | "provider"
  | "index"
  | "helper";

export type ExportKind =
  | "class"
  | "const"
  | "enum"
  | "function"
  | "interface"
  | "namespace"
  | "type";

export interface SourceEntry {
  relativePath: string;
  outputPath: string;
  sourcePath: string;
}

export interface DuplicateGroup {
  canonical: string;
  ignored: string[];
}

export interface ExampleDoc {
  title: string;
  body: string;
}

export interface ExampleSection {
  title: string;
  examples: ExampleDoc[];
}

export interface JSDocInfo {
  summary?: string;
  defaultValue?: string;
  sections: ExampleSection[];
}

export interface PropertyDoc {
  name: string;
  type: string;
  optional: boolean;
  readonly: boolean;
  description?: string;
  defaultValue?: string;
}

export interface ShapeDoc {
  title: string;
  description?: string;
  properties: PropertyDoc[];
  signature?: string;
}

export interface ExportDoc {
  name: string;
  kind: ExportKind;
  signature: string;
  summary?: string;
  shape?: ShapeDoc;
}

export interface ResourceDoc {
  name: string;
  resourceType: string;
  props?: ShapeDoc;
  attributes?: ShapeDoc;
  binding?: ShapeDoc;
  lifecycleOperations: string[];
  providerName?: string;
}

export interface BindingClassDoc {
  name: string;
  identifier?: string;
  signature: string;
  summary?: string;
}

export interface OperationDoc {
  services: BindingClassDoc[];
  policies: BindingClassDoc[];
  runtimeLayers: string[];
  supportedHosts: string[];
  requestShapes: ShapeDoc[];
  usage?: {
    bindParameters: Array<{
      name: string;
      type: string;
      optional: boolean;
      rest: boolean;
    }>;
    invokeParameters: Array<{
      name: string;
      type: string;
      optional: boolean;
      rest: boolean;
    }>;
  };
}

export interface ReExportDoc {
  exportName: string;
  sourcePath: string;
  href?: string;
}

export interface IndexDoc {
  reExports: ReExportDoc[];
}

export interface ProviderDoc {
  exportedFactories: string[];
}

export interface LinkDoc {
  label: string;
  href: string;
}

export interface DirectoryCatalog {
  parent?: LinkDoc;
  siblings: LinkDoc[];
}

export interface FileDoc {
  title: string;
  fileKind: FileKind;
  summary: string;
  sourcePath: string;
  relativePath: string;
  outputPath: string;
  exports: ExportDoc[];
  resource?: ResourceDoc;
  operation?: OperationDoc;
  index?: IndexDoc;
  provider?: ProviderDoc;
  examples: ExampleSection[];
  autoExample?: ExampleDoc;
  relatedLinks: LinkDoc[];
  directoryCatalog: DirectoryCatalog;
}

export const lifecycleOperationOrder = [
  "read",
  "diff",
  "preCreate",
  "create",
  "update",
  "delete",
  "stables",
] as const;
