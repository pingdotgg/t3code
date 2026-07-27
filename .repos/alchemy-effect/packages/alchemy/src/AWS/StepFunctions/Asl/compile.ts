/**
 * The Step Functions program compiler: `SfnEffect` AST → a plain JSONata-mode
 * ASL `definition` object (with embedded `Output`s the engine resolves) plus
 * the IAM `policyStatements` its Task states require.
 *
 * The output is deliberately deterministic — state names and variable names
 * are per-compile ordinals, no timestamps — so `StateMachine`'s
 * `normalizeDefinition` drift comparison stays quiet across deploys of an
 * unchanged program.
 */
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import type { Input } from "../../../Input.ts";
import { toSeconds as toWholeSeconds } from "../../../Util/Duration.ts";
import * as Output from "../../../Output.ts";
import type { PolicyStatement } from "../../IAM/Policy.ts";
import {
  inputExpr,
  isExpr,
  nodeOf,
  renderExprString,
  renderNode,
  variableExpr,
} from "./Jsonata.ts";
import type { AslNode, RetryOptions } from "./Node.ts";
import { isSfnEffect, type SfnEffect } from "./Program.ts";

/**
 * A program failed to compile to ASL — e.g. yielding a non-`Sfn` value
 * inside `Sfn.gen`, or unreachable steps after an unconditional `Sfn.fail`.
 */
export class SfnCompileError extends Data.TaggedError("SfnCompileError")<{
  readonly message: string;
}> {}

/** The result of {@link compileProgram}. */
export interface CompiledProgram {
  /**
   * The ASL definition (JSONata query language). A plain object with
   * embedded `Output`s — exactly what `StateMachineProps.definition`
   * accepts.
   */
  readonly definition: Record<string, unknown>;
  /**
   * IAM policy statements collected from `Sfn.invoke` / `Sfn.integrate`
   * task states, for the state machine's execution role.
   */
  readonly policyStatements: Input<PolicyStatement>[];
}

interface Ctx {
  readonly nameCounters: Record<string, number>;
  varCounter: number;
  readonly policyStatements: Input<PolicyStatement>[];
  readonly invokedFunctions: Set<string>;
}

type State = Record<string, any>;

/**
 * A partially-built subgraph: its entry state, its states, and the names of
 * states whose `Next`/`End` is still open (patched when the fragment is
 * chained to a successor or sealed).
 */
interface Fragment {
  readonly startAt: string;
  readonly states: Record<string, State>;
  readonly terminals: readonly string[];
}

const allocName = (ctx: Ctx, prefix: string): string => {
  const n = ctx.nameCounters[prefix] ?? 0;
  ctx.nameCounters[prefix] = n + 1;
  return `${prefix}${n}`;
};

const allocVar = (ctx: Ctx): string => `v${ctx.varCounter++}`;

/** Chain `next` after `self`, patching `self`'s open terminals. */
const chain = (self: Fragment, next: Fragment): Fragment => {
  const states = { ...self.states, ...next.states };
  for (const terminal of self.terminals) {
    states[terminal] = { ...states[terminal], Next: next.startAt };
  }
  return { startAt: self.startAt, states, terminals: next.terminals };
};

/** Seal a fragment into a `{ StartAt, States }` machine (`End: true`). */
const seal = (
  fragment: Fragment,
): { StartAt: string; States: Record<string, State> } => {
  const states = { ...fragment.states };
  for (const terminal of fragment.terminals) {
    states[terminal] = { ...states[terminal], End: true };
  }
  return { StartAt: fragment.startAt, States: states };
};

/**
 * Render a payload/assign value: `Expr` references become `{% ... %}`
 * JSONata strings, embedded `Output`s pass through untouched (the engine
 * resolves them before serialization), containers recurse, `undefined`
 * becomes `null`.
 */
const renderValue = (value: unknown): unknown => {
  if (value === undefined) return null;
  if (isExpr(value)) return renderExprString(value);
  if (Output.isOutput(value)) return value;
  if (Array.isArray(value)) return value.map(renderValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, renderValue(entry)]),
    );
  }
  return value;
};

/**
 * Convert a `Duration.Input` to ASL whole seconds (normalizing any
 * persisted-state `Duration` JSON via the central util). ASL second fields
 * (`TimeoutSeconds`, `IntervalSeconds`, `Seconds`) must be positive
 * integers, so sub-second durations round up to 1.
 */
