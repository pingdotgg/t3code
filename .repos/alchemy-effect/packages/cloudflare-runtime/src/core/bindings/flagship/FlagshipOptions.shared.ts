/** Options for a local Flagship binding. */
export interface FlagshipProps {
  /** Binding name exposed on `env`. */
  readonly binding: string;
  /**
   * Identifier of the Flagship app the binding evaluates. Apps with the
   * same identifier share flags; the identifier also determines where flag
   * definitions are persisted on disk.
   */
  readonly appId: string;
}

/**
 * Service designator props passed to the `Flagship` evaluation entrypoint
 * (`ctx.props`). A single `flagship` service hosts every app; each binding's
 * designator carries the app it evaluates.
 */
export interface FlagshipServiceProps {
  readonly appId: string;
}

/**
 * A flag definition as stored in the local simulator: one JSON file per
 * flag (see {@link flagFileSegments}). Mirrors the shape of the Flagship REST API's
 * flag body.
 */
export interface FlagshipFlagDefinition {
  /** When false, the flag always serves `defaultVariation`. */
  readonly enabled: boolean;
  /** Variation served when no rule matches or the flag is disabled. */
  readonly defaultVariation: string;
  /** Map of variation name to value. */
  readonly variations: Record<string, unknown>;
  /** Targeting rules, evaluated in ascending `priority`. */
  readonly rules: ReadonlyArray<FlagshipRule>;
}

export interface FlagshipRule {
  readonly conditions: ReadonlyArray<FlagshipCondition>;
  readonly priority: number;
  readonly serveVariation: string;
  readonly rollout?: {
    readonly percentage: number;
    readonly attribute?: string;
  };
}

export type FlagshipCondition =
  | {
      readonly attribute: string;
      readonly operator: string;
      readonly value: unknown;
    }
  | {
      readonly clauses: ReadonlyArray<FlagshipCondition>;
      readonly logicalOperator: "AND" | "OR";
    };

export const SERVICE_FLAGSHIP = "flagship";
export const SERVICE_FLAGSHIP_STORAGE = "flagship:storage";
export const FLAGSHIP_ENTRYPOINT = "Flagship";

/** Service binding through which the evaluator reads flag definition files. */
export const BINDING_FLAGSHIP_DISK = "DISK";

/** Directory under the runtime's storage root holding flag definitions. */
export const FLAGSHIP_STORAGE_DIRECTORY = "flagship";

/**
 * Path segments (relative to {@link FLAGSHIP_STORAGE_DIRECTORY}) of a flag's
 * definition file: `<app>/<key>.json`. Definitions are plain files rather
 * than Durable Object storage so the dev runtime and deploy-time tooling in
 * other processes can read and write them concurrently; each evaluation
 * reads the file fresh.
 */
export const flagFileSegments = (appId: string, flagKey: string): [string, string] => [
  encodeSegment(appId),
  `${encodeSegment(flagKey)}.json`,
];

/**
 * Encode an id into a file-name and URL-path safe segment: lowercase ASCII
 * letters, digits, `_` and `-` pass through, every other UTF-16 code unit
 * (uppercase included, so case-insensitive file systems can't merge two
 * ids) becomes `~` plus four hex digits. Reversible and identical in Node
 * and workerd.
 */
export const encodeSegment = (id: string): string =>
  id.replace(/[^a-z0-9_-]/g, (c) => `~${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
