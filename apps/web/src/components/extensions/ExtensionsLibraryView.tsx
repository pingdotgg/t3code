// Fork: Kaluwa's Extensions page. The shared skill library and the skills still outside it.
import { T, useGT, Var } from "gt-react";
import { LibraryIcon, PlusIcon } from "lucide-react";

import { Button } from "../ui/button";
import { ExtensionActions } from "./ExtensionActions";
import { useExtensions } from "./extensionsContext";
import { ExtensionsMatrix, MatrixLegend } from "./ExtensionsMatrix";
import { BrokenLinksRow } from "./ExtensionsBrokenLinks";
import { brokenSkillLinks, entryMatchesSearch, supportingSubscriptions } from "./extensionsModel";
import {
  EntryTitle,
  HealthStatus,
  KindIcon,
  SectionCard,
  SubscriptionIcon,
} from "./extensionsParts";

export function ExtensionsLibraryView() {
  const gt = useGT();
  const { list, entries, search, openAdd, openDetail } = useExtensions();
  const columns = supportingSubscriptions(list.subscriptions, "skill");
  const skills = entries.filter(
    (entry) => entry.kind === "skill" && entryMatchesSearch(entry, search),
  );
  const library = skills.filter((entry) => entry.inLibrary);
  const broken = list.subscriptions.filter(
    (subscription) => brokenSkillLinks(subscription).length > 0,
  );
  const local = skills.flatMap((entry) =>
    columns.flatMap((subscription) => {
      const presence = entry.presence.get(subscription.instanceId);
      return presence?.skillSource === "local" ? [{ entry, subscription, presence }] : [];
    }),
  );

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <span className="flex min-w-48 flex-1 items-start gap-3">
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground"
          >
            <LibraryIcon className="size-4" />
          </span>
          <span className="flex min-w-0 flex-col gap-1">
            <h1 className="text-lg font-semibold">
              <T>Skill library</T>
            </h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              <T>
                One copy of each skill lives in{" "}
                <code className="font-mono text-xs">
                  <Var>{list.library.path}</Var>
                </code>{" "}
                and is linked into the subscriptions you choose. Edit it once and every linked
                subscription gets the change.
              </T>
            </p>
          </span>
        </span>
        <Button size="sm" onClick={() => openAdd({ kind: "skill" })}>
          <PlusIcon />
          <T>Link a skill</T>
        </Button>
      </header>

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="flex items-baseline gap-2 text-sm font-semibold">
            <T>In the library</T>
            <span className="text-xs font-normal text-muted-foreground tabular-nums">
              {library.length}
            </span>
          </h2>
          <span className="text-xs text-muted-foreground">
            <T>Click a cell to link or unlink</T>
          </span>
        </div>
        {columns.length === 0 ? (
          <p className="rounded-lg border px-3 py-4 text-center text-sm text-muted-foreground">
            <T>None of your subscriptions use skills.</T>
          </p>
        ) : library.length === 0 ? (
          <p className="rounded-lg border px-3 py-4 text-center text-sm text-muted-foreground">
            {search.trim() !== ""
              ? gt("Nothing matches your search.")
              : gt("The library is empty. Move a skill into it below to share it.")}
          </p>
        ) : (
          <ExtensionsMatrix
            groups={[{ label: "", entries: library }]}
            columns={columns}
            nameHeading={gt("Skill")}
            presentClick="unlink"
          />
        )}
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="flex items-baseline gap-2 text-sm font-semibold">
            <T>Own copies, not linked to the library</T>
            <span className="text-xs font-normal text-muted-foreground tabular-nums">
              {local.length}
            </span>
          </h2>
          <span className="text-xs text-muted-foreground">
            <T>Each is a folder only that subscription reads</T>
          </span>
        </div>
        {local.length === 0 ? (
          <p className="rounded-lg border px-3 py-4 text-center text-sm text-muted-foreground">
            <T>None. Every skill here is a link to the library.</T>
          </p>
        ) : (
          <SectionCard>
            {local.map(({ entry, subscription, presence }) => (
              <div
                key={`${subscription.instanceId}:${entry.key}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5"
              >
                <button
                  type="button"
                  className="flex min-w-48 flex-1 cursor-pointer items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  onClick={() => openDetail(entry.key)}
                >
                  <KindIcon entry={entry} />
                  <EntryTitle entry={entry} presence={presence}>
                    <SubscriptionIcon subscription={subscription} size="compact" />
                    <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                      {presence.location}
                    </span>
                  </EntryTitle>
                </button>
                <HealthStatus entry={entry} presence={presence} className="w-24 shrink-0" />
                <ExtensionActions entry={entry} subscription={subscription} />
              </div>
            ))}
          </SectionCard>
        )}
      </section>
      {broken.length > 0 ? (
        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-sm font-semibold">
              <T>Broken links</T>
            </h2>
            <span className="text-xs text-muted-foreground">
              <T>Links to skills that are gone. Removing them deletes nothing else.</T>
            </span>
          </div>
          <SectionCard>
            {broken.map((subscription) => (
              <BrokenLinksRow
                key={subscription.instanceId}
                subscription={subscription}
                lead={<SubscriptionIcon subscription={subscription} size="compact" />}
              />
            ))}
          </SectionCard>
        </section>
      ) : null}
      <MatrixLegend linking />
    </div>
  );
}