export const aslSeconds = (input: Duration.Input): number =>
  Math.max(1, toWholeSeconds(input)!);

const retryPolicy = (options: RetryOptions): Record<string, unknown> => ({
  ErrorEquals:
    options.while === undefined
      ? ["States.ALL"]
      : typeof options.while === "string"
        ? [options.while]
        : [...options.while],
  IntervalSeconds: aslSeconds(options.initial ?? "1 second"),
  BackoffRate: options.backoff ?? 2,
  MaxAttempts: options.maxAttempts ?? 3,
  ...(options.maxDelay !== undefined
    ? { MaxDelaySeconds: aslSeconds(options.maxDelay) }
    : {}),
  ...(options.jitter ? { JitterStrategy: "FULL" } : {}),
});

/**
 * Does this node compile to exactly one catchable/retryable state
 * (`Task`/`Parallel`/`Map`)? When true, `retry`/`catch` attach their
 * `Retry`/`Catch` directly instead of wrapping in a single-branch
 * `Parallel`.
 */
const isSingleCatchableState = (node: AslNode): boolean =>
  node.kind === "invoke" ||
  node.kind === "integrate" ||
  node.kind === "all" ||
  node.kind === "forEach" ||
  (node.kind === "retry" && isSingleCatchableState(node.inner.node));

