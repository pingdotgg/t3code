import {
  DEFAULT_MAX_CONCURRENT_SANDBOXES,
  type BoatSandboxSize,
  type CloudSandboxDriverKind,
} from "@t3tools/contracts";

export type EnvironmentType = "remote" | "ssh" | "cloudSandbox";

const REMOTE_WIZARD_STEPS = ["Type", "Pairing", "Connect"] as const;
const SSH_WIZARD_STEPS = ["Type", "SSH host", "Connect"] as const;
const BOAT_WIZARD_STEPS = ["Type", "Access", "Defaults"] as const;

export interface RemoteDraft {
  readonly host: string;
  readonly pairingCode: string;
}

export interface SshDraft {
  readonly host: string;
  readonly username: string;
  readonly port: string;
}

/**
 * The sandbox steps of the wizard. Access takes the provider API key; Defaults
 * sets what a sandbox gets when this server creates one. The server stores
 * both under one settings profile. No sandbox is created here: threads and
 * agents allocate, a task can override the specs.
 */
export interface CloudSandboxDraft {
  /** The provider picked on the type step; boat today. */
  readonly driverKind: CloudSandboxDriverKind;
  /** API key typed into the access step; empty reuses the stored key. */
  readonly apiKey: string;
  /** The server-side settings profile resolved during access; null until then. */
  readonly profileId: string | null;
  readonly defaultSize: BoatSandboxSize;
  readonly autoStopMinutes: number;
  /** Typed dollars; empty means no monthly limit. */
  readonly monthlyBudgetUsd: string;
  readonly maxConcurrentSandboxes: number;
  /** Saved snapshot to boot from; empty starts from a clean machine. */
  readonly template: string;
}

export interface EnvironmentWizardDraft {
  readonly type: EnvironmentType;
  readonly label: string;
  readonly remote: RemoteDraft;
  readonly ssh: SshDraft;
  readonly cloudSandbox: CloudSandboxDraft;
}

export type WizardNavigation =
  | { readonly kind: "navigate"; readonly step: number }
  | { readonly kind: "blocked"; readonly step: number; readonly error: string };

const DEFAULT_REMOTE_DRAFT: RemoteDraft = {
  host: "",
  pairingCode: "",
};

const DEFAULT_SSH_DRAFT: SshDraft = {
  host: "",
  username: "",
  port: "",
};

const DEFAULT_BOAT_DRAFT: CloudSandboxDraft = {
  driverKind: "boat",
  apiKey: "",
  profileId: null,
  defaultSize: "default",
  autoStopMinutes: 60,
  monthlyBudgetUsd: "",
  maxConcurrentSandboxes: DEFAULT_MAX_CONCURRENT_SANDBOXES,
  template: "",
};

const DEFAULT_WIZARD_DRAFT: EnvironmentWizardDraft = {
  type: "remote",
  label: "",
  remote: DEFAULT_REMOTE_DRAFT,
  ssh: DEFAULT_SSH_DRAFT,
  cloudSandbox: DEFAULT_BOAT_DRAFT,
};

export function getWizardStepsForType(type: EnvironmentType): readonly string[] {
  switch (type) {
    case "remote":
      return REMOTE_WIZARD_STEPS;
    case "ssh":
      return SSH_WIZARD_STEPS;
    case "cloudSandbox":
      return BOAT_WIZARD_STEPS;
  }
}

export function createInitialEnvironmentWizardDraft(
  type: EnvironmentType = "remote",
): EnvironmentWizardDraft {
  return {
    ...DEFAULT_WIZARD_DRAFT,
    type,
    remote: { ...DEFAULT_REMOTE_DRAFT },
    ssh: { ...DEFAULT_SSH_DRAFT },
    cloudSandbox: { ...DEFAULT_BOAT_DRAFT },
  };
}

export interface WizardValidationContext {
  /** Whether the server already stores a key for the picked provider. */
  readonly hasStoredProviderKey?: boolean;
}

function validateEnvironmentWizardStep(
  step: number,
  draft: EnvironmentWizardDraft,
  context: WizardValidationContext,
): string | null {
  if (step === 0) {
    return null;
  }

  if (step === 1) {
    if (draft.type === "remote") {
      if (!draft.remote.host.trim()) {
        return "Host address is required.";
      }
      if (!draft.remote.pairingCode.trim()) {
        return "Pairing code is required.";
      }
      return null;
    }

    if (draft.type === "ssh") {
      if (!draft.ssh.host.trim()) {
        return "SSH host is required.";
      }
      return null;
    }

    if (draft.type === "cloudSandbox") {
      if (draft.cloudSandbox.apiKey.trim()) return null;
      if (context.hasStoredProviderKey) return null;
      return `${cloudDriverDisplayName(draft.cloudSandbox.driverKind)} API key is required.`;
    }
  }

  return null;
}

export function resolveEnvironmentWizardNavigation(
  currentStep: number,
  direction: "next" | "back" | number,
  draft: EnvironmentWizardDraft,
  context: WizardValidationContext = {},
): WizardNavigation {
  const steps = getWizardStepsForType(draft.type);
  const maxStep = steps.length - 1;

  if (direction === "back") {
    return { kind: "navigate", step: Math.max(0, currentStep - 1) };
  }

  const targetStep = typeof direction === "number" ? direction : currentStep + 1;

  if (targetStep <= currentStep) {
    return { kind: "navigate", step: Math.max(0, targetStep) };
  }

  // Validate all intermediate steps up to targetStep
  for (let s = currentStep; s < targetStep; s++) {
    const error = validateEnvironmentWizardStep(s, draft, context);
    if (error !== null) {
      return { kind: "blocked", step: s, error };
    }
  }

  return { kind: "navigate", step: Math.min(maxStep, targetStep) };
}

export function formatEnvironmentDraftTarget(draft: EnvironmentWizardDraft): string {
  switch (draft.type) {
    case "remote":
      return draft.remote.host.trim();
    case "ssh": {
      const { username, host, port } = draft.ssh;
      const cleanHost = host.trim();
      const userPrefix = username.trim() ? `${username.trim()}@` : "";
      const portSuffix = port.trim() && port.trim() !== "22" ? `:${port.trim()}` : "";
      return `${userPrefix}${cleanHost}${portSuffix}`;
    }
    case "cloudSandbox":
      return cloudDriverDisplayName(draft.cloudSandbox.driverKind);
  }
}

export function deriveDefaultEnvironmentLabel(draft: EnvironmentWizardDraft): string {
  if (draft.label.trim()) {
    return draft.label.trim();
  }
  switch (draft.type) {
    case "remote": {
      const host = draft.remote.host.trim();
      return host ? (host.split(":")[0] ?? host) : "Remote";
    }
    case "ssh": {
      return draft.ssh.host.trim() || "SSH Host";
    }
    case "cloudSandbox":
      return cloudDriverDisplayName(draft.cloudSandbox.driverKind);
  }
}

/**
 * A stable profile id from its display name, mirroring the server's
 * [a-zA-Z0-9_-]{1,64} pattern.
 */
export function profileIdFromName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+/, "")
      .slice(0, 64) || "profile"
  );
}

/** The profile name a provider gets when the wizard creates its default. */
export function cloudDriverDisplayName(driverKind: CloudSandboxDriverKind): string {
  switch (driverKind) {
    case "boat":
      return "boat.dev";
    case "daytona":
      return "Daytona";
    case "e2b":
      return "E2B";
    case "modal":
      return "Modal";
    case "custom":
      return "Custom provider";
  }
}
