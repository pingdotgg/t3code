import type { BrowserImportSource } from "@t3tools/contracts";
import { BROWSER_IMPORT_FAILURE_COPY } from "@t3tools/contracts";
import { useRef, useState } from "react";

import { randomUUID } from "~/lib/utils";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Spinner } from "../ui/spinner";
import {
  initialWizardStep,
  isRetryableReason,
  outcomeToStep,
  refreshedSourceStep,
  type ImportOutcome,
  type WizardStep,
} from "./browserImportWizard.logic";

/** A profile the import can land in. */
export interface WizardTargetProfile {
  readonly id: string;
  readonly name: string;
}

/** The target the user picked: a brand-new profile, or an existing one. */
export type WizardTarget =
  | { readonly kind: "new"; readonly profileId: string }
  | { readonly kind: "existing"; readonly profileId: string; readonly name: string };

const NEW_TARGET_VALUE = "new";

interface BrowserImportWizardProps {
  readonly source: BrowserImportSource;
  /** Existing profiles the import can go into. Incognito is excluded upstream. */
  readonly targetProfiles: ReadonlyArray<WizardTargetProfile>;
  /** Whether a new profile can still be created (profile cap). */
  readonly canCreateProfile: boolean;
  /**
   * Runs the import and returns how it went. For a new target the caller only
   * registers the profile once the import succeeds, so a blocked attempt never
   * leaves an empty profile behind.
   */
  readonly onImport: (input: {
    readonly sourceProfileDirectory: string;
    readonly target: WizardTarget;
  }) => Promise<ImportOutcome>;
  /** Re-checks the source's availability after the user quits the browser. */
  readonly onRefreshSource: () => Promise<BrowserImportSource | undefined>;
  readonly onClose: () => void;
}

/**
 * Guides one browser's cookies into a profile.
 *
 * Every state the import can be in — the browser is open, a profile has to be
 * chosen, the read failed — is a screen the user can move forward from, rather
 * than a disabled row that only says no.
 */
