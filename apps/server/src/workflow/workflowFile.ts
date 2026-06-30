import { WorkflowDefinition, type WorkflowLane, type WorkflowStep } from "@t3tools/contracts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  isSafeWorkflowInstructionPath,
  unsafeWorkflowInstructionPathMessage,
} from "./instructionPath.ts";
import { findHandoffReferences, unknownTicketPlaceholders } from "./instructionTemplate.ts";
import { inspectJsonLogicRule } from "./jsonLogicRule.ts";

export type LintCode =
  | "duplicate_lane_key"
  | "duplicate_step_key"
  | "missing_lane_ref"
  | "unknown_provider_instance"
  | "missing_instruction_file"
  | "unsafe_instruction_path"
  | "auto_lane_cycle"
  | "unreachable_terminal"
  | "invalid_wip_limit"
  | "invalid_json_logic"
  | "unknown_predicate_path"
  | "unsafe_step_key"
  | "invalid_retention"
  | "invalid_retry"
  | "invalid_panel"
  | "unknown_template_placeholder"
  | "invalid_step"
  | "invalid_source"
  | "duplicate_source_id"
  | "invalid_outbound"
  | "duplicate_outbound_id"
  | "invalid_continue_session"
  | "invalid_handoff_reference";

export interface LintError {
  readonly code: LintCode;
  readonly message: string;
  readonly laneKey?: string;
  readonly stepKey?: string;
  readonly transitionIndex?: number;
}

export interface LintContext {
  readonly providerInstanceExists: (instanceId: string) => boolean;
  // Whether a provider instance supports resuming its own session across
  // turns/steps (Codex/Claude/Grok/Cursor do; OpenCode does not). Used to
  // capability-gate `continueSession`. Absent => treated as resumable
  // (permissive — the BoardRegistry lint has no provider info).
  readonly providerInstanceSupportsResume?: (instanceId: string) => boolean;
  readonly instructionFileExists: (repoRelativePath: string) => boolean;
  // Returns the contents of an existing instruction file so template
  // placeholders inside it can be linted; null/absent skips that check.
  readonly readInstructionFile?: (repoRelativePath: string) => string | null;
  // Returns the pure selector schema for a given provider name, or null if the
  // provider is unknown. Used for synchronous (no-network) selector validation.
  // The schema must have no DecodingServices requirement (pure, sync decode).
  readonly selectorSchemaFor?: (provider: string) => Schema.Decoder<any> | null;
}

const routingTargets = (lane: WorkflowLane): ReadonlyArray<string> => {
  const on = lane.on;
  if (!on) {
    return [];
  }
  return [on.success, on.failure, on.blocked].flatMap((target) =>
    target === undefined ? [] : [target as string],
  );
};

const stepRoutingTargets = (step: WorkflowStep): ReadonlyArray<string> => {
  const on = step.on;
  if (!on) {
    return [];
  }
  return [on.success, on.failure, on.blocked].flatMap((target) =>
    target === undefined ? [] : [target as string],
  );
};

export const encodeWorkflowDefinitionJson = Schema.encodeSync(
  fromJsonStringPretty(WorkflowDefinition),
);

export const MIN_STEP_RETRY_ATTEMPTS = 2;
export const MAX_STEP_RETRY_ATTEMPTS = 5;

const PATH_SAFE_STEP_KEY = /^[A-Za-z0-9_-]+$/;

const isReferencedStepPath = (path: string, stepKey: string) =>
  path === `steps.${stepKey}` || path.startsWith(`steps.${stepKey}.`);

const predicatePathError = (
  path: string,
  stepsByKey: ReadonlyMap<string, WorkflowStep>,
): string | null => {
  if (path === "status" || path === "pipeline.result" || path === "lane.runCount") {
    return null;
  }
  if (path.startsWith("pipeline.") || path.startsWith("lane.")) {
    return `Unknown predicate path "${path}"`;
  }

  const parts = path.split(".");
  if (parts[0] !== "steps" || parts[1] === undefined || parts[1] === "") {
    return `Unknown predicate path "${path}"`;
  }

  const step = stepsByKey.get(parts[1]);
  if (!step) {
    return `Unknown predicate path "${path}"`;
  }

  const field = parts[2];
  if (field === undefined) {
    return null;
  }
  if (field === "status") {
    return parts.length === 3 ? null : `Unknown predicate path "${path}"`;
  }
  if (field === "exitCode") {
    return step.type === "script" && parts.length === 3
      ? null
      : `Predicate path "${path}" can only read exitCode from script steps`;
  }
  if (field === "output") {
    const allowed =
      (step.type === "agent" && step.captureOutput === true) ||
      (step.type === "pullRequest" && step.action === "open");
    return allowed
      ? null
      : `Predicate path "${path}" can only read output from captureOutput agent steps or pullRequest open steps`;
  }

  return `Unknown predicate path "${path}"`;
};

