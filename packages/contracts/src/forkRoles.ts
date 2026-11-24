import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** A role file's stem. A plain file name, so `<rolesDirectory>/<id>.md` never leaves the directory. */
export const ForkRoleId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
);
export type ForkRoleId = typeof ForkRoleId.Type;

/** One role file, as the sidebar and breadcrumb show it. The brief body stays on the server. */
export const ForkRole = Schema.Struct({
  id: ForkRoleId,
  name: Schema.String,
  /** A lucide icon name from frontmatter. */
  icon: Schema.optional(Schema.String),
  color: Schema.optional(Schema.String),
  /** Absolute path, for the file viewer. */
  path: Schema.String,
});
export type ForkRole = typeof ForkRole.Type;

export const ForkRolesListResult = Schema.Struct({
  /** Null while the roles directory setting is empty. */
  directory: Schema.NullOr(Schema.String),
  roles: Schema.Array(ForkRole),
});
export type ForkRolesListResult = typeof ForkRolesListResult.Type;
