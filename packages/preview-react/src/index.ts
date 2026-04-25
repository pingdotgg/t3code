import type { PreviewControlValueMap, PreviewViewport } from "@forma/contracts";
import { createElement, type ComponentType, type ReactNode } from "react";

export interface PreviewWrapperProps {
  readonly children: ReactNode;
}

export type PreviewWrapper = ComponentType<PreviewWrapperProps>;

export interface PreviewCaseRenderContext {
  readonly controls: PreviewControlValueMap;
}

export interface PreviewCaseDefinition {
  readonly render: (context: PreviewCaseRenderContext) => ReactNode;
  readonly label?: string | undefined;
  readonly viewport?: PreviewViewport | undefined;
}

export interface PreviewDefinition {
  readonly label?: string | undefined;
  readonly wrapper?: PreviewWrapper | undefined;
  readonly cases: {
    readonly default: PreviewCaseDefinition;
  } & Record<string, PreviewCaseDefinition>;
}

export interface FormaPreviewConfig {
  readonly appRoot: string;
  readonly framework?: "react" | undefined;
  readonly bundler?: "vite" | undefined;
  readonly server: {
    readonly command: readonly [string, ...string[]];
    readonly cwd?: string | undefined;
    readonly env?: Readonly<Record<string, string>> | undefined;
  };
  readonly scan?: {
    readonly include?: readonly string[] | undefined;
    readonly exclude?: readonly string[] | undefined;
  };
  readonly components?: {
    readonly include?: readonly string[] | undefined;
    readonly exclude?: readonly string[] | undefined;
  };
  readonly graph?: {
    readonly include?: readonly string[] | undefined;
    readonly exclude?: readonly string[] | undefined;
  };
  readonly wrapper?: PreviewWrapper | undefined;
}

export function definePreview<T extends PreviewDefinition>(definition: T): T {
  return definition;
}

export function defineFormaPreviewConfig<T extends FormaPreviewConfig>(config: T): T {
  return config;
}

export function wrapPreviewNode(
  node: ReactNode,
  wrappers: ReadonlyArray<PreviewWrapper | null | undefined>,
): ReactNode {
  return wrappers.reduceRight<ReactNode>((current, Wrapper) => {
    if (!Wrapper) {
      return current;
    }
    return createElement(Wrapper, null, current);
  }, node);
}
