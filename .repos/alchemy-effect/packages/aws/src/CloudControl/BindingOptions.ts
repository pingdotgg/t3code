import type { PolicyStatement } from "../IAM/Policy.ts";

/**
 * Bind-time options shared by the handler-invoking Cloud Control bindings
 * ({@link CreateResource}, {@link UpdateResource}, {@link DeleteResource},
 * {@link GetResource}, {@link ListResources}).
 */
export interface CloudControlBindingOptions {
  /**
   * Additional IAM policy statements attached to the host alongside the
   * `cloudformation:*Resource` grant.
   *
   * Cloud Control invokes the target resource type's CloudFormation handlers
   * with the caller's credentials, so the host also needs the handler's
   * underlying service permissions — e.g. `ssm:PutParameter` +
   * `ssm:GetParameters` to create an `AWS::SSM::Parameter`. Consult the
   * `handlers` section of the resource type's schema for the exact actions.
   */
  handlerPolicyStatements?: PolicyStatement[];
}