export const lintWorkflowDefinition = (
  def: WorkflowDefinition,
  ctx: LintContext,
): ReadonlyArray<LintError> => {
  const errors: LintError[] = [];
  const laneKeys = new Set<string>();
  const allKeys = new Set(def.lanes.map((lane) => lane.key as string));

  for (const lane of def.lanes) {
    const laneKey = lane.key as string;
    if (laneKeys.has(laneKey)) {
      errors.push({
        code: "duplicate_lane_key",
        laneKey,
        message: `Duplicate lane key "${laneKey}"`,
      });
    }
    laneKeys.add(laneKey);

    if (lane.wipLimit !== undefined) {
      if (lane.wipLimit < 1) {
        errors.push({
          code: "invalid_wip_limit",
          laneKey,
          message: `Lane "${laneKey}" wipLimit must be at least 1`,
        });
      }
      if (lane.terminal === true) {
        errors.push({
          code: "invalid_wip_limit",
          laneKey,
          message: `Terminal lane "${laneKey}" cannot define a wipLimit`,
        });
      }
    }

    if (lane.retention !== undefined) {
      if (lane.terminal !== true) {
        errors.push({
          code: "invalid_retention",
          laneKey,
          message: `Lane "${laneKey}" retention is only valid on terminal lanes`,
        });
      }
      if (Duration.toMillis(lane.retention) <= 0) {
        errors.push({
          code: "invalid_retention",
          laneKey,
          message: `Terminal lane "${laneKey}" retention must be a positive duration`,
        });
      }
    }

    const stepKeys = new Set<string>();
    const stepsByKey = new Map<string, WorkflowStep>();
    // Full set of step keys in this lane's pipeline, computed up front so a
    // handoff reference can point forward to a step defined later in the lane.
    const laneStepKeys = new Set((lane.pipeline ?? []).map((step) => step.key as string));
    let stepIndex = 0;
    for (const step of lane.pipeline ?? []) {
      const isFirstStep = stepIndex === 0;
      stepIndex += 1;
      const stepKey = step.key as string;
      if (stepKeys.has(stepKey)) {
        errors.push({
          code: "duplicate_step_key",
          laneKey,
          stepKey,
          message: `Duplicate step key "${stepKey}" in lane "${laneKey}"`,
        });
      }
      stepKeys.add(stepKey);
      stepsByKey.set(stepKey, step);

      for (const target of stepRoutingTargets(step)) {
        if (!allKeys.has(target)) {
          errors.push({
            code: "missing_lane_ref",
            laneKey,
            stepKey,
            message: `Step "${stepKey}" in lane "${laneKey}" routes to missing lane "${target}"`,
          });
        }
      }

      // continueSession resumes an agent's own provider session across
      // steps/loops. It is valid only on a single (non-panel) agent step whose
      // provider supports session resume. `continueSession` lives on AgentStep,
      // so decode strips it from other step types; the non-agent guard still
      // defends a hand-rolled/undecoded definition. Reading via a property
      // probe keeps it type-safe across the step union.
      if ((step as { continueSession?: unknown }).continueSession === true) {
        if (step.type !== "agent") {
          errors.push({
            code: "invalid_continue_session",
            laneKey,
            stepKey,
            message: `Step "${stepKey}" continueSession is only valid on agent steps`,
          });
        } else if (step.panel !== undefined && step.panel >= 2) {
          errors.push({
            code: "invalid_continue_session",
            laneKey,
            stepKey,
            message: `Step "${stepKey}" continueSession cannot be combined with a reviewer panel`,
          });
        } else if (ctx.providerInstanceSupportsResume !== undefined) {
          // A retry can escalate to a DIFFERENT provider instance; that attempt
          // still applies continueSession, so every instance the step may run on
          // — base + escalation — must support resume, not just the base.
          const supportsResume = ctx.providerInstanceSupportsResume;
          const escalateInstance = step.retry?.escalate?.instance;
          const candidateInstances = [
            step.agent.instance as string,
            ...(escalateInstance === undefined ? [] : [escalateInstance as string]),
          ];
          const unsupported = candidateInstances.find((instance) => !supportsResume(instance));
          if (unsupported !== undefined) {
            errors.push({
              code: "invalid_continue_session",
              laneKey,
              stepKey,
              message: `Step "${stepKey}" provider instance "${unsupported}" does not support session resume`,
            });
          }
        }
      }

      if (step.type === "agent" && step.panel !== undefined) {
        if (step.panel < 2 || step.panel > 5) {
          errors.push({
            code: "invalid_panel",
            laneKey,
            stepKey,
            message: `Step "${stepKey}" panel must be between 2 and 5 reviewers`,
          });
        }
        if (step.captureOutput !== true) {
          errors.push({
            code: "invalid_panel",
            laneKey,
            stepKey,
            message: `Step "${stepKey}" panel requires captureOutput so verdicts can be compared`,
          });
        }
      }

      if ((step.type === "agent" || step.type === "script") && step.retry !== undefined) {
        if (
          step.retry.maxAttempts < MIN_STEP_RETRY_ATTEMPTS ||
          step.retry.maxAttempts > MAX_STEP_RETRY_ATTEMPTS
        ) {
          errors.push({
            code: "invalid_retry",
            laneKey,
            stepKey,
            message: `Step "${stepKey}" retry maxAttempts must be between ${MIN_STEP_RETRY_ATTEMPTS} and ${MAX_STEP_RETRY_ATTEMPTS}`,
          });
        }
        if (step.type === "script" && step.retry.escalate !== undefined) {
          errors.push({
            code: "invalid_retry",
            laneKey,
            stepKey,
            message: `Script step "${stepKey}" cannot define a retry escalation`,
          });
        }
        if (
          step.type === "agent" &&
          step.retry.escalate?.instance !== undefined &&
          !ctx.providerInstanceExists(step.retry.escalate.instance)
        ) {
          errors.push({
            code: "unknown_provider_instance",
            laneKey,
            stepKey,
            message: `Unknown provider instance "${step.retry.escalate.instance}" in retry escalation`,
          });
        }
      }

      if (step.type === "pullRequest") {
        if (
          step.action === "open" &&
          (step.strategy !== undefined || step.deleteBranch !== undefined)
        ) {
          errors.push({
            code: "invalid_step",
            laneKey,
            stepKey,
            message: `Step "${stepKey}": strategy/deleteBranch only apply to action "land"`,
          });
        }
        if (
          step.action === "land" &&
          (step.base !== undefined ||
            step.draft !== undefined ||
            step.titleTemplate !== undefined ||
            step.bodyTemplate !== undefined)
        ) {
          errors.push({
            code: "invalid_step",
            laneKey,
            stepKey,
            message: `Step "${stepKey}": base/draft/templates only apply to action "open"`,
          });
        }
        for (const template of [step.titleTemplate, step.bodyTemplate]) {
          if (template !== undefined) {
            for (const placeholder of unknownTicketPlaceholders(template)) {
              errors.push({
                code: "unknown_template_placeholder",
                laneKey,
                stepKey,
                message: `Step "${stepKey}" references unknown placeholder "{{ticket.${placeholder}}}"`,
              });
            }
          }
        }
      }

      if (step.type !== "agent") {
        continue;
      }

      const instructionText =
        typeof step.instruction === "string"
          ? step.instruction
          : (ctx.readInstructionFile?.(step.instruction.file) ?? null);
      if (instructionText !== null) {
        for (const placeholder of unknownTicketPlaceholders(instructionText)) {
          errors.push({
            code: "unknown_template_placeholder",
            laneKey,
            stepKey,
            message: `Step "${stepKey}" instruction references unknown placeholder "{{ticket.${placeholder}}}"`,
          });
        }

        // Inter-agent handoff references must resolve within this lane's
        // pipeline. `{{prev.output}}` needs a preceding step, so it is invalid
        // on the first step. `{{step.<key>.output}}` must name a step in the
        // lane; forward references (a key defined later) are allowed.
        for (const ref of findHandoffReferences(instructionText)) {
          if (ref.kind === "prev") {
            if (isFirstStep) {
              errors.push({
                code: "invalid_handoff_reference",
                laneKey,
                stepKey,
                message: `Step "${stepKey}" references "{{prev.output}}" but has no preceding step in lane "${laneKey}"`,
              });
            }
          } else if (ref.stepKey !== undefined && !laneStepKeys.has(ref.stepKey)) {
            errors.push({
              code: "invalid_handoff_reference",
              laneKey,
              stepKey,
              message: `Step "${stepKey}" references "{{step.${ref.stepKey}.output}}" but no step "${ref.stepKey}" exists in lane "${laneKey}"`,
            });
          }
        }
      }

      if (!ctx.providerInstanceExists(step.agent.instance)) {
        errors.push({
          code: "unknown_provider_instance",
          laneKey,
          stepKey,
          message: `Unknown provider instance "${step.agent.instance}"`,
        });
      }

      if (typeof step.instruction === "object") {
        if (!isSafeWorkflowInstructionPath(step.instruction.file)) {
          errors.push({
            code: "unsafe_instruction_path",
            laneKey,
            stepKey,
            message: unsafeWorkflowInstructionPathMessage(step.instruction.file),
          });
        } else if (!ctx.instructionFileExists(step.instruction.file)) {
          errors.push({
            code: "missing_instruction_file",
            laneKey,
            stepKey,
            message: `Instruction file not found: "${step.instruction.file}"`,
          });
        }
      }
    }

    for (const target of routingTargets(lane)) {
      if (!allKeys.has(target)) {
        errors.push({
          code: "missing_lane_ref",
          laneKey,
          message: `Lane "${laneKey}" routes to missing lane "${target}"`,
        });
      }
    }

    for (const action of lane.actions ?? []) {
      if (!allKeys.has(action.to as string)) {
        errors.push({
          code: "missing_lane_ref",
          laneKey,
          message: `Lane "${laneKey}" action "${action.label}" targets missing lane "${action.to}"`,
        });
      }
    }

    for (const [eventIndex, eventMatcher] of (lane.onEvent ?? []).entries()) {
      if (!allKeys.has(eventMatcher.to as string)) {
        errors.push({
          code: "missing_lane_ref",
          laneKey,
          message: `Lane "${laneKey}" onEvent ${eventIndex} ("${eventMatcher.name}") targets missing lane "${eventMatcher.to}"`,
        });
      }
      if (eventMatcher.when !== undefined) {
        const inspection = inspectJsonLogicRule(eventMatcher.when);
        for (const issue of inspection.issues) {
          errors.push({
            code: "invalid_json_logic",
            laneKey,
            message: `Lane "${laneKey}" onEvent ${eventIndex}: ${issue.message}`,
          });
        }
        // Event predicates see only the inbound event and PR state — not pipeline state.
        for (const path of inspection.variablePaths) {
          if (
            path !== "event.name" &&
            path !== "event.payload" &&
            !path.startsWith("event.payload.") &&
            path !== "pr.ciState" &&
            path !== "pr.reviewDecision"
          ) {
            errors.push({
              code: "unknown_predicate_path",
              laneKey,
              message: `Lane "${laneKey}" onEvent ${eventIndex}: unknown predicate path "${path}" (event predicates may read event.name, event.payload.*, pr.ciState, pr.reviewDecision)`,
            });
          }
        }
      }
    }

    for (const [transitionIndex, transition] of (lane.transitions ?? []).entries()) {
      if (!allKeys.has(transition.to as string)) {
        errors.push({
          code: "missing_lane_ref",
          laneKey,
          transitionIndex,
          message: `Lane "${laneKey}" transition ${transitionIndex} routes to missing lane "${transition.to}"`,
        });
      }

      const inspection = inspectJsonLogicRule(transition.when);
      for (const issue of inspection.issues) {
        errors.push({
          code: "invalid_json_logic",
          laneKey,
          transitionIndex,
          message: `Lane "${laneKey}" transition ${transitionIndex}: ${issue.message}`,
        });
      }

      // An auto lane that transitions back into itself re-runs its pipeline
      // every time the predicate matches; without lane.runCount in the
      // predicate that loop has no bound and burns agent runs forever.
      if (
        lane.entry === "auto" &&
        (transition.to as string) === laneKey &&
        !inspection.variablePaths.includes("lane.runCount")
      ) {
        errors.push({
          code: "auto_lane_cycle",
          laneKey,
          transitionIndex,
          message: `Auto lane "${laneKey}" transitions to itself without bounding the loop on lane.runCount`,
        });
      }

      for (const path of inspection.variablePaths) {
        for (const step of lane.pipeline ?? []) {
          const stepKey = step.key as string;
          if (!PATH_SAFE_STEP_KEY.test(stepKey) && isReferencedStepPath(path, stepKey)) {
            errors.push({
              code: "unsafe_step_key",
              laneKey,
              stepKey,
              transitionIndex,
              message: `Step key "${stepKey}" must match [A-Za-z0-9_-]+ to be used in predicate paths`,
            });
          }
        }

        const message = predicatePathError(path, stepsByKey);
        if (message !== null) {
          errors.push({
            code: "unknown_predicate_path",
            laneKey,
            transitionIndex,
            message,
          });
        }
      }
    }
  }

  const byKey = new Map<string, WorkflowLane>(
    def.lanes.map((lane) => [lane.key as string, lane] as const),
  );
  for (const lane of def.lanes) {
    if (lane.entry !== "auto") {
      continue;
    }

    const seen = new Set<string>();
    let cursor: WorkflowLane | undefined = lane;
    while (cursor && cursor.entry === "auto" && !cursor.terminal) {
      const cursorKey = cursor.key as string;
      if (seen.has(cursorKey)) {
        errors.push({
          code: "auto_lane_cycle",
          laneKey: lane.key as string,
          message: `Auto-lane cycle detected starting at "${lane.key}"`,
        });
        break;
      }
      seen.add(cursorKey);
      const next = cursor.on?.success as string | undefined;
      cursor = next ? byKey.get(next) : undefined;
    }
  }

  // ── Source lint (synchronous — pure schema decode, no network) ──────────
  const seenSourceIds = new Set<string>();
  for (const source of def.sources ?? []) {
    const sourceId = source.id as string;

    // Duplicate source id check
    if (seenSourceIds.has(sourceId)) {
      errors.push({
        code: "duplicate_source_id",
        message: `Duplicate source id "${sourceId}"`,
      });
    }
    seenSourceIds.add(sourceId);

    // destinationLane must exist
    if (!allKeys.has(source.destinationLane as string)) {
      errors.push({
        code: "missing_lane_ref",
        message: `Source "${sourceId}" destinationLane "${source.destinationLane}" does not exist`,
      });
    }

    // closedLane must exist and be terminal
    if (!allKeys.has(source.closedLane as string)) {
      errors.push({
        code: "missing_lane_ref",
        message: `Source "${sourceId}" closedLane "${source.closedLane}" does not exist`,
      });
    } else {
      const closedLaneDef = byKey.get(source.closedLane as string);
      if (closedLaneDef?.terminal !== true) {
        errors.push({
          code: "invalid_source",
          message: `Source "${sourceId}" closedLane "${source.closedLane}" must be a terminal lane`,
        });
      }
    }

    // connectionRef must not be blank
    const connectionRef = source.connectionRef as string;
    if (!connectionRef || connectionRef.trim().length === 0) {
      errors.push({
        code: "invalid_source",
        message: `Source "${sourceId}" connectionRef must not be empty`,
      });
    }

    // Selector schema validation (pure, synchronous)
    if (ctx.selectorSchemaFor !== undefined) {
      const schema = ctx.selectorSchemaFor(source.provider as string);
      if (schema === null) {
        errors.push({
          code: "invalid_source",
          message: `Source "${sourceId}" has unknown provider "${source.provider}"`,
        });
      } else {
        const decodeExit = Schema.decodeUnknownExit(schema)(source.selector);
        if (Exit.isFailure(decodeExit)) {
          const squashed = Cause.squash(decodeExit.cause);
          const message = Schema.isSchemaError(squashed)
            ? String(squashed.message)
            : Cause.pretty(decodeExit.cause);
          errors.push({
            code: "invalid_source",
            message: `Source "${sourceId}" selector is invalid: ${message}`,
          });
        } else {
          // Extra check: Asana section/tag filtering is not supported yet
          if (
            (source.provider as string) === "asana" &&
            decodeExit.value !== undefined &&
            decodeExit.value !== null &&
            typeof decodeExit.value === "object"
          ) {
            const selector = decodeExit.value as Record<string, unknown>;
            if (selector["sectionGid"] !== undefined || selector["tagGid"] !== undefined) {
              errors.push({
                code: "invalid_source",
                message: `Source "${sourceId}" Asana section/tag filtering is not supported yet; remove sectionGid/tagGid`,
              });
            }
          }
        }
      }
    }

    // autoPull rule lint (jsonLogic + item-context allow-list)
    const AUTO_PULL_ALLOWED_VARS = new Set([
      "title",
      "body",
      "labels",
      "assignees",
      "state",
      "provider",
    ]);
    if (source.autoPull !== undefined) {
      const inspection = inspectJsonLogicRule(source.autoPull.rule);
      for (const issue of inspection.issues) {
        errors.push({
          code: "invalid_json_logic",
          message: `Source "${sourceId}" autoPull rule: ${issue.message}`,
        });
      }
      for (const path of inspection.variablePaths) {
        if (!AUTO_PULL_ALLOWED_VARS.has(path)) {
          errors.push({
            code: "unknown_predicate_path",
            message: `Source "${sourceId}" autoPull: unknown predicate path "${path}" (allowed: title, body, labels, assignees, state, provider)`,
          });
        }
      }
    }
  }

  // ── Outbound rule lint ────────────────────────────────────────────────────
  // The outbound `when` predicate evaluates against OutboundEventContext, whose
  // field set is DIFFERENT from the transition/onEvent path-sets, so it is
  // validated against its own allow-list. Keep this in sync with
  // OutboundEventContext in contracts/outbound.ts.
  const OUTBOUND_ALLOWED_PATHS = new Set([
    "trigger",
    "ticketId",
    "boardId",
    "title",
    "status",
    "fromLane",
    "toLane",
    "isTerminal",
    "reason",
    "occurredAt",
  ]);
  const OUTBOUND_TRIGGERS = new Set(["needs_attention", "blocked", "done", "lane_entered"]);
  const OUTBOUND_FORMATTERS = new Set(["generic", "slack"]);

  const OUTBOUND_RULE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
  const OUTBOUND_RULE_ID_MAX_LENGTH = 64;

  const seenOutboundIds = new Set<string>();
  for (const rule of def.outbound ?? []) {
    const ruleId = rule.id as string;

    // Duplicate id check
    if (seenOutboundIds.has(ruleId)) {
      errors.push({
        code: "duplicate_outbound_id",
        message: `Duplicate outbound rule id "${ruleId}"`,
      });
    }
    seenOutboundIds.add(ruleId);

    // Validate rule id is header-safe (no whitespace/control chars) and within max length
    if (!OUTBOUND_RULE_ID_PATTERN.test(ruleId) || ruleId.length > OUTBOUND_RULE_ID_MAX_LENGTH) {
      errors.push({
        code: "invalid_outbound",
        message: `Outbound rule id "${ruleId}" must match ^[A-Za-z0-9._:-]+$ and be ≤64 chars`,
      });
    }

    // Validate `on` trigger
    if (!OUTBOUND_TRIGGERS.has(rule.on as string)) {
      errors.push({
        code: "invalid_outbound",
        message: `Outbound rule "${ruleId}" has unknown trigger "${rule.on}" (expected: needs_attention, blocked, done, lane_entered)`,
      });
    }

    // Validate `as` formatter
    if (!OUTBOUND_FORMATTERS.has(rule.as as string)) {
      errors.push({
        code: "invalid_outbound",
        message: `Outbound rule "${ruleId}" has unknown formatter "${rule.as}" (expected: generic, slack)`,
      });
    }

    // Validate `to` non-empty. Defensive: the contract's TrimmedNonEmptyString
    // already rejects blanks on decode (same as the sources block).
    const to = rule.to as string;
    if (!to || to.trim().length === 0) {
      errors.push({
        code: "invalid_outbound",
        message: `Outbound rule "${ruleId}" to must not be empty`,
      });
    }

    // Validate optional `when` predicate
    if (rule.when !== undefined) {
      const inspection = inspectJsonLogicRule(rule.when);
      for (const issue of inspection.issues) {
        errors.push({
          code: "invalid_outbound",
          message: `Outbound rule "${ruleId}" when: ${issue.message}`,
        });
      }
      for (const path of inspection.variablePaths) {
        if (!OUTBOUND_ALLOWED_PATHS.has(path)) {
          errors.push({
            code: "invalid_outbound",
            message: `Outbound rule "${ruleId}" when: unknown predicate path "${path}" (allowed: trigger, ticketId, boardId, title, status, fromLane, toLane, isTerminal, reason, occurredAt)`,
          });
        }
      }
    }
  }

  return errors;
};
