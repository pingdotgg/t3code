import { useMemo, useState } from "react";
import {
  cloneBundledT3WorkProfile,
  isBundledT3WorkProfileId,
  listT3WorkProfiles,
  type T3WorkProfile,
} from "@t3tools/t3work-skill-packs";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

export function T3workCloneProjectSetupProfileDialog({
  sourceProfileId,
  onClone,
}: {
  readonly sourceProfileId: string;
  readonly onClone: (profile: T3WorkProfile) => void;
}) {
  const bundledProfiles = useMemo(() => listT3WorkProfiles(), []);
  const [open, setOpen] = useState(false);
  const [starterId, setStarterId] = useState(
    isBundledT3WorkProfileId(sourceProfileId) ? sourceProfileId : "product-partner",
  );
  const [customId, setCustomId] = useState("");
  const [title, setTitle] = useState("");

  const canClone =
    customId.trim().length > 0 &&
    !isBundledT3WorkProfileId(customId.trim()) &&
    isBundledT3WorkProfileId(starterId);

  const handleClone = () => {
    if (!canClone) return;
    const nextId = customId.trim();
    const nextTitle =
      title.trim() || `${bundledProfiles.find((p) => p.id === starterId)?.title} (custom)`;
    const cloned = cloneBundledT3WorkProfile(starterId, nextId, { title: nextTitle });
    onClone(cloned);
    setOpen(false);
    setCustomId("");
    setTitle("");
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button type="button" variant="outline" size="sm" />}>
        Clone starter profile
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Clone starter profile</DialogTitle>
          <DialogDescription>
            Create a project-local profile from a bundled starter. It is saved under
            .t3work/setup/profiles when the project workspace is created.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="clone-starter-profile">Starter profile</Label>
            <Select value={starterId} onValueChange={(value) => value && setStarterId(value)}>
              <SelectTrigger id="clone-starter-profile" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {bundledProfiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="clone-custom-id">Custom profile id</Label>
            <Input
              id="clone-custom-id"
              value={customId}
              onChange={(event) => setCustomId(event.target.value)}
              placeholder="my-team-partner"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="clone-custom-title">Display title (optional)</Label>
            <Input
              id="clone-custom-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="My Team Partner"
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!canClone} onClick={handleClone}>
            Use cloned profile
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
