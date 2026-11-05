import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { useState } from "react";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { errorMessage } from "../CommandPalette.logic";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

const knowledgeAtom = environmentAtomList("web-knowledge-map", (id) =>
  serverEnvironment.knowledgeMap({ environmentId: id, input: {} }),
);
const permissionsAtom = environmentAtomList(
  "web-knowledge-map-permissions",
  serverEnvironment.removeKnowledge.permissionAtom,
);
export function KnowledgeMapSection() {
  const { connectedEnvironments } = useSettingsScope();
  const supported = connectedEnvironments.filter(
    (e) => e.serverConfig?.environment.capabilities.knowledgeMap === true,
  );
  const ids = supported.map((e) => e.environmentId);
  const maps = useAtomValue(knowledgeAtom(environmentIdsKey(ids)));
  const permissions = useAtomValue(permissionsAtom(environmentIdsKey(ids)));
  const remove = useAtomCommand(serverEnvironment.removeKnowledge);
  const [pending, setPending] = useState<string | null>(null);
  if (supported.length === 0) return null;
  return (
    <SettingsSection id="knowledge-map" title="What you know">
      {maps.flatMap((query, index) =>
        query._tag === "Success"
          ? query.value.map((entry) => (
              <SettingsRow
                key={`${ids[index]}-${entry.topic}`}
                {...searchableSetting("knowledge-map")}
                serverScoped
                description={`${entry.explanation} · ${new Date(entry.doneAt).toLocaleDateString()}`}
                status={
                  <Link
                    to="/$environmentId/$threadId"
                    params={{ environmentId: ids[index]!, threadId: entry.threadId }}
                  >
                    Lesson
                  </Link>
                }
                control={
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending === entry.topic || !permissions[index]}
                    onClick={async () => {
                      setPending(entry.topic);
                      await remove({ environmentId: ids[index]!, input: { topic: entry.topic } });
                      setPending(null);
                    }}
                  >
                    Remove
                  </Button>
                }
              />
            ))
          : [],
      )}
      {maps.flatMap((query, index) =>
        query._tag === "Failure" ? (
          <SettingsRow
            key={`${ids[index]}-error`}
            {...searchableSetting("knowledge-map")}
            serverScoped
            description={`Couldn't load What you know: ${errorMessage(Cause.squash(query.cause))}`}
          />
        ) : (
          []
        ),
      )}
      {maps.every((query) => query._tag === "Success" && query.value.length === 0) ? (
        <SettingsRow
          {...searchableSetting("knowledge-map")}
          serverScoped
          description={'Nothing yet. In any lesson, say "mark <topic> done" and explain it back.'}
        />
      ) : null}
    </SettingsSection>
  );
}
