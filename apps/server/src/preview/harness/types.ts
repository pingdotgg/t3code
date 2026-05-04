export interface PreviewControlDefinition {
  name: string;
  label?: string;
  description?: string | null;
  type?:
    | "boolean"
    | "number"
    | "range"
    | "text"
    | "color"
    | "date"
    | "object"
    | "select"
    | "multi-select"
    | "radio"
    | "inline-radio"
    | "check"
    | "inline-check";
  options?: readonly unknown[];
  min?: number | null;
  max?: number | null;
  step?: number | null;
  defaultValue?: unknown;
}

export interface PreviewScenarioDefinition {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  env?: {
    pathname?: string;
    searchParams?: Record<string, string>;
  };
}

export interface PreviewDefinition {
  component?: string;
  componentExport?: string;
  scenarios?: readonly PreviewScenarioDefinition[];
  controls?: readonly PreviewControlDefinition[];
  moduleMocks?: Record<string, string>;
  envDefaults?: {
    pathname?: string;
    searchParams?: Record<string, string>;
  };
}