export const compileNode = (ctx: Ctx, node: AslNode, v: string): Fragment => {
  switch (node.kind) {
    case "invoke": {
      const name = allocName(ctx, "Invoke");
      if (!ctx.invokedFunctions.has(node.fn.LogicalId)) {
        ctx.invokedFunctions.add(node.fn.LogicalId);
        ctx.policyStatements.push({
          Effect: "Allow",
          Action: ["lambda:InvokeFunction"],
          Resource: [
            node.fn.functionArn,
            // cover qualified invocations (versions/aliases)
            Output.interpolate`${node.fn.functionArn}:*`,
          ],
        } as Input<PolicyStatement>);
      }
      return {
        startAt: name,
        states: {
          [name]: {
            Type: "Task",
            Resource: "arn:aws:states:::lambda:invoke",
            Arguments: {
              FunctionName: node.fn.functionArn,
              Payload: renderValue(node.payload),
            },
            Assign: { [v]: "{% $states.result.Payload %}" },
          },
        },
        terminals: [name],
      };
    }

    case "integrate": {
      const name = allocName(ctx, "Task");
      ctx.policyStatements.push(
        ...((node.options.policyStatements ?? []) as Input<PolicyStatement>[]),
      );
      return {
        startAt: name,
        states: {
          [name]: {
            Type: "Task",
            Resource: node.waitForTaskToken
              ? `${node.options.resource}.waitForTaskToken`
              : node.options.resource,
            ...(node.options.arguments !== undefined
              ? { Arguments: renderValue(node.options.arguments) }
              : {}),
            ...(node.options.timeout !== undefined
              ? { TimeoutSeconds: aslSeconds(node.options.timeout) }
              : {}),
            Assign: { [v]: "{% $states.result %}" },
          },
        },
        terminals: [name],
      };
    }

    case "all": {
      const name = allocName(ctx, "Parallel");
      return {
        startAt: name,
        states: {
          [name]: {
            Type: "Parallel",
            Branches: node.branches.map((branch) => compileBranch(ctx, branch)),
            Assign: { [v]: "{% $states.result %}" },
          },
        },
        terminals: [name],
      };
    }

    case "forEach": {
      const name = allocName(ctx, "Map");
      // the item arrives as the ItemProcessor's state input — bind it to a
      // variable in a prologue Pass so the body can reference it anywhere
      // ($states.context.Map.Item.Value only exists inside ItemSelector)
      const itemVar = allocVar(ctx);
      const body = node.body(variableExpr(itemVar));
      if (!isSfnEffect(body)) {
        throw new SfnCompileError({
          message: "Sfn.forEach body must return an Sfn effect",
        });
      }
      const itemName = allocName(ctx, "Item");
      const intro: Fragment = {
        startAt: itemName,
        states: {
          [itemName]: {
            Type: "Pass",
            Assign: { [itemVar]: "{% $states.input %}" },
          },
        },
        terminals: [itemName],
      };
      return {
        startAt: name,
        states: {
          [name]: {
            Type: "Map",
            Items: renderExprString(node.items),
            ...(node.options.concurrency !== undefined
              ? { MaxConcurrency: node.options.concurrency }
              : {}),
            ItemProcessor: {
              ProcessorConfig: { Mode: "INLINE" },
              ...compileBranch(ctx, body, intro),
            },
            Assign: { [v]: "{% $states.result %}" },
          },
        },
        terminals: [name],
      };
    }

    case "sleep": {
      const name = allocName(ctx, "Wait");
      return {
        startAt: name,
        states: {
          [name]: {
            Type: "Wait",
            Seconds: node.seconds,
            Assign: { [v]: null },
          },
        },
        terminals: [name],
      };
    }

    case "when": {
      const name = allocName(ctx, "Choice");
      const onTrue = compileNode(ctx, node.onTrue.node, v);
      const onFalse = compileNode(
        ctx,
        node.onFalse?.node ?? { kind: "succeed", value: null },
        v,
      );
      return {
        startAt: name,
        states: {
          [name]: {
            Type: "Choice",
            Choices: [
              {
                Condition: renderExprString(node.condition),
                Next: onTrue.startAt,
              },
            ],
            Default: onFalse.startAt,
          },
          ...onTrue.states,
          ...onFalse.states,
        },
        terminals: [...onTrue.terminals, ...onFalse.terminals],
      };
    }

    case "match": {
      const name = allocName(ctx, "Choice");
      const states: Record<string, State> = {};
      const terminals: string[] = [];
      const rules: Record<string, unknown>[] = [];
      const value = renderNode(nodeOf(node.value));
      for (const [caseValue, program] of Object.entries(node.cases)) {
        const fragment = compileNode(ctx, program.node, v);
        Object.assign(states, fragment.states);
        terminals.push(...fragment.terminals);
        rules.push({
          // string-coerced comparison so numeric/boolean case keys behave
          Condition: `{% ($string(${value}) = ${JSON.stringify(caseValue)}) %}`,
          Next: fragment.startAt,
        });
      }
      let defaultTarget: string | undefined;
      if (node.otherwise !== undefined) {
        const fragment = compileNode(ctx, node.otherwise.node, v);
        Object.assign(states, fragment.states);
        terminals.push(...fragment.terminals);
        defaultTarget = fragment.startAt;
      }
      return {
        startAt: name,
        states: {
          [name]: {
            Type: "Choice",
            Choices: rules,
            ...(defaultTarget !== undefined ? { Default: defaultTarget } : {}),
          },
          ...states,
        },
        terminals,
      };
    }

    case "succeed": {
      const name = allocName(ctx, "Pass");
      return {
        startAt: name,
        states: {
          [name]: { Type: "Pass", Assign: { [v]: renderValue(node.value) } },
        },
        terminals: [name],
      };
    }

    case "fail": {
      const name = allocName(ctx, "Fail");
      return {
        startAt: name,
        states: {
          [name]: { Type: "Fail", Error: node.error, Cause: node.cause },
        },
        terminals: [],
      };
    }

    case "retry": {
      if (isSingleCatchableState(node.inner.node)) {
        const fragment = compileNode(ctx, node.inner.node, v);
        const state = fragment.states[fragment.startAt];
        state.Retry = [...(state.Retry ?? []), retryPolicy(node.options)];
        return fragment;
      }
      // multi-state program: wrap in a single-branch Parallel so the whole
      // program re-runs on retry (Effect.retry semantics)
      const name = allocName(ctx, "Try");
      return {
        startAt: name,
        states: {
          [name]: {
            Type: "Parallel",
            Branches: [compileBranch(ctx, node.inner)],
            Retry: [retryPolicy(node.options)],
            Assign: { [v]: "{% $states.result[0] %}" },
          },
        },
        terminals: [name],
      };
    }

    case "catch": {
      const errorVar = allocVar(ctx);
      let guarded: Fragment;
      if (isSingleCatchableState(node.inner.node)) {
        guarded = compileNode(ctx, node.inner.node, v);
      } else {
        const name = allocName(ctx, "Try");
        guarded = {
          startAt: name,
          states: {
            [name]: {
              Type: "Parallel",
              Branches: [compileBranch(ctx, node.inner)],
              Assign: { [v]: "{% $states.result[0] %}" },
            },
          },
          terminals: [name],
        };
      }
      const handlerProgram = node.handler(variableExpr(errorVar));
      if (!isSfnEffect(handlerProgram)) {
        throw new SfnCompileError({
          message: "Sfn.catchTag/catchAll handler must return an Sfn effect",
        });
      }
      const handler = compileNode(ctx, handlerProgram.node, v);
      const target = guarded.states[guarded.startAt];
      target.Catch = [
        ...(target.Catch ?? []),
        {
          ErrorEquals: [...node.tags],
          Assign: { [errorVar]: "{% $states.errorOutput %}" },
          Next: handler.startAt,
        },
      ];
      return {
        startAt: guarded.startAt,
        states: { ...guarded.states, ...handler.states },
        terminals: [...guarded.terminals, ...handler.terminals],
      };
    }

    case "gen": {
      const iterator = node.body(inputExpr());
      const fragments: Fragment[] = [];
      let step = iterator.next();
      while (!step.done) {
        const program: unknown = step.value;
        if (!isSfnEffect(program)) {
          throw new SfnCompileError({
            message:
              "Sfn.gen may only yield Sfn effects (Sfn.invoke, Sfn.when, ...) — real Effects cannot compile to ASL",
          });
        }
        const stepVar = allocVar(ctx);
        fragments.push(compileNode(ctx, program.node, stepVar));
        step = iterator.next(variableExpr(stepVar));
      }
      const diverged =
        fragments.length > 0 &&
        fragments[fragments.length - 1].terminals.length === 0;
      if (!diverged) {
        // final Pass assigning the generator's return value
        const name = allocName(ctx, "Pass");
        fragments.push({
          startAt: name,
          states: {
            [name]: { Type: "Pass", Assign: { [v]: renderValue(step.value) } },
          },
          terminals: [name],
        });
      }
      return fragments.reduce((chained, fragment) => {
        if (chained.terminals.length === 0) {
          throw new SfnCompileError({
            message:
              "unreachable steps after an unconditional Sfn.fail — move the failure into a branch or make it the final step",
          });
        }
        return chain(chained, fragment);
      });
    }
  }
};

