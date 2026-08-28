import type { BrowserImportSource } from "@t3tools/contracts";
import { BROWSER_IMPORT_FAILURE_COPY } from "@t3tools/contracts";
import { ArrowDownIcon, ArrowRightIcon, CheckIcon } from "lucide-react";
import { useRef, useState } from "react";

import { cn, randomUUID } from "~/lib/utils";

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
import { Spinner } from "../ui/spinner";
import {
  initialWizardStep,
  isRetryableReason,
  formatSkippedDomains,
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
      <DialogPopup className="max-w-lg">
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

/** "5,065 cookies", or "no cookies", or nothing when the store is unreadable. */
function cookieCountLabel(count: number | undefined): string | undefined {
  if (count === undefined) return undefined;
  if (count === 0) return "no cookies";
  return `${count.toLocaleString()} ${count === 1 ? "cookie" : "cookies"}`;
}

type ConfigureStepProps = {
  readonly source: BrowserImportSource;
  readonly targetProfiles: ReadonlyArray<WizardTargetProfile>;
  readonly canCreateProfile: boolean;
  readonly sourceProfileDirectory: string;
  readonly onSourceProfileChange: (directory: string) => void;
  readonly target: string;
  readonly onTargetChange: (target: string) => void;
  readonly onCancel: () => void;
  readonly onImport: () => void;
};

// TEMP: an in-dialog layout switcher for comparing directions live — the ui.sh
// picker can't load under the app's CSP. Collapse to the chosen variant and
// delete this switcher before merge.
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
}: ConfigureStepProps) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Import from {source.name}</DialogTitle>
        <DialogDescription>Choose which cookies to import and where to put them.</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {/* Side by side when the dialog has room, stacked when it doesn't. */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
          <section className="flex-1 space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              From
            </p>
            {source.profiles.map((profile) => (
              <SelectableTile
                key={profile.directory}
                selected={sourceProfileDirectory === profile.directory}
                title={profile.name}
                subtitle={cookieCountLabel(profile.cookieCount)}
                onSelect={() => onSourceProfileChange(profile.directory)}
              />
            ))}
          </section>
          <div className="flex shrink-0 items-center justify-center text-muted-foreground">
            <ArrowDownIcon className="size-4 sm:hidden" />
            <ArrowRightIcon className="hidden size-4 sm:block" />
          </div>
          <section className="flex-1 space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Into
            </p>
            {canCreateProfile ? (
              <SelectableTile
                selected={target === NEW_TARGET_VALUE}
                title="New profile"
                subtitle="Created for these cookies"
                onSelect={() => onTargetChange(NEW_TARGET_VALUE)}
              />
            ) : null}
            {targetProfiles.map((profile) => (
              <SelectableTile
                key={profile.id}
                selected={target === profile.id}
                title={profile.name}
                subtitle="Existing profile"
                onSelect={() => onTargetChange(profile.id)}
              />
            ))}
          </section>
        </div>
      </DialogPanel>
      <ConfigureFooter onCancel={onCancel} onImport={onImport} />
    </>
  );
}

/** Shared footer so the step keeps one set of actions. */
function ConfigureFooter({
  onCancel,
  onImport,
}: {
  readonly onCancel: () => void;
  readonly onImport: () => void;
}) {
  return (
    <DialogFooter>
      <Button variant="outline" onClick={onCancel}>
        Cancel
      </Button>
      <Button onClick={onImport}>Import</Button>
    </DialogFooter>
  );
}

/** One selectable option: a name, an optional detail line, and a check. */
function SelectableTile({
  selected,
  title,
  subtitle,
  onSelect,
}: {
  readonly selected: boolean;
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
        selected
          ? "border-primary bg-primary/8"
          : "border-border/60 hover:border-border hover:bg-muted/40",
      )}
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">{title}</span>
        {subtitle ? (
          <span className="block truncate text-xs tabular-nums text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded-full border",
          selected ? "border-primary bg-primary text-primary-foreground" : "border-input",
        )}
      >
        {selected ? <CheckIcon className="size-2.5" /> : null}
      </span>
    </button>
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
  skippedDomains,
  targetName,
  onClose,
}: {
  readonly imported: number;
  readonly skipped: number;
  readonly skippedDomains: ReadonlyArray<string>;
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
            ? `Added to ${targetName}.${skipped > 0 ? ` ${skipped} couldn't be imported.` : ""}`
            : "There were no cookies to import."}
        </DialogDescription>
      </DialogHeader>
      {skippedDomains.length > 0 ? (
        <DialogPanel>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Skipped
          </p>
          <p className="mt-1 text-sm text-foreground">{formatSkippedDomains(skippedDomains)}</p>
        </DialogPanel>
      ) : null}
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
