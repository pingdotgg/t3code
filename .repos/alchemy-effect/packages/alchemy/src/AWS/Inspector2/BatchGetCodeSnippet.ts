import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:BatchGetCodeSnippet`.
 *
 * Retrieves code snippets from findings that Amazon Inspector detected code vulnerabilities
 * in.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.BatchGetCodeSnippetHttp)`.
 * @binding
 * @section Querying Findings
 * @example Get Code Snippets for Code Findings
 * ```typescript
 * // init
 * const batchGetCodeSnippet = yield* AWS.Inspector2.BatchGetCodeSnippet();
 *
 * // runtime
 * const { codeSnippetResults } = yield* batchGetCodeSnippet({ findingArns: [findingArn] });
 * ```
 */
export interface BatchGetCodeSnippet extends Binding.Service<
  BatchGetCodeSnippet,
  "AWS.Inspector2.BatchGetCodeSnippet",
  () => Effect.Effect<
    (
      request: inspector2.BatchGetCodeSnippetRequest,
    ) => Effect.Effect<
      inspector2.BatchGetCodeSnippetResponse,
      inspector2.BatchGetCodeSnippetError
    >
  >
> {}
export const BatchGetCodeSnippet = Binding.Service<BatchGetCodeSnippet>(
  "AWS.Inspector2.BatchGetCodeSnippet",
);
