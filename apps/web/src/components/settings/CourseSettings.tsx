import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { useState } from "react";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { ensureLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { errorMessage } from "../CommandPalette.logic";
import { Button } from "../ui/button";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
const coursesAtom = environmentAtomList("server-courses", (id) =>
  serverEnvironment.courses({ environmentId: id, input: {} }),
);
const removePermissionsAtom = environmentAtomList(
  "server-course-remove-permissions",
  serverEnvironment.removeCourse.permissionAtom,
);
const clearPermissionsAtom = environmentAtomList(
  "server-course-visuals-permissions",
  serverEnvironment.clearVisuals.permissionAtom,
);
export function CourseSettingsSection() {
  const { connectedEnvironments } = useSettingsScope();
  const supported = connectedEnvironments.filter(
    (e) => e.serverConfig?.environment.capabilities.courses === true,
  );
  const ids = supported.map((e) => e.environmentId);
  const courses = useAtomValue(coursesAtom(environmentIdsKey(ids)));
  const removePermissions = useAtomValue(removePermissionsAtom(environmentIdsKey(ids)));
  const clearPermissions = useAtomValue(clearPermissionsAtom(environmentIdsKey(ids)));
  const remove = useAtomCommand(serverEnvironment.removeCourse);
  const clearVisuals = useAtomCommand(serverEnvironment.clearVisuals);
  const [pending, setPending] = useState<string | null>(null);
  const [cleared, setCleared] = useState<number | null>(null);
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  if (!supported.length) return null;
  return (
    <SettingsSection id="courses" title="Courses">
      <SettingsRow
        {...searchableSetting("courses")}
        serverScoped
        description="Follow a course in a lesson; prepared plans and quizzes stay on this environment."
      />
      <SettingsRow
        serverScoped
        settingKeys={["courseYtDlp"]}
        title="Fetch YouTube captions with yt-dlp"
        description="OCW courses and PDFs don't need it."
        control={
          <ScopedSwitch
            settingKeys={["courseYtDlp"]}
            checked={settings.courseYtDlp}
            onCheckedChange={(checked) => updateSettings({ courseYtDlp: Boolean(checked) })}
            aria-label="Fetch YouTube captions with yt-dlp"
          />
        }
      />
      <SettingsRow
        serverScoped
        title="Cached clips"
        description={
          cleared === null
            ? "Remove prepared animation clips cached on this environment."
            : `Cleared ${cleared} cached ${cleared === 1 ? "clip" : "clips"}.`
        }
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={pending === ":clips" || !clearPermissions.some(Boolean)}
            onClick={async () => {
              const confirmed = await ensureLocalApi().dialogs.confirm(
                "Clear all cached clips? Lessons render them again when needed.",
                { variant: "destructive" },
              );
              if (!confirmed) return;
              setPending(":clips");
              let total = 0;
              for (const [index, environmentId] of ids.entries()) {
                if (!clearPermissions[index]) continue;
                const result = await clearVisuals({ environmentId, input: {} });
                if (result._tag === "Success") total += result.value;
              }
              setCleared(total);
              setPending(null);
            }}
          >
            Clear cached clips
          </Button>
        }
      />
      {courses.flatMap((query, i) =>
        query._tag === "Failure" ? (
          <SettingsRow
            key={`${ids[i]}-error`}
            title="Couldn't load courses"
            serverScoped
            description={errorMessage(Cause.squash(query.cause))}
          />
        ) : query._tag === "Success" ? (
          query.value.map((course) => (
            <SettingsRow
              key={`${ids[i]}-${course.id}`}
              serverScoped
              title={course.title}
              description={`${course.kind} · ${course.unitCount} units`}
              control={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending === `${ids[i]}:${course.id}` || !removePermissions[i]}
                  onClick={async () => {
                    const confirmed = await ensureLocalApi().dialogs.confirm(
                      `Remove ${course.title}? Its prepared plans and quizzes are deleted; cached clips stay.`,
                      { variant: "destructive" },
                    );
                    if (!confirmed) return;
                    setPending(`${ids[i]}:${course.id}`);
                    await remove({ environmentId: ids[i]!, input: { id: course.id } });
                    setPending(null);
                  }}
                >
                  Remove
                </Button>
              }
            />
          ))
        ) : (
          []
        ),
      )}
    </SettingsSection>
  );
}
