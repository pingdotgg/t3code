import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import picomatch from "picomatch";

/** Selection applies after the whole stack declaration evaluates. */
export interface ResourceSelection {
  /** Exact FQNs, unique logical IDs, or FQN globs; dependencies are included. */
  readonly include?: ReadonlyArray<string>;
  /** Hard exclusions. A selected node depending on an excluded node fails planning. */
  readonly exclude?: ReadonlyArray<string>;
}

/** Required filters return no output; possibly supplied filters make output optional. */
export type SelectionOutput<A, Options> = Options extends
  | { include: ReadonlyArray<string> }
  | { exclude: ReadonlyArray<string> }
  ? undefined
  : Options extends undefined
    ? A
    : Extract<
          Options[keyof Options & keyof ResourceSelection],
          ReadonlyArray<string>
        > extends never
      ? A
      : A | undefined;

export class InvalidResourceSelection extends Data.TaggedError(
  "InvalidResourceSelection",
)<{ message: string }> {}

export class UnsafeSelectionBoundary extends Data.TaggedError(
  "UnsafeSelectionBoundary",
)<{ message: string }> {}

/** Resolve and close the selection before accessing state or providers. */
export const selectResources = <
  Node extends { FQN: string; LogicalId: string },
>(
  declared: ReadonlyArray<Node>,
  upstream: (node: Node) => ReadonlyArray<string>,
  options: ResourceSelection,
) =>
  Effect.gen(function* () {
    if (options.include === undefined && options.exclude === undefined) {
      return undefined;
    }
    const byFqn = new Map(declared.map((node) => [node.FQN, node]));
    const available = declared
      .map((node) => node.FQN)
      .sort()
      .join(", ");
    const invalid = (message: string) =>
      Effect.die(
        new InvalidResourceSelection({
          message: `${message}. Available resources and Actions: ${available || "(none)"}`,
        }),
      );
    const resolve = (
      kind: "include" | "exclude",
      patterns: ReadonlyArray<string>,
    ) =>
      Effect.gen(function* () {
        if (patterns.length === 0)
          return yield* invalid(`${kind} must not be empty`);
        const matches = new Map<string, string>();
        for (const pattern of new Set(patterns)) {
          if (pattern.trim() === "")
            return yield* invalid(`${kind} pattern must not be empty`);
          const exact = byFqn.get(pattern);
          let nodes: ReadonlyArray<Node>;
          if (exact) {
            nodes = [exact];
          } else {
            const scanned = picomatch.scan(pattern);
            const parsed = yield* Effect.try(() =>
              picomatch.parse(pattern),
            ).pipe(
              Effect.catch(() =>
                invalid(`Invalid ${kind} pattern '${pattern}'`),
              ),
            );
            if (
              scanned.negated ||
              scanned.negatedExtglob ||
              parsed.negated ||
              parsed.negatedExtglob
            ) {
              return yield* invalid(
                `Negated pattern '${pattern}' is not supported; use --exclude instead`,
              );
            }
            const matcher = yield* Effect.try(() =>
              picomatch(pattern, {
                dot: true,
                strictBrackets: true,
                nonegate: true,
              }),
            ).pipe(
              Effect.catch(() =>
                invalid(`Invalid ${kind} pattern '${pattern}'`),
              ),
            );
            const glob = scanned.isGlob;
            nodes = declared.filter((node) =>
              glob ? matcher(node.FQN) : node.LogicalId === pattern,
            );
            if (!glob && nodes.length > 1) {
              return yield* invalid(
                `Ambiguous ${kind} '${pattern}'; use an FQN: ${nodes
                  .map((node) => node.FQN)
                  .sort()
                  .join(", ")}`,
              );
            }
          }
          if (nodes.length === 0) {
            if (kind === "include")
              return yield* invalid(
                `Unknown or unmatched include '${pattern}'`,
              );
            yield* Effect.logWarning(
              `Exclusion '${pattern}' matched no declared resources or Actions.`,
            );
          }
          for (const node of nodes) {
            if (!matches.has(node.FQN)) matches.set(node.FQN, pattern);
          }
        }
        return matches;
      });
    const included =
      options.include === undefined
        ? new Map(declared.map((node) => [node.FQN, node.FQN]))
        : yield* resolve("include", options.include);
    const excluded =
      options.exclude === undefined
        ? new Map<string, string>()
        : yield* resolve("exclude", options.exclude);
    const selected = new Set(
      [...included.keys()].filter((fqn) => !excluded.has(fqn)),
    );
    if (selected.size === 0)
      return yield* invalid("Resource selection is empty");
    const chains = new Map([...selected].map((fqn) => [fqn, [fqn]]));
    // Set iteration visits additions and terminates on dependency cycles.
    for (const fqn of selected) {
      for (const dependency of upstream(byFqn.get(fqn)!)) {
        const chain = [...chains.get(fqn)!, dependency];
        if (excluded.has(dependency)) {
          return yield* invalid(
            `Dependency ${chain.join(" -> ")} is blocked by exclude pattern '${excluded.get(dependency)}'`,
          );
        }
        if (!byFqn.has(dependency)) {
          return yield* invalid(
            `Dependency ${chain.join(" -> ")} is undeclared`,
          );
        }
        if (!selected.has(dependency)) {
          selected.add(dependency);
          chains.set(dependency, chain);
        }
      }
    }
    return selected;
  });
