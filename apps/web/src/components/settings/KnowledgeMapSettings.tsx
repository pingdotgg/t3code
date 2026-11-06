import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { useRef, useState } from "react";
import { observeIntersection } from "../../lib/observeIntersection";
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
  const reportFeatureUsed = useAtomCommand(serverEnvironment.reportFeatureUsed, {
    reportFailure: false,
    reportDefect: false,
  });
  // knowledge.list runs on every Settings → Threads visit, so a view is the section on screen.
  const viewed = useRef(false);
  const observeView = (element: HTMLDivElement) =>
    observeIntersection(element, (entry) => {
      if (!entry.isIntersecting || viewed.current) return;
      viewed.current = true;
      for (const environmentId of ids) {
        void reportFeatureUsed({ environmentId, input: { feature: "knowledge_map.view" } });
      }
    });
  if (supported.length === 0) return null;
  return (
    <div ref={observeView}>
      <SettingsSection id="knowledge-map" title="What you know">
        <SettingsRow
          {...searchableSetting("knowledge-map")}
          serverScoped
          description={
            maps.every((query) => query._tag === "Success" && query.value.length === 0)
              ? 'Nothing yet. In any lesson, say "mark <topic> done" and explain it back.'
              : "Topics you explained back in a lesson. Lessons start from here."
          }
        />
        {maps.flatMap((query, index) =>
          query._tag === "Failure" ? (
            <SettingsRow
              key={`${ids[index]}-error`}
              title="Couldn't load"
              serverScoped
              description={errorMessage(Cause.squash(query.cause))}
            />
          ) : query._tag === "Success" ? (
            query.value.map((entry) => (
              <SettingsRow
                key={`${ids[index]}-${entry.topic}`}
                title={entry.topic}
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
          ) : (
            []
          ),
        )}
      </SettingsSection>
    </div>
  );
}
