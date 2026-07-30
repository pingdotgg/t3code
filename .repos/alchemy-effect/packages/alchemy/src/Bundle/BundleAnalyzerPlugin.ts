import type { Plugin } from "rolldown";
import { bundleAnalyzerPlugin as rolldownBundleAnalyzerPlugin } from "rolldown/experimental";

export interface BundleAnalyzerPluginOptions {
  /**
   * The filename of the bundle analysis data.
   * @default "analyze-data.md"
   */
  readonly fileName?: string;
  /**
   * The format of the bundle analysis data.
   * @default "md"
   */
  readonly format?: "json" | "md";
}

/**
 * Wraps rolldown's experimental bundle analyzer plugin, which emits a report
 * describing the composition of the bundle.
 *
 * The report includes:
 * - all chunks and their relationships
 * - the modules bundled into each chunk
 * - import dependencies between chunks
 * - the modules reachable from each entry point
 */
export const bundleAnalyzerPlugin = (
  options: BundleAnalyzerPluginOptions = {},
): Plugin =>
  rolldownBundleAnalyzerPlugin({
    fileName: options.fileName,
    format: options.format ?? "md",
  });
