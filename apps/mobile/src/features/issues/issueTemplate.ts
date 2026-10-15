import type { IssueTemplate, IssueTemplateList } from "@t3tools/contracts";
import type { EnvironmentQueryView } from "../../state/query";
import type { IssueCreateScope } from "./issueList";

type TemplateRead = Pick<EnvironmentQueryView<IssueTemplateList>, "data" | "error" | "isPending">;

export function issueTemplateCatalogRead(scope: IssueCreateScope | null) {
  return scope?.templates
    ? { environmentId: scope.environmentId, input: { ...scope.scope, metadataOnly: true } }
    : null;
}

export function issueTemplateBodyRead(
  scope: IssueCreateScope | null,
  catalog: IssueTemplateList | null,
  templateKey: string,
) {
  const deferred = catalog?.templates.some(
    (template) => template.key === templateKey && template.contentDeferred === true,
  );
  return scope?.templates && deferred
    ? { environmentId: scope.environmentId, input: { ...scope.scope, templateKey } }
    : null;
}

export function selectedIssueTemplate(
  templateKey: string,
  catalog: TemplateRead,
  selected: TemplateRead,
): { template: IssueTemplate | null; blocked: string | null; retry: boolean } {
  const entry = catalog.data?.templates.find((template) => template.key === templateKey);
  if (templateKey === "" || catalog.data === null) {
    return { template: null, blocked: null, retry: false };
  }
  if (!entry) {
    return {
      template: null,
      blocked: "The selected template is no longer available. Choose a template.",
      retry: false,
    };
  }
  if (entry.contentDeferred !== true) return { template: entry, blocked: null, retry: false };
  const loaded = selected.data?.templates.find(
    (template) => template.key === templateKey && template.contentDeferred !== true,
  );
  if (loaded) return { template: loaded, blocked: null, retry: false };
  if (selected.isPending || (selected.data === null && selected.error === null)) {
    return { template: null, blocked: "Loading template…", retry: false };
  }
  return { template: null, blocked: "The selected template could not be read.", retry: true };
}

export function fillIssueTemplate(
  draft: { readonly title: boolean; readonly body: boolean },
  template: IssueTemplate,
  form: { readonly title: string; readonly body: string },
) {
  return {
    title: draft.title ? template.title : form.title,
    body: draft.body ? template.body : form.body,
    labels: template.labels,
    assignees: template.assignees,
  };
}