/**
 * Compile a program into a sealed `{ StartAt, States }` branch machine
 * (Parallel branch / Map ItemProcessor). The branch's own result variable is
 * exposed as the branch output via a terminal Pass state.
 */
const compileBranch = (
  ctx: Ctx,
  program: SfnEffect<any, any>,
  intro?: Fragment,
): { StartAt: string; States: Record<string, State> } => {
  const branchVar = allocVar(ctx);
  let fragment = compileNode(ctx, program.node, branchVar);
  if (intro !== undefined) fragment = chain(intro, fragment);
  if (fragment.terminals.length === 0) {
    // the branch always fails — no output state needed
    return seal(fragment);
  }
  const name = allocName(ctx, "Result");
  return seal(
    chain(fragment, {
      startAt: name,
      states: { [name]: { Type: "Pass", Output: `{% $${branchVar} %}` } },
      terminals: [name],
    }),
  );
};

/**
 * Compile a typed Step Functions program to a plain ASL definition object
 * (JSONata query language, embedded `Output`s intact) plus the IAM policy
 * statements its task states require. Pure and deterministic; throws
 * {@link SfnCompileError} on structurally invalid programs.
 *
 * This is sugar over the raw path: feed the result straight into the
 * existing `StateMachine` resource (`StateMachine.fromProgram` does exactly
 * that), or inspect/extend the definition first — the raw
 * `definition: Record<string, unknown>` escape hatch stays first-class.
 */
export const compileProgram = (
  program: SfnEffect<any, any>,
): CompiledProgram => {
  const ctx: Ctx = {
    nameCounters: {},
    varCounter: 0,
    policyStatements: [],
    invokedFunctions: new Set(),
  };
  const v = allocVar(ctx);
  const fragment = compileNode(ctx, program.node, v);
  const full =
    fragment.terminals.length === 0
      ? fragment
      : chain(fragment, {
          startAt: "Return",
          states: { Return: { Type: "Pass", Output: `{% $${v} %}` } },
          terminals: ["Return"],
        });
  const machine = seal(full);
  return {
    definition: {
      QueryLanguage: "JSONata",
      StartAt: machine.StartAt,
      States: machine.States,
    },
    policyStatements: ctx.policyStatements,
  };
};
