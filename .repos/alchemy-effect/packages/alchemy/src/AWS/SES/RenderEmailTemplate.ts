import type * as sesv2 from "@distilled.cloud/aws/sesv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EmailTemplate } from "./EmailTemplate.ts";

/**
 * The `testRenderEmailTemplate` request with the binding-injected
 * `TemplateName` removed — it comes from the bound template.
 */
export interface RenderEmailTemplateRequest extends Omit<
  sesv2.TestRenderEmailTemplateRequest,
  "TemplateName"
> {}

/**
 * Runtime binding for `sesv2:TestRenderEmailTemplate`.
 *
 * Bind this operation to an `EmailTemplate` inside a function runtime to get
 * a callable that renders the template server-side with the given
 * personalization data — useful for previews and for validating template
 * data before a send. The binding grants the function
 * `ses:TestRenderEmailTemplate` scoped to the template.
 * @binding
 * @section Rendering Templates
 * @example Render the Bound Template
 * ```typescript
 * // init
 * const renderTemplate = yield* SES.RenderEmailTemplate(template);
 *
 * // runtime
 * const { RenderedTemplate } = yield* renderTemplate({
 *   TemplateData: JSON.stringify({ name: "Ada" }),
 * });
 * ```
 */
export interface RenderEmailTemplate extends Binding.Service<
  RenderEmailTemplate,
  "AWS.SES.RenderEmailTemplate",
  <T extends EmailTemplate>(
    template: T,
  ) => Effect.Effect<
    (
      request: RenderEmailTemplateRequest,
    ) => Effect.Effect<
      sesv2.TestRenderEmailTemplateResponse,
      sesv2.TestRenderEmailTemplateError
    >
  >
> {}
export const RenderEmailTemplate = Binding.Service<RenderEmailTemplate>(
  "AWS.SES.RenderEmailTemplate",
);
