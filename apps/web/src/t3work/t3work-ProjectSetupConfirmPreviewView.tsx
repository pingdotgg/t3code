import { useMemo } from "react";

import type { T3WorkProfile } from "@t3tools/t3work-skill-packs";

import { buildT3workProjectSetupConfirmPreview } from "~/t3work/t3work-projectSetupConfirmPreview";

export function T3workProjectSetupConfirmPreviewView({
  profileId,
  customProfile,
}: {
  readonly profileId: string;
  readonly customProfile?: T3WorkProfile;
}) {
  const preview = useMemo(
    () =>
      buildT3workProjectSetupConfirmPreview({
        profileId,
        ...(customProfile ? { customProfile } : {}),
      }),
    [profileId, customProfile],
  );

  return (
    <div className="space-y-4 rounded-2xl border border-border/65 bg-muted/15 p-4">
      <div className="space-y-1">
        <h4 className="text-sm font-semibold">Setup preview</h4>
        <p className="text-xs text-muted-foreground">
          Skill packs and starter recipes ranked from profile preferences — not profile id alone.
        </p>
      </div>

      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">Enabled skill packs</div>
        <div className="flex flex-wrap gap-2">
          {preview.skillPacks.map((pack) => (
            <span
              key={pack.id}
              className="rounded-full border border-border/70 bg-background/80 px-2.5 py-1 text-xs font-medium"
            >
              {pack.title}
            </span>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">
          Top recipes for this profile
        </div>
        <ul className="space-y-2">
          {preview.topRecipes.map((recipe) => (
            <li
              key={recipe.id}
              className="rounded-lg border border-border/60 bg-background/60 px-3 py-2"
            >
              <div className="text-sm font-medium">{recipe.title}</div>
              <div className="text-xs text-muted-foreground">{recipe.reason}</div>
            </li>
          ))}
        </ul>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Mutation safety: project setup writes managed files with refresh hashes; local edits are
        preserved unless you choose to overwrite.
      </p>
    </div>
  );
}