export function BrowserImportWizard({
  source: initialSource,
  targetProfiles,
  canCreateProfile,
  onImport,
  onRefreshSource,
  onClose,
}: BrowserImportWizardProps) {
  const [source, setSource] = useState(initialSource);
  const [step, setStep] = useState<WizardStep>(() => initialWizardStep(initialSource));
  const [sourceProfileDirectory, setSourceProfileDirectory] = useState(
    () => initialSource.profiles[0]?.directory ?? "",
  );
  const [target, setTarget] = useState<string>(
    canCreateProfile ? NEW_TARGET_VALUE : (targetProfiles[0]?.id ?? NEW_TARGET_VALUE),
  );
  // Stable across retries so a Full Disk Access round-trip (added on the Safari
  // branch) or a keychain re-approval lands in one profile, not a new one each
  // time.
  const newProfileId = useRef(`profile-${randomUUID()}`);

  const runImport = () => {
    setStep({ step: "importing" });
    const chosen: WizardTarget =
      target === NEW_TARGET_VALUE
        ? { kind: "new", profileId: newProfileId.current }
        : {
            kind: "existing",
            profileId: target,
            name: targetProfiles.find((profile) => profile.id === target)?.name ?? "",
          };
    void onImport({ sourceProfileDirectory, target: chosen })
      .then((outcome) => setStep(outcomeToStep(outcome)))
      .catch(() => setStep({ step: "blocked", reason: "readFailed" }));
  };

  const recheckAfterQuit = () => {
    setStep({ step: "importing" });
    void onRefreshSource()
      .then((refreshed) => {
        if (refreshed) {
          setSource(refreshed);
          setSourceProfileDirectory(refreshed.profiles[0]?.directory ?? sourceProfileDirectory);
        }
        setStep(refreshedSourceStep(refreshed));
      })
      .catch(() => setStep({ step: "blocked", reason: "readFailed" }));
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-md">
        {step.step === "quit" ? (
          <QuitStep source={source} onCancel={onClose} onRechecked={recheckAfterQuit} />
        ) : step.step === "importing" ? (
          <ImportingStep />
        ) : step.step === "done" ? (
          <DoneStep {...step} onClose={onClose} />
        ) : step.step === "blocked" ? (
          <BlockedStep
            source={source}
            reason={step.reason}
            onClose={onClose}
            onRetry={isRetryableReason(step.reason) ? runImport : undefined}
          />
        ) : (
          <ConfigureStep
            source={source}
            targetProfiles={targetProfiles}
            canCreateProfile={canCreateProfile}
            sourceProfileDirectory={sourceProfileDirectory}
            onSourceProfileChange={setSourceProfileDirectory}
            target={target}
            onTargetChange={setTarget}
            onCancel={onClose}
            onImport={runImport}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function QuitStep({
  source,
  onCancel,
  onRechecked,
}: {
  readonly source: BrowserImportSource;
  readonly onCancel: () => void;
  readonly onRechecked: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Quit {source.name} to import</DialogTitle>
        <DialogDescription>
          {source.name} is open, so its cookies can&rsquo;t be read yet. Quit it, then continue.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onRechecked}>I&rsquo;ve quit it</Button>
      </DialogFooter>
    </>
  );
}

function ConfigureStep({
  source,
  targetProfiles,
  canCreateProfile,
  sourceProfileDirectory,
  onSourceProfileChange,
  target,
  onTargetChange,
  onCancel,
  onImport,
}: {
  readonly source: BrowserImportSource;
  readonly targetProfiles: ReadonlyArray<WizardTargetProfile>;
  readonly canCreateProfile: boolean;
  readonly sourceProfileDirectory: string;
  readonly onSourceProfileChange: (directory: string) => void;
  readonly target: string;
  readonly onTargetChange: (target: string) => void;
  readonly onCancel: () => void;
  readonly onImport: () => void;
}) {
  const hasMultipleSourceProfiles = source.profiles.length > 1;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Import from {source.name}</DialogTitle>
        <DialogDescription>
          Copy {source.name}&rsquo;s cookies and logins into a browser profile here.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-5">
        {hasMultipleSourceProfiles ? (
          <section className="space-y-2">
            <p className="text-sm font-medium text-foreground">Which {source.name} profile?</p>
            <RadioGroup value={sourceProfileDirectory} onValueChange={onSourceProfileChange}>
              {source.profiles.map((profile) => (
                <label
                  key={profile.directory}
                  className="flex cursor-pointer items-center gap-2 text-sm text-foreground"
                >
                  <Radio value={profile.directory} />
                  <span className="min-w-0 truncate">{profile.name}</span>
                </label>
              ))}
            </RadioGroup>
          </section>
        ) : null}
        <section className="space-y-2">
          <p className="text-sm font-medium text-foreground">Import into</p>
          <RadioGroup value={target} onValueChange={onTargetChange}>
            {canCreateProfile ? (
              <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                <Radio value={NEW_TARGET_VALUE} />
                <span>New profile</span>
              </label>
            ) : null}
            {targetProfiles.map((profile) => (
              <label
                key={profile.id}
                className="flex cursor-pointer items-center gap-2 text-sm text-foreground"
              >
                <Radio value={profile.id} />
                <span className="min-w-0 truncate">{profile.name}</span>
              </label>
            ))}
          </RadioGroup>
        </section>
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onImport}>Import</Button>
      </DialogFooter>
    </>
  );
}

function ImportingStep() {
  return (
    <DialogPanel className="flex items-center gap-3 py-6">
      <Spinner className="size-4 text-muted-foreground" />
      <span className="text-sm text-muted-foreground">Importing cookies…</span>
    </DialogPanel>
  );
}

function DoneStep({
  imported,
  skipped,
  targetName,
  onClose,
}: {
  readonly imported: number;
  readonly skipped: number;
  readonly targetName: string;
  readonly onClose: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {imported > 0 ? `Imported ${imported} cookies` : "Nothing to import"}
        </DialogTitle>
        <DialogDescription>
          {imported > 0
            ? `Into ${targetName}.${skipped > 0 ? ` ${skipped} couldn't be brought over.` : ""}`
            : "There were no cookies to bring over."}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <DialogClose render={<Button />} onClick={onClose}>
          Done
        </DialogClose>
      </DialogFooter>
    </>
  );
}

function BlockedStep({
  source,
  reason,
  onClose,
  onRetry,
}: {
  readonly source: BrowserImportSource;
  readonly reason: keyof typeof BROWSER_IMPORT_FAILURE_COPY;
  readonly onClose: () => void;
  readonly onRetry: (() => void) | undefined;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Couldn&rsquo;t import from {source.name}</DialogTitle>
        <DialogDescription>{BROWSER_IMPORT_FAILURE_COPY[reason]}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
        {onRetry ? <Button onClick={onRetry}>Try again</Button> : null}
      </DialogFooter>
    </>
  );
}
