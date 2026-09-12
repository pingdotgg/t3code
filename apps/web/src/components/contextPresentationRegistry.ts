import { COMPOSER_CONTEXT_KINDS, type KnownComposerContextKind } from "@t3tools/contracts";

export interface ContextPresentationCapability {
  details: "none" | "tooltip" | "popover";
  expanded: "none" | "inline-block" | "modal";
  defaultDraftView: "compact" | "expanded";
}

export interface ContextPresentationDefinition {
  kind: KnownComposerContextKind;
  capabilities: ContextPresentationCapability;
}

const DEFINITIONS = [
  {
    kind: "image",
    capabilities: { details: "tooltip", expanded: "modal", defaultDraftView: "compact" },
  },
  {
    kind: "file",
    capabilities: { details: "tooltip", expanded: "modal", defaultDraftView: "compact" },
  },
  {
    kind: "terminal",
    capabilities: { details: "popover", expanded: "none", defaultDraftView: "compact" },
  },
  {
    kind: "element",
    capabilities: { details: "popover", expanded: "none", defaultDraftView: "compact" },
  },
  {
    kind: "preview-annotation",
    capabilities: { details: "popover", expanded: "modal", defaultDraftView: "compact" },
  },
  {
    kind: "review-comment",
    capabilities: { details: "popover", expanded: "none", defaultDraftView: "compact" },
  },
  {
    kind: "mention",
    capabilities: { details: "none", expanded: "none", defaultDraftView: "compact" },
  },
  {
    kind: "skill",
    capabilities: { details: "tooltip", expanded: "none", defaultDraftView: "compact" },
  },
] as const satisfies ReadonlyArray<ContextPresentationDefinition>;

function buildDefinitionRegistry(
  definitions: ReadonlyArray<ContextPresentationDefinition>,
): ReadonlyMap<KnownComposerContextKind, ContextPresentationDefinition> {
  const registry = new Map<KnownComposerContextKind, ContextPresentationDefinition>();
  for (const definition of definitions) {
    if (registry.has(definition.kind)) {
      throw new Error(`Duplicate context presentation definition: ${definition.kind}`);
    }
    registry.set(definition.kind, definition);
  }
  for (const kind of COMPOSER_CONTEXT_KINDS) {
    if (!registry.has(kind)) {
      throw new Error(`Missing context presentation definition: ${kind}`);
    }
  }
  return registry;
}

export const CONTEXT_PRESENTATION_DEFINITIONS = buildDefinitionRegistry(DEFINITIONS);

export function contextPresentationDefinition(
  kind: KnownComposerContextKind,
): ContextPresentationDefinition {
  return CONTEXT_PRESENTATION_DEFINITIONS.get(kind)!;
}

export interface ContextPresentationHandler<TRecord, TRenderContext, TResult> {
  kind: KnownComposerContextKind;
  canRender?: (record: TRecord, context: TRenderContext) => boolean;
  render: (
    record: TRecord,
    context: TRenderContext,
    definition: ContextPresentationDefinition,
  ) => TResult;
}

export interface ContextPresentationRegistry<TRecord, TRenderContext, TResult> {
  definition(kind: KnownComposerContextKind): ContextPresentationDefinition;
  render(kind: string, record: TRecord | undefined, context: TRenderContext): TResult;
}

/**
 * Creates one checked dispatcher for a rendering surface. Definitions are shared; renderers stay
 * surface-specific so web composer and transcript presentation can differ without drifting on
 * capability semantics.
 */
export function createContextPresentationRegistry<TRecord, TRenderContext, TResult>(options: {
  handlers: ReadonlyArray<ContextPresentationHandler<TRecord, TRenderContext, TResult>>;
  requiredKinds?: ReadonlyArray<KnownComposerContextKind>;
  fallback: (kind: string, record: TRecord | undefined, context: TRenderContext) => TResult;
}): ContextPresentationRegistry<TRecord, TRenderContext, TResult> {
  const handlers = new Map<
    KnownComposerContextKind,
    ContextPresentationHandler<TRecord, TRenderContext, TResult>
  >();
  for (const handler of options.handlers) {
    if (handlers.has(handler.kind)) {
      throw new Error(`Duplicate context presentation handler: ${handler.kind}`);
    }
    handlers.set(handler.kind, handler);
  }
  for (const kind of options.requiredKinds ?? []) {
    if (!handlers.has(kind)) {
      throw new Error(`Missing context presentation handler: ${kind}`);
    }
  }

  return {
    definition: contextPresentationDefinition,
    render(kind, record, context) {
      const handler = handlers.get(kind as KnownComposerContextKind);
      if (!handler || record === undefined || handler.canRender?.(record, context) === false) {
        return options.fallback(kind, record, context);
      }
      return handler.render(record, context, contextPresentationDefinition(handler.kind));
    },
  };
}
