import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { getProviderSkillsForSlashMenu } from "@t3tools/client-runtime/providerSkills";
import type { EnvironmentId } from "@t3tools/contracts";
import { useContext, useState } from "react";

import { type ReviewTemplate, SYSTEM_TEMPLATE } from "../domain/reviewTemplate";
import { reviewTemplatesAtom, saveReviewTemplates } from "../state/reviews";
import { serverEnvironment } from "../state/server";
import { buttonClass } from "./controls/buttonClass";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";
import { TemplateEditor } from "./TemplateEditor";

const summary = (template: ReviewTemplate) =>
  `Author checks: ${template.authorChecks.join(", ") || "none"}. Lanes: ${template.lanes.map((lane) => lane.skill).join(", ") || "none"}.`;

/** The review templates: the system one, and the ones built here, which each board can pick from its orchestrator card. */
export function ReviewsPage({ environmentId }: { environmentId: EnvironmentId }) {
  const registry = useContext(RegistryContext);
  const custom = useAtomValue(reviewTemplatesAtom);
  const providers = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.providers;
  const skills = getProviderSkillsForSlashMenu(
    (providers ?? [])
      .filter((provider) => provider.driver === "claudeAgent")
      .flatMap((provider) => provider.skills),
    true,
  )
    .map((skill) => skill.name)
    .toSorted();
  const [editing, setEditing] = useState<{ readonly start: ReviewTemplate | null } | null>(null);
  const save = (template: ReviewTemplate) => {
    void saveReviewTemplates(registry, [...custom, template]);
    setEditing(null);
  };

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection
        title="Review templates"
        note="Every ticket runs its board's template with the review-loop skill's rules: a finding bar, fix rounds, and a question to you after two fix rounds with findings left."
      >
        {[SYSTEM_TEMPLATE, ...custom].map((template) => (
          <SettingsRow
            key={template.name}
            title={template.name}
            description={summary(template)}
            control={
              <span className="flex items-center gap-2">
                {template === SYSTEM_TEMPLATE && <span className="text-xs text-faint">System</span>}
                <button
                  type="button"
                  aria-label={`Duplicate ${template.name}`}
                  onClick={() => setEditing({ start: template })}
                  className={buttonClass}
                >
                  Duplicate
                </button>
                {template !== SYSTEM_TEMPLATE && (
                  <button
                    type="button"
                    aria-label={`Delete ${template.name}`}
                    onClick={() =>
                      void saveReviewTemplates(
                        registry,
                        custom.filter((entry) => entry !== template),
                      )
                    }
                    className={buttonClass}
                  >
                    Delete
                  </button>
                )}
              </span>
            }
          />
        ))}
        {editing === null ? (
          <div className="px-3 py-2.5">
            <button
              type="button"
              onClick={() => setEditing({ start: null })}
              className={buttonClass}
            >
              New template
            </button>
          </div>
        ) : (
          <TemplateEditor
            key={editing.start?.name ?? ""}
            start={editing.start}
            taken={[SYSTEM_TEMPLATE, ...custom].map((template) => template.name)}
            skills={skills}
            onSave={save}
            onCancel={() => setEditing(null)}
          />
        )}
      </SettingsSection>
    </div>
  );
}
