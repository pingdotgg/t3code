// oxlint-disable t3code/no-global-process-runtime -- Electron main owns the native process lifecycle.
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Electron's main-process lifecycle,
// tiny local companion configuration, and development-only diagnostic timestamps are imperative
// native boundaries.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers";
import * as NodeTimersPromises from "node:timers/promises";
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  Notification,
  screen,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from "electron";

import { canStartCapture, queuedBubbleCaptureEvent } from "./bubble-state.ts";
import {
  getCompanionProjectCatalog,
  getCompanionProviderCatalog,
  getCompanionEnvironmentDescriptor,
  manageCompanionProjectAlias,
  pairCompanionHost,
  submitCompanionTask,
  type CompanionModelSelection,
  type CompanionProjectTarget,
  type HostFetch,
} from "./host.ts";
import { resolveCompanionLaunch, shouldInstallCompanionVoiceHotkey } from "./launch.ts";
import { resolveCompanionTrayIconPath } from "./tray-icon.ts";
import {
  companionDevelopmentDiagnosticRecord,
  companionDevelopmentReport,
  resolveCompanionDevelopmentLaunch,
  type CompanionDevelopmentStage,
} from "./development.ts";
import {
  nativeSpeechInterruptPolicy,
  disposeNativeSpeech,
  interruptNativeSpeech,
  isNativeSpeechActive,
  isNativeSpeechReady,
  parakeetModelPaths,
  playNativeCue,
  prepareNativeMicrophone,
  prepareNativeSpeech,
  prepareParakeetRecognition,
  reserveNativeSpeech,
  setNativeSpeechRetention,
  speakNativeSpeech,
  startParakeetCapture,
  classifyVoiceCaptureError,
  type ParakeetCapture,
  type NativeSpeechInterruptSource,
} from "@t3tools/jarvis-native-voice";
import {
  setupWindowBounds,
  voiceOverlayActions,
  voiceOverlayAutoHideDelay,
  voiceOverlaySpeechGraceDelay,
  voiceOverlayBounds,
  voiceOverlaySizeForStatus,
} from "./voice-overlay.ts";
import {
  normalizeCompanionProviders,
  readyCompanionProviders,
  validateCompanionDefault,
  type CompanionProvider,
} from "./provider-defaults.ts";
import { companionRecognitionScenario } from "./recognition-evaluation.ts";
import {
  companionOriginInteractionIdArgument,
  companionOriginNodeIdForInstallation,
} from "./origin-interaction.ts";
import { attachPushToTalkHook, type PushToTalkHook } from "./push-to-talk.ts";
import {
  parseCompanionConversationMode,
  parseCompanionSettings,
  companionNodes,
  pairCompanionNode,
  removeCompanionNode,
  refreshCompanionNode,
  selectedCompanionNode,
  type CompanionNode,
  withoutCompanionDefault,
  withoutCompanionProject,
  withCompanionConversationMode,
  withCompanionAttentionTarget,
  withCompanionDefault,
  withCompanionOriginInteractionId,
  withCompanionPendingSubmission,
  withoutCompanionPendingSubmission,
  withCompanionProject,
  type CompanionConversationMode,
  type CompanionSettings,
  type CompanionPendingSubmission,
} from "./settings.ts";
import { isTrustedRelayNavigation } from "./relay-security.ts";
import { electronCompanionUpdater } from "./updates-electron.ts";
import {
  companionUpdateMenuItem,
  configureCompanionUpdates,
  type CompanionUpdateController,
  type CompanionUpdateState,
} from "./updates.ts";
import {
  applyCompanionRecognitionVocabulary,
  canonicalizeCompanionTranscript,
  companionContinuationTarget,
  companionTranscriptHasProjectCue,
  explicitlyStartsNewCompanionTask,
  companionProjectChoiceLabel,
  companionProjectKey,
  resolveCompanionProjectTarget,
  type CompanionRecognitionTerm,
} from "./voice-routing.ts";
import {
  jarvisPresentationStateByKind,
  jarvisPresentationStateForKind,
  type JarvisPresentationState,
} from "./voice-presentation.ts";
import { disposeCompanionLocalRuntime } from "./runtime-lifecycle.ts";
import {
  reportConnectionPresentation,
  type CompanionReportConnection,
} from "./report-connection.ts";
import { companionPresentationStyle } from "./companion-presentation.ts";
import { companionWebglScript } from "./companion-webgl.ts";
import { safeInlineJson } from "./inline-json.ts";
import { managedStatusLine } from "./managed-status.ts";
import {
  resolveCompanionStartupProbePath,
  writeCompanionStartupReceipt,
} from "./companion-startup-probe.ts";

const APP_NAME = "Jarvis Companion";
const packagedSpeechSmoke = app.isPackaged && process.argv.includes("--speech-smoke");
const packagedStartupSmoke = app.isPackaged && process.argv.includes("--startup-smoke");
// Jarvis Full-node owns the visible workspace and lifecycle. This flag is a
// deliberately small helper seam until the desktop bridge supplies speech and
// task IPC; managed launch must never fall back to standalone setup UI.
const managedCompanionLaunch = process.argv.includes("--jarvis-managed");
const managedPairingUrl = (() => {
  if (!managedCompanionLaunch) return null;
  try {
    // The managed desktop bridge hands a one-shot URL through stdin. Keep the
    // read bounded and deliberately avoid argv, where process inspection tools
    // would expose the pairing token.
    const value = NodeFS.readFileSync(0, "utf8").slice(0, 4096).trim();
    return value.length > 0 && !value.includes("\u0000") ? value : null;
  } catch {
    return null;
  }
})();
const developmentLaunch = resolveCompanionDevelopmentLaunch(process.argv, {
  packaged: app.isPackaged,
});
if (developmentLaunch.dataDir !== undefined) {
  app.setPath("userData", NodePath.resolve(developmentLaunch.dataDir));
}
const PAIR_CHANNEL = "jarvis-companion:pair";
const SPEAK_CHANNEL = "jarvis-companion:speak";
const PREPARE_SPEECH_CHANNEL = "jarvis-companion:prepare-speech";
const INTERRUPT_SPEECH_CHANNEL = "jarvis-companion:interrupt-speech";
const SUBMIT_TRANSCRIPT_CHANNEL = "jarvis-companion:submit-transcript";
const CAPTURE_START_CHANNEL = "jarvis-companion:capture-start";
const CAPTURE_STOP_CHANNEL = "jarvis-companion:capture-stop";
const BUBBLE_READY_CHANNEL = "jarvis-companion:bubble-ready";
const MANAGED_STATUS_CHANNEL = "jarvis-companion:managed-status";
const STATUS_CHANNEL = "jarvis-companion:status";
const FINISH_STATUS_CHANNEL = "jarvis-companion:finish-task-status";
const REPORT_RELAY_STATUS_CHANNEL = "jarvis-companion:report-relay-status";
function relayWindowOptions(originInteractionId: string) {
  return {
    show: false,
    skipTaskbar: true,
    webPreferences: {
      partition: "persist:jarvis-companion",
      preload: NodePath.join(import.meta.dirname, "relay-preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      additionalArguments: [companionOriginInteractionIdArgument(originInteractionId)],
    },
  };
}

const relayWindows = new Map<string, BrowserWindow>();
const relayNodes = new Map<string, CompanionNode>();
let bubbleWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let companionShuttingDown = false;
let capturePending = false;
let bubbleReady = false;
let managedCompanionReady = false;
let capturePhase: "idle" | "listening" | "checking" = "idle";
let captureInFlight = false;
let heldReleaseRequested = false;
let captureTimedOut = false;
let captureNoAudio = false;
let captureTimeout: NodeJS.Timeout | undefined;
let firstAudioFrameTimeout: NodeJS.Timeout | undefined;
let activeParakeetCapture: ParakeetCapture | undefined;
let hideBubbleAbort: AbortController | undefined;
let attentionTarget: CompanionSettings["attentionTarget"];
let companionOriginInteractionId: string | undefined;
let knownProjectTargets = new Map<string, CompanionProjectTarget>();
let knownRecognitionTerms: ReadonlyArray<CompanionRecognitionTerm> = [];
let knownProviderTermsByNode = new Map<string, ReadonlyArray<CompanionRecognitionTerm>>();
let latestRelayStatusIds = new Map<string, string>();
let shortcutRegistered = false;
let hotkeyMode: "hold" | "tap" | "unavailable" = "unavailable";
let detachPushToTalk: (() => void) | undefined;
let reportRelayAvailability = new Map<string, boolean>();
let reportRelayConnections = new Map<string, CompanionReportConnection>();
const reportRelayReadinessWaiters = new Map<string, Set<(ready: boolean) => void>>();
let companionUpdates: CompanionUpdateController | undefined;
let companionUpdateState: CompanionUpdateState = { status: "disabled" };
let surface: "voice" | "setup" | undefined;
type CompanionVoiceStatus = {
  readonly state: string;
  readonly detail: string;
  readonly kind: string;
  readonly presentationState?: JarvisPresentationState;
  readonly context?: string;
  readonly stream?: boolean;
  readonly statusId?: string;
};
let latestBubbleStatus: CompanionVoiceStatus | undefined;
let speechPresentationDepth = 0;
let speechPresentationResume: CompanionVoiceStatus | undefined;
let pendingProjectTask:
  | {
      readonly transcript: string;
      readonly projects: ReadonlyArray<CompanionProjectTarget>;
      readonly nodeId?: string;
      readonly requestId?: string;
      readonly originInteractionId?: string;
      readonly heardAlias?: string;
    }
  | undefined;
let pendingSubmission: CompanionPendingSubmission | undefined;

app.on("before-quit", () => {
  quitting = true;
  companionShuttingDown = true;
  if (captureTimeout !== undefined) {
    NodeTimers.clearTimeout(captureTimeout);
    captureTimeout = undefined;
  }
  if (firstAudioFrameTimeout !== undefined) {
    NodeTimers.clearTimeout(firstAudioFrameTimeout);
    firstAudioFrameTimeout = undefined;
  }
  activeParakeetCapture?.cancel();
  activeParakeetCapture = undefined;
  captureInFlight = false;
  capturePending = false;
});

type CompanionVoiceDefault = {
  readonly node: CompanionNode;
  readonly host: string;
  readonly modelSelection: CompanionModelSelection;
  readonly conversationMode: CompanionConversationMode;
};

const legacyNodeForHost = (host: string): CompanionNode => ({
  nodeId: `legacy-host:${host}`,
  displayName: "Jarvis Host",
  host,
});

function developmentDiagnostic(
  phase: string,
  detail: Readonly<Record<string, string | boolean | number | undefined>> = {},
) {
  if (!developmentLaunch.enabled || developmentLaunch.diagnosticsPath === undefined) return;
  const stage: CompanionDevelopmentStage =
    phase === "transcript-received" ||
    phase === "text-injection" ||
    phase === "recognition-recording" ||
    phase === "recognition-recording-rejected" ||
    phase === "recognition-warm-failed" ||
    phase === "recognition-metrics"
      ? "recognition"
      : phase === "project-catalog" ||
          phase === "project-resolved" ||
          phase === "project-clarification"
        ? "project-resolution"
        : phase === "host-result" || phase === "dispatch-rejected"
          ? "dispatch"
          : phase.startsWith("speech-")
            ? "speech"
            : phase === "report-simulated"
              ? "reporting"
              : "interpretation";
  try {
    NodeFS.mkdirSync(NodePath.dirname(developmentLaunch.diagnosticsPath), { recursive: true });
    NodeFS.appendFileSync(
      developmentLaunch.diagnosticsPath,
      companionDevelopmentDiagnosticRecord({ stage, phase, detail }),
      "utf8",
    );
  } catch {
    // A local diagnostic trace must never block voice capture or task dispatch.
  }
}

function configurationPath() {
  return NodePath.join(app.getPath("userData"), "companion.json");
}

function loadCompanionSettings() {
  const path = configurationPath();
  if (!NodeFS.existsSync(path)) return { host: null };
  try {
    return parseCompanionSettings(JSON.parse(NodeFS.readFileSync(path, "utf8")));
  } catch {
    return { host: null };
  }
}

function saveCompanionSettings(settings: ReturnType<typeof loadCompanionSettings>) {
  const path = configurationPath();
  const temporaryPath = `${path}.next`;
  NodeFS.writeFileSync(temporaryPath, `${JSON.stringify(settings)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  NodeFS.renameSync(temporaryPath, path);
}

/** Generates the per-installation origin once, while keeping host-only files readable. */
function ensureCompanionOriginInteractionId(): string {
  if (companionOriginInteractionId !== undefined) return companionOriginInteractionId;
  const current = loadCompanionSettings();
  const persisted = current.originInteractionId ?? NodeCrypto.randomUUID();
  if (current.originInteractionId === undefined) {
    saveCompanionSettings(withCompanionOriginInteractionId(current, persisted));
  }
  companionOriginInteractionId = persisted;
  return persisted;
}

function rememberAttentionTarget(target: NonNullable<CompanionSettings["attentionTarget"]>) {
  attentionTarget = target;
  saveCompanionSettings(withCompanionAttentionTarget(loadCompanionSettings(), target));
}

function loadSavedHost(): string | null {
  return loadCompanionSettings().host;
}

function loadSavedNode(): CompanionNode | undefined {
  const settings = loadCompanionSettings();
  return (
    selectedCompanionNode(settings) ??
    (settings.host ? legacyNodeForHost(settings.host) : undefined)
  );
}

function loadSavedNodes(): ReadonlyArray<CompanionNode> {
  return companionNodes(loadCompanionSettings());
}

function loadSavedDefault(nodeId?: string): CompanionModelSelection | undefined {
  const settings = loadCompanionSettings();
  if (
    nodeId !== undefined &&
    ((settings.defaultModelNodeId !== undefined && settings.defaultModelNodeId !== nodeId) ||
      (settings.defaultModelNodeId === undefined &&
        selectedCompanionNode(settings)?.nodeId !== nodeId))
  ) {
    return undefined;
  }
  return settings.defaultModelSelection;
}

function loadSavedProject() {
  return loadCompanionSettings().projectTarget;
}

function rememberProjectTargets(projects: ReadonlyArray<CompanionProjectTarget>) {
  for (const project of projects) knownProjectTargets.set(companionProjectKey(project), project);
}

function forgetProjectTargetsForNode(nodeId: string) {
  for (const [key, project] of knownProjectTargets) {
    if (project.nodeId === nodeId) knownProjectTargets.delete(key);
  }
}

function providerRecognitionTerms(
  providers: ReadonlyArray<CompanionProvider>,
): ReadonlyArray<CompanionRecognitionTerm> {
  return providers.flatMap((provider) => [
    {
      canonical: provider.displayName ?? provider.instanceId,
      aliases: [provider.instanceId, provider.displayName ?? ""],
      scope: "provider-routing" as const,
    },
    ...provider.models.map((model) => ({
      canonical: model.shortName ?? model.name,
      aliases: [model.slug, model.name, model.shortName ?? ""],
      scope: "provider-routing" as const,
    })),
  ]);
}

async function refreshNodeRecognitionVocabulary(node: CompanionNode) {
  const [projects, providers] = await Promise.all([
    getCompanionProjectCatalog({
      fetch: hostFetch,
      host: node.host,
      nodeId: node.nodeId,
      nodeLabel: node.displayName,
    }),
    getCompanionProviderCatalog({
      fetch: hostFetch,
      host: node.host,
      nodeId: node.nodeId,
      nodeLabel: node.displayName,
    }),
  ]);
  if (!loadSavedNodes().some((candidate) => candidate.nodeId === node.nodeId)) return;
  if (projects.kind === "ready") {
    forgetProjectTargetsForNode(node.nodeId);
    rememberProjectTargets(projects.projects);
  } else forgetProjectTargetsForNode(node.nodeId);
  if (providers.kind === "ready") {
    knownProviderTermsByNode.set(
      node.nodeId,
      providerRecognitionTerms(normalizeCompanionProviders(providers.providers)),
    );
  } else knownProviderTermsByNode.delete(node.nodeId);
  knownRecognitionTerms = [...knownProviderTermsByNode.values()].flat();
  refreshTrayMenu();
}

async function refreshRecognitionVocabulary() {
  const nodes = loadSavedNodes();
  knownRecognitionTerms = [];
  knownProviderTermsByNode.clear();
  await Promise.all(nodes.map((node) => refreshNodeRecognitionVocabulary(node)));
  refreshTrayMenu();
}

function recognitionTranscript(transcript: string): string {
  return applyCompanionRecognitionVocabulary({
    transcript,
    projects: [...knownProjectTargets.values()],
    terms: knownRecognitionTerms,
  });
}

function updateCachedAlias(projectId: string, alias: string, remove: boolean, nodeId?: string) {
  const key = companionProjectKey({ id: projectId, nodeId });
  const project = knownProjectTargets.get(key);
  if (project === undefined) return;
  const normalized = alias.toLocaleLowerCase("en-US");
  const aliases = (project.aliases ?? []).filter(
    (candidate) => candidate.toLocaleLowerCase("en-US") !== normalized,
  );
  const aliasDetails = (project.aliasDetails ?? []).filter(
    (candidate) => candidate.alias.toLocaleLowerCase("en-US") !== normalized,
  );
  knownProjectTargets.set(companionProjectKey(project), {
    ...project,
    aliases: remove ? aliases : [...aliases, alias],
    aliasDetails: remove
      ? aliasDetails
      : [...aliasDetails, { alias, kind: "confirmed-pronunciation" }],
  });
}

function projectTargetContext(project: CompanionProjectTarget): string {
  return `${project.title}${project.nodeLabel === undefined ? "" : ` on ${project.nodeLabel}`} · ${project.workspaceRoot}`;
}

async function resolveProjectContext(
  projectId: string,
  nodeId?: string,
): Promise<string | undefined> {
  const savedProject = loadSavedProject();
  if (savedProject?.id === projectId && (nodeId === undefined || savedProject.nodeId === nodeId))
    return projectTargetContext(savedProject);
  const knownProject = [...knownProjectTargets.values()].find(
    (project) => project.id === projectId && (nodeId === undefined || project.nodeId === nodeId),
  );
  if (knownProject !== undefined) return projectTargetContext(knownProject);
  const node =
    nodeId === undefined
      ? loadSavedNode()
      : loadSavedNodes().find((candidate) => candidate.nodeId === nodeId);
  if (node === undefined) return undefined;
  const catalog = await getCompanionProjectCatalog({
    fetch: hostFetch,
    host: node.host,
    nodeId: node.nodeId,
    nodeLabel: node.displayName,
  });
  if (
    catalog.kind === "error" ||
    !loadSavedNodes().some((candidate) => candidate.nodeId === node.nodeId)
  ) {
    return undefined;
  }
  rememberProjectTargets(catalog.projects);
  const project = [...knownProjectTargets.values()].find(
    (candidate) =>
      candidate.id === projectId && (nodeId === undefined || candidate.nodeId === nodeId),
  );
  return project === undefined ? undefined : projectTargetContext(project);
}

async function resolveProjectTargetById(
  projectId: string,
  nodeId?: string,
): Promise<CompanionProjectTarget | undefined> {
  const savedProject = loadSavedProject();
  if (savedProject?.id === projectId && (nodeId === undefined || savedProject.nodeId === nodeId)) {
    return savedProject;
  }
  const known = [...knownProjectTargets.values()].find(
    (project) => project.id === projectId && (nodeId === undefined || project.nodeId === nodeId),
  );
  if (known !== undefined) return known;
  const node =
    nodeId === undefined
      ? loadSavedNode()
      : loadSavedNodes().find((item) => item.nodeId === nodeId);
  if (node === undefined) return undefined;
  const catalog = await getCompanionProjectCatalog({
    fetch: hostFetch,
    host: node.host,
    nodeId: node.nodeId,
    nodeLabel: node.displayName,
  });
  if (
    catalog.kind === "error" ||
    !loadSavedNodes().some((candidate) => candidate.nodeId === node.nodeId)
  ) {
    return undefined;
  }
  rememberProjectTargets(catalog.projects);
  return [...knownProjectTargets.values()].find(
    (project) => project.id === projectId && (nodeId === undefined || project.nodeId === nodeId),
  );
}

function loadConversationMode(): CompanionConversationMode {
  return loadCompanionSettings().conversationMode ?? "new-thread";
}

function nodeForProject(project: CompanionProjectTarget): CompanionNode | undefined {
  const nodes = loadSavedNodes();
  return (
    (project.nodeId === undefined
      ? nodes.find((node) => node.host === loadSavedHost())
      : nodes.find((node) => node.nodeId === project.nodeId)) ??
    (project.nodeId === undefined && loadSavedHost() !== null
      ? legacyNodeForHost(loadSavedHost()!)
      : undefined)
  );
}

function savePairedNode(node: CompanionNode) {
  const current = loadCompanionSettings();
  const selected = selectedCompanionNode(current);
  const normalizedCurrent =
    selected === undefined
      ? current
      : {
          ...migrateNodeReferences(current, selected, selected),
          ...(current.defaultModelSelection !== undefined &&
          current.defaultModelNodeId === undefined
            ? { defaultModelNodeId: selected.nodeId }
            : {}),
        };
  const next = pairCompanionNode(normalizedCurrent, node);
  if (normalizedCurrent.host !== next.host) {
    knownProjectTargets.clear();
    knownRecognitionTerms = [];
    knownProviderTermsByNode.clear();
    pendingProjectTask = undefined;
    pendingSubmission = undefined;
  }
  saveCompanionSettings(next);
  if (normalizedCurrent.host !== next.host) {
    saveCompanionSettings(withoutCompanionPendingSubmission(loadCompanionSettings()));
  }
}

function migrateNodeReferences(
  current: CompanionSettings,
  previous: CompanionNode,
  nextNode: CompanionNode,
): CompanionSettings {
  const ownsLegacyReferences = current.host === previous.host;
  const projectTarget =
    current.projectTarget !== undefined &&
    ((ownsLegacyReferences && current.projectTarget.nodeId === undefined) ||
      current.projectTarget.nodeId === previous.nodeId)
      ? { ...current.projectTarget, nodeId: nextNode.nodeId, nodeLabel: nextNode.displayName }
      : current.projectTarget;
  const attention =
    current.attentionTarget !== undefined &&
    ((ownsLegacyReferences && current.attentionTarget.nodeId === undefined) ||
      current.attentionTarget.nodeId === previous.nodeId)
      ? { ...current.attentionTarget, nodeId: nextNode.nodeId }
      : current.attentionTarget;
  const pending =
    current.pendingProjectTask === undefined
      ? undefined
      : {
          ...current.pendingProjectTask,
          ...((ownsLegacyReferences && current.pendingProjectTask.nodeId === undefined) ||
          current.pendingProjectTask.nodeId === previous.nodeId
            ? { nodeId: nextNode.nodeId }
            : {}),
          projects: current.pendingProjectTask.projects.map((project) =>
            (ownsLegacyReferences && project.nodeId === undefined) ||
            project.nodeId === previous.nodeId
              ? { ...project, nodeId: nextNode.nodeId, nodeLabel: nextNode.displayName }
              : project,
          ),
        };
  return {
    ...current,
    ...(projectTarget === undefined ? {} : { projectTarget }),
    ...(current.defaultModelNodeId === previous.nodeId
      ? { defaultModelNodeId: nextNode.nodeId }
      : {}),
    ...(attention === undefined ? {} : { attentionTarget: attention }),
    ...(pending === undefined ? {} : { pendingProjectTask: pending }),
  };
}

async function upgradeLegacyNodeDescriptor(node: CompanionNode) {
  if (!node.nodeId.startsWith("legacy-host:")) return;
  const descriptor = await getCompanionEnvironmentDescriptor({ fetch: hostFetch, host: node.host });
  if (descriptor.kind !== "ready") return;
  const nextNode: CompanionNode = {
    nodeId: descriptor.descriptor.environmentId,
    displayName: descriptor.descriptor.label,
    host: node.host,
  };
  const current = loadCompanionSettings();
  const migrated = migrateNodeReferences(current, node, nextNode);
  saveCompanionSettings(refreshCompanionNode(migrated, nextNode));
  forgetProjectTargetsForNode(node.nodeId);
  disconnectReportRelay(node.nodeId);
  connectReportRelay(nextNode);
  await refreshNodeRecognitionVocabulary(nextNode);
}

async function upgradeLegacyNodeDescriptors() {
  for (const node of loadSavedNodes()) await upgradeLegacyNodeDescriptor(node);
}

function saveDefault(selection: CompanionModelSelection) {
  const node = loadSavedNode();
  saveCompanionSettings(withCompanionDefault(loadCompanionSettings(), selection, node?.nodeId));
}

function savePendingProjectTask(value: typeof pendingProjectTask) {
  const settings = loadCompanionSettings();
  saveCompanionSettings(
    value === undefined
      ? (({ pendingProjectTask: _pendingProjectTask, ...rest }) => rest)(settings)
      : { ...settings, pendingProjectTask: value },
  );
  pendingProjectTask = value;
}

function savePendingSubmission(value: CompanionPendingSubmission | undefined) {
  const current = loadCompanionSettings();
  saveCompanionSettings(
    value === undefined
      ? withoutCompanionPendingSubmission(current)
      : withCompanionPendingSubmission(current, value),
  );
  pendingSubmission = value;
}

function companionModelSelectionsMatch(
  left: CompanionModelSelection | undefined,
  right: CompanionModelSelection | undefined,
): boolean {
  if (left?.instanceId !== right?.instanceId || left?.model !== right?.model) return false;
  const leftOptions = left?.options ?? [];
  const rightOptions = right?.options ?? [];
  return (
    leftOptions.length === rightOptions.length &&
    leftOptions.every((option) =>
      rightOptions.some(
        (candidate) => candidate.id === option.id && candidate.value === option.value,
      ),
    )
  );
}

function saveConversationMode(conversationMode: CompanionConversationMode) {
  saveCompanionSettings(withCompanionConversationMode(loadCompanionSettings(), conversationMode));
}

function saveProject(projectTarget: Parameters<typeof withCompanionProject>[1]) {
  saveCompanionSettings(withCompanionProject(loadCompanionSettings(), projectTarget));
}

function clearSavedDefault() {
  saveCompanionSettings(withoutCompanionDefault(loadCompanionSettings()));
}

function clearRememberedProject() {
  saveCompanionSettings(withoutCompanionProject(loadCompanionSettings()));
}

function companionSession() {
  return session.fromPartition("persist:jarvis-companion");
}

const hostFetch: HostFetch = (input, init) => companionSession().fetch(input, init);

function companionVoiceResourceRoot(): string {
  return app.isPackaged
    ? NodePath.join(process.resourcesPath, "jarvis-resources")
    : NodePath.resolve(app.getAppPath(), "../../packages/jarvis-native-voice/resources");
}

function configureCompanionVoiceResources(): void {
  process.env.JARVIS_POCKET_ROOT = NodePath.join(companionVoiceResourceRoot(), "pocket");
}

function parakeetPaths() {
  const root = NodePath.join(companionVoiceResourceRoot(), "parakeet");
  return { paths: parakeetModelPaths(root) };
}

type DevelopmentRecognitionCapture = {
  readonly captureId: string;
  readonly directory: string;
  readonly scenarioId: string;
};

const developmentRecordingRetention = 20;

function pruneDevelopmentRecordings(root: string) {
  const captures = NodeFS.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = NodePath.join(root, entry.name);
      return { path, modifiedAt: NodeFS.statSync(path).mtimeMs };
    })
    .toSorted((left, right) => right.modifiedAt - left.modifiedAt);
  for (const capture of captures.slice(developmentRecordingRetention)) {
    NodeFS.rmSync(capture.path, { recursive: true, force: true });
  }
}

function developmentRecognitionCapture(): DevelopmentRecognitionCapture | undefined {
  if (
    !developmentLaunch.enabled ||
    developmentLaunch.recordingDir === undefined ||
    developmentLaunch.recognitionScenario === undefined
  ) {
    return undefined;
  }
  const scenario = companionRecognitionScenario(developmentLaunch.recognitionScenario);
  if (scenario === undefined) {
    developmentDiagnostic("recognition-recording-rejected", {
      scenario: developmentLaunch.recognitionScenario,
    });
    return undefined;
  }
  NodeFS.mkdirSync(developmentLaunch.recordingDir, { recursive: true });
  const captureId = NodeCrypto.randomUUID();
  const captureDirectory = NodePath.join(developmentLaunch.recordingDir, captureId);
  NodeFS.mkdirSync(captureDirectory, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(captureDirectory, "scenario.json"),
    `${JSON.stringify({ captureId, scenario }, undefined, 2)}\n`,
    "utf8",
  );
  pruneDevelopmentRecordings(developmentLaunch.recordingDir);
  developmentDiagnostic("recognition-recording", {
    captureId,
    recordingDirectory: captureDirectory,
    scenario: scenario.id,
  });
  return { captureId, directory: captureDirectory, scenarioId: scenario.id };
}

function developmentRecognitionMetrics(
  capture: DevelopmentRecognitionCapture | undefined,
  metrics: {
    readonly engineId: "parakeet-tdt-ctc-110m-int8";
    readonly readyLatencyMs?: number;
    readonly firstTranscriptLatencyMs?: number;
    readonly finalLatencyMs: number;
    readonly cpuTimeMs: number;
    readonly peakRssBytes: number;
    readonly resourceBytes: number;
  },
) {
  developmentDiagnostic("recognition-metrics", {
    ...metrics,
    ...(capture === undefined
      ? {}
      : {
          captureId: capture.captureId,
          recordingDirectory: capture.directory,
          scenario: capture.scenarioId,
        }),
  });
}

function playCue() {
  const root = companionVoiceResourceRoot();
  void playNativeCue(NodePath.join(root, "listening.wav")).catch(() => undefined);
}

function interruptCompanionSpeech(source: Exclude<NativeSpeechInterruptSource, "relay">) {
  const policy = nativeSpeechInterruptPolicy(source);
  if (!policy.accepted) return { accepted: false };
  const wasActive = isNativeSpeechActive();
  interruptNativeSpeech();
  refreshTrayMenu();
  if (wasActive && policy.presentInterrupted) {
    showCompanionStatus({
      state: "I’ll stop there",
      detail: "Say the next thing whenever you are ready.",
      kind: "interrupted",
    });
  }
  return { accepted: wasActive };
}

async function speakCompanionSpeech(text: string) {
  if (speechPresentationDepth === 0) speechPresentationResume = latestBubbleStatus;
  speechPresentationDepth += 1;
  showCompanionStatus({
    state: "Speaking",
    detail: text,
    kind: "speaking",
  });
  const pending = speakNativeSpeech(text);
  refreshTrayMenu();
  try {
    await pending;
  } finally {
    speechPresentationDepth = Math.max(0, speechPresentationDepth - 1);
    if (speechPresentationDepth === 0) {
      const resume = speechPresentationResume;
      speechPresentationResume = undefined;
      if (latestBubbleStatus?.kind === "speaking") {
        showCompanionStatus(
          resume ?? {
            state: "Ready when you are",
            detail: "Hold the shortcut and tell me what you need.",
            kind: "ready",
          },
        );
      }
    }
    refreshTrayMenu();
  }
}

const companionSpeechFailureFallback =
  "Voice test could not start. Check your audio output and try again.";

function companionSpeechFailureMessage(cause: unknown): string {
  const detail =
    cause instanceof Error ? cause.message.replace(/\s+/g, " ").trim().slice(0, 240) : "";
  return detail.length === 0
    ? companionSpeechFailureFallback
    : `Voice test could not start: ${detail}`;
}

/** Setup copy is normalized before the data URL is created, never after render. */
function canonicalSetupSurface(surface: "voice" | "setup", value: string): string {
  const replacements: ReadonlyArray<readonly [string, string]> = [
    ["REQUEST DEFAULTS", "Agent defaults"],
    [
      "Choose what the laptop should use when this PC sends a spoken task.",
      "Choose the agent used for spoken tasks. Project names can be said naturally in your request.",
    ],
    ["Open Jarvis Host", "Open workspace in browser"],
    [
      "Finish provider setup on the laptop, then reopen this panel. This PC only records and relays your request.",
      "Finish provider setup on the Host, then reopen this panel. This PC sends your request to that workspace.",
    ],
    ["Open host settings", "Open workspace in browser"],
    ["PAIR THIS PC", "Connect this PC"],
    ["Minimize to tray", "Keep running in the tray"],
    [
      "Open Jarvis Host from the companion tray menu.",
      "Open the Jarvis workspace from the tray menu.",
    ],
  ];
  if (surface !== "setup") return value;
  return replacements.reduce((markup, [from, to]) => markup.replaceAll(from, to), value);
}

function bubblePage(nextSurface: "voice" | "setup") {
  const configured = loadSavedHost() !== null;
  const host = loadSavedHost() ?? "";
  const nodeLabel =
    (host === "" ? undefined : loadSavedNodes().find((node) => node.host === host)?.displayName) ??
    "Jarvis Host";
  const initialSetup = safeInlineJson({ configured, host, nodeLabel });
  const voicePresentationKindMap = safeInlineJson(jarvisPresentationStateByKind);
  const voicePresentationScript =
    nextSurface === "voice"
      ? `const presentationStateByKind=${voicePresentationKindMap};document.body.dataset.presentationState='idle';window.addEventListener('t3code:jarvis-capture-start',()=>{document.body.dataset.presentationState='listening'});window.addEventListener('t3code:jarvis-capture-stop',()=>{document.body.dataset.presentationState='transcribing'});window.addEventListener('t3code:jarvis-status',event=>{const next=event.detail||{};document.body.dataset.presentationState=next.presentationState||presentationStateByKind[next.kind]||'idle'});`
      : "";
  const content =
    nextSurface === "voice"
      ? `<main class="voice-surface" aria-label="Jarvis voice command status" aria-live="polite"><div class="voice-presence" data-visual-fallback="visible" role="img" aria-labelledby="presence-state"><svg class="voice-fallback" viewBox="0 0 120 80" aria-hidden="true"><path d="M4 41h18l7-23 10 44 10-30 8 18h18l7-11 8 2 8-12 8 12h20"/><path class="fallback-echo" d="M4 53h22l7-8 8 3 10-4 10 2 12-4 11 3 12-4 20 2"/></svg><span id="presence-state" class="visually-hidden">Ready</span></div><section class="voice-copy"><p id="state">Ready when you are</p><p id="detail">Hold the shortcut and tell me what you need.</p><p id="context-line" class="voice-context" hidden><span class="context-mark" aria-hidden="true"></span><span id="context"></span></p></section><div id="voice-hint" class="voice-hint" aria-label="Voice shortcut"><span id="hint">Hold to talk</span><kbd>Ctrl + Shift + J</kbd></div><button id="voice-action" class="voice-hint voice-action" type="button" hidden><span id="action-hint"></span></button></main>`
      : `<main class="setup-surface" aria-labelledby="setup-title"><header class="setup-header"><div><p class="product-label">JARVIS / COMPANION</p><h1 id="setup-title">Voice defaults</h1></div><div class="window-controls"><button class="window-button" id="minimize" type="button" aria-label="Minimize Jarvis Companion to the system tray">—</button></div></header><section class="connection-line" aria-label="Connection status"><span id="connection-state" class="connection-state">CHECKING</span><span id="connection-host">Jarvis Host</span></section><p class="setup-intro">Choose the agent used for spoken tasks. Project names can be said naturally in your request.</p><form class="defaults-panel" id="defaults-panel" aria-labelledby="defaults-heading"><div class="section-heading"><p id="defaults-heading">AGENT DEFAULTS</p><span id="defaults-note">Loading available providers…</span></div><div class="field-grid"><label class="field" for="provider"><span>Provider</span><select id="provider" disabled aria-describedby="setup-message"></select></label><label class="field" for="model"><span>Model</span><select id="model" disabled aria-describedby="setup-message"></select></label><label class="field" id="effort-field" for="effort" hidden><span id="effort-label">Reasoning / effort</span><select id="effort" aria-describedby="setup-message"></select></label><label class="field" id="conversation-field" for="conversation-mode"><span>Conversation</span><select id="conversation-mode" aria-describedby="setup-message"><option value="new-thread">Start a new thread</option><option value="continue-last-thread">Continue latest Jarvis thread</option></select></label></div><p id="selection-summary" class="selection-summary">New requests use the Jarvis Host default.</p><div class="defaults-actions"><button class="primary-button" id="save-defaults" type="submit" disabled>Save defaults</button><button class="secondary-button" id="test-voice" type="button">Test voice</button><button class="link-button" id="open-host-settings" type="button">Open workspace in browser</button></div></form><section class="empty-provider" id="empty-provider" hidden aria-labelledby="empty-provider-title"><p class="empty-kicker">HOST ACTION NEEDED</p><h2 id="empty-provider-title">No ready provider on Jarvis Host</h2><p>Finish provider setup on the Host, then reopen this panel. This PC sends your request to that workspace.</p><button class="secondary-button" id="open-host-empty" type="button">Open workspace in browser</button></section><section class="pairing-panel" id="pairing-panel" hidden aria-labelledby="pairing-title"><div class="section-heading"><p id="pairing-title">CONNECT THIS PC</p><span>PRIVATE TAILNET LINK</span></div><form id="pair-form" novalidate><label class="field" for="link"><span>Pairing URL</span><input id="link" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://jarvis-host…/pair#token=…" aria-describedby="link-help setup-message" autofocus /></label><p class="helper" id="link-help">Paste the complete URL, including <code>/pair#token=</code>.</p><button class="primary-button" id="connect" type="submit">Connect companion</button></form></section><p class="setup-message" id="setup-message" role="status" aria-live="polite">Ready.</p><footer><span>RUNS LOCALLY</span><i aria-hidden="true">·</i><span>NO AGENTS RUN ON THIS PC</span><button class="tray-button" id="minimize-footer" type="button">Keep running in the tray</button></footer></main>`;
  const voiceActionScript =
    nextSurface === "voice"
      ? `const voiceActionKinds=${safeInlineJson(voiceOverlayActions)};const voiceHint=document.querySelector('#voice-hint');const voiceAction=document.querySelector('#voice-action');const actionHintLabel=document.querySelector('#action-hint');const updateVoiceAction=()=>{const kind=document.body.dataset.state||'ready';const action=voiceActionKinds[kind];const label=kind==='speaking'?'Stop speaking':actionHint(kind);voiceHint.hidden=action!==undefined;voiceAction.hidden=action===undefined;if(action===undefined){voiceAction.removeAttribute('data-action');voiceAction.removeAttribute('aria-label');return}voiceAction.dataset.action=action;actionHintLabel.textContent=label;voiceAction.setAttribute('aria-label',label)};new MutationObserver(updateVoiceAction).observe(document.body,{attributes:true,attributeFilter:['data-state']});voiceAction.addEventListener('click',()=>{if(voiceAction.dataset.action==='stop-speaking')void window.jarvisCompanion.interruptSpeech?.();if(voiceAction.dataset.action==='open-host')void window.jarvisCompanion.openHost?.()});updateVoiceAction();`
      : "";
  let script =
    nextSurface === "voice"
      ? `const presenceState=document.querySelector('#presence-state');const state=document.querySelector('#state');const detail=document.querySelector('#detail');const contextLine=document.querySelector('#context-line');const context=document.querySelector('#context');const hint=document.querySelector('#hint');const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)');let renderVersion=0;let revealFrame=0;const stateLabel=kind=>({arming:'Preparing',listening:'Listening',capturing:'Listening',checking:'Checking what I heard',review:'Reviewing your request',routing:'Choosing the right workspace',started:'Working',completed:'Complete',attention:'Waiting for you',interrupted:'Stopped',error:'Something went wrong'}[kind]||'Ready');const naturalTitle=(kind,value)=>{const title=typeof value==='string'?value.trim():'';if(title&&!['On it.','On it','All set.','All set','Voice command ready'].includes(title))return title;return {arming:'Give me a moment',listening:'I’m listening',capturing:'I’m still listening',checking:'Let me make sure I heard that right',review:'Here’s what I heard',routing:'Finding the right place for this',started:'I’ve got it from here',completed:'Finished — here’s the useful part',attention:'I need your call on one thing',interrupted:'I’ll stop there',error:'I hit a snag'}[kind]||'Ready when you are'};const actionHint=kind=>({arming:'Waking up',listening:'Release to send',capturing:'Release to send',checking:'Checking the words',review:'Review before sending',routing:'Routing safely',started:'Working quietly',completed:'Open workspace to review',attention:'Open workspace to respond',interrupted:'Hold to talk',error:'Try that once more'}[kind]||'Hold to talk');const setDetail=(text,stream,version)=>{cancelAnimationFrame(revealFrame);revealFrame=0;detail.title=text;detail.setAttribute('aria-label',text);if(!stream||reducedMotion.matches){detail.textContent=text;detail.removeAttribute('aria-busy');return}const words=text.match(/\\S+\\s*/gu)||[text];detail.textContent='';detail.setAttribute('aria-busy','true');const started=performance.now();const reveal=now=>{if(version!==renderVersion)return;const count=Math.min(words.length,Math.max(1,Math.floor((now-started)/42)+1));detail.textContent=words.slice(0,count).join('');if(count<words.length){revealFrame=requestAnimationFrame(reveal);return}detail.removeAttribute('aria-busy');revealFrame=0};revealFrame=requestAnimationFrame(reveal)};const updateCopy=(next,version)=>{const kind=next.kind||'ready';const text=typeof next.detail==='string'&&next.detail.trim()?next.detail:'Hold the shortcut and tell me what you need.';const project=typeof next.context==='string'?next.context.trim():'';document.body.dataset.state=kind;presenceState.textContent=stateLabel(kind);state.textContent=naturalTitle(kind,next.state);context.textContent=project;contextLine.hidden=!project;hint.textContent=actionHint(kind);setDetail(text,next.stream===true,version);if(kind==='listening'||kind==='capturing')detail.scrollTop=detail.scrollHeight};const render=next=>{const version=++renderVersion;cancelAnimationFrame(revealFrame);revealFrame=0;const canAnimate=!reducedMotion.matches&&detail.textContent.trim().length>0;if(!canAnimate){updateCopy(next,version);return}const outgoing=[state,detail,contextLine].filter(element=>!element.hidden).map(element=>element.animate([{opacity:1,transform:'translate3d(0,0,0)'},{opacity:0,transform:'translate3d(0,-3px,0)'}],{duration:90,easing:'ease-out',fill:'forwards'}).finished.catch(()=>undefined));void Promise.all(outgoing).then(()=>{if(version!==renderVersion)return;[state,detail,contextLine].forEach(element=>element.getAnimations().forEach(animation=>animation.cancel()));updateCopy(next,version);[state,detail,contextLine].filter(element=>!element.hidden).forEach((element,index)=>element.animate([{opacity:0,transform:'translate3d(0,4px,0)'},{opacity:1,transform:'translate3d(0,0,0)'}],{duration:180,delay:index*22,easing:'cubic-bezier(.2,.75,.25,1)'}))})};window.addEventListener('t3code:jarvis-capture-start',()=>render({state:'I’m listening',detail:'Go ahead — I’ll send it when you release the shortcut.',kind:'listening'}));window.addEventListener('t3code:jarvis-capture-stop',()=>render({state:'Let me make sure I heard that right',detail:'Catching the last few words…',kind:'checking'}));window.addEventListener('t3code:jarvis-status',event=>render(event.detail||{}));reducedMotion.addEventListener('change',()=>{if(reducedMotion.matches&&detail.getAttribute('aria-busy')==='true'){renderVersion+=1;cancelAnimationFrame(revealFrame);detail.textContent=detail.getAttribute('aria-label')||'';detail.removeAttribute('aria-busy')}});void window.jarvisCompanion.bubbleReady();${voiceActionScript}`
      : `const initial=${initialSetup};const api=window.jarvisCompanion;const byId=id=>document.getElementById(id);const defaultsPanel=byId('defaults-panel');const defaultsForm=defaultsPanel;const emptyProvider=byId('empty-provider');const pairingPanel=byId('pairing-panel');const provider=byId('provider');const model=byId('model');const effort=byId('effort');const effortField=byId('effort-field');const effortLabel=byId('effort-label');const summary=byId('selection-summary');const note=byId('defaults-note');const message=byId('setup-message');const connectionState=byId('connection-state');const connectionHost=byId('connection-host');const save=byId('save-defaults');const link=byId('link');const connect=byId('connect');let setupData=null;let descriptor=null;const setMessage=(text,kind='ready')=>{message.textContent=text;message.dataset.kind=kind;message.setAttribute('role',kind==='error'?'alert':'status')};const invoke=(name,...args)=>typeof api[name]==='function'?api[name](...args):undefined;const text=value=>typeof value==='string'?value.trim():'';const failureText=value=>{const detail=value instanceof Error?text(value.message):text(value);return detail?'Voice test could not start: '+detail:'Voice test could not start. Check your audio output and try again.'};const selectValue=item=>text(item&&((item.slug??item.id??item.value??item.name??item.model)));const providerValue=item=>text(item&&((item.instanceId??item.id??item.name)));const providerLabel=item=>{const name=text(item&&((item.displayName??item.label??item.name??item.instanceId)))||'Provider';const node=text(item&&item.nodeLabel);return node&&node!==name?name+' · '+node:name};const modelsFor=providerItem=>Array.isArray(providerItem&&providerItem.models)?providerItem.models:[];const optionDescriptors=modelItem=>{const capabilities=modelItem&&modelItem.capabilities;const values=capabilities&&capabilities.optionDescriptors||modelItem&&modelItem.optionDescriptors;return Array.isArray(values)?values:[]};const optionItems=item=>Array.isArray(item&&item.options)?item.options:[];const optionValue=item=>text(item&&((item.value??item.id??item.name)));const optionLabel=item=>text(item&&((item.label??item.name??item.value??item.id)));const clearSelect=element=>{element.replaceChildren()};const addOption=(element,value,label)=>{const item=document.createElement('option');item.value=value;item.textContent=label;element.append(item)};const selectedProvider=()=>Array.isArray(setupData&&setupData.providers)?setupData.providers.find(item=>providerValue(item)===provider.value):undefined;const selectedModel=()=>modelsFor(selectedProvider()).find(item=>selectValue(item)===model.value);const updateSummary=()=>{const name=provider.options[provider.selectedIndex]&&provider.options[provider.selectedIndex].textContent||'Jarvis Host';const modelName=model.options[model.selectedIndex]&&model.options[model.selectedIndex].textContent||'default model';const effortName=!effortField.hidden&&effort.options[effort.selectedIndex]&&effort.options[effort.selectedIndex].textContent;summary.textContent='New requests use '+name+' / '+modelName+(effortName?' / '+effortName+'.':'.')};const renderEffort=selection=>{const descriptors=optionDescriptors(selectedModel());descriptor=descriptors.find(item=>/reason|effort|thinking/i.test(text(item&&((item.id??item.name??item.label)))))||descriptors.find(item=>optionItems(item).length>0);if(!descriptor){effortField.hidden=true;clearSelect(effort);return}const items=optionItems(descriptor);if(!items.length){effortField.hidden=true;return}effortField.hidden=false;effortLabel.textContent=text(descriptor.label??descriptor.name)||'Reasoning / effort';clearSelect(effort);items.forEach(item=>addOption(effort,optionValue(item),optionLabel(item)));const existing=Array.isArray(selection&&selection.options)?selection.options.find(item=>text(item&&item.id)===text(descriptor.id)):undefined;const selected=text(existing&&existing.value);if(selected&&Array.from(effort.options).some(item=>item.value===selected))effort.value=selected};const renderModels=selection=>{clearSelect(model);const models=modelsFor(selectedProvider());models.forEach(item=>addOption(model,selectValue(item),text(item.shortName??item.displayName??item.label??item.name??item.model??item.id)||'Model'));const selected=text(selection&&selection.model);if(selected&&Array.from(model.options).some(item=>item.value===selected))model.value=selected;model.disabled=models.length===0;renderEffort(selection);updateSummary()};const renderProviders=data=>{setupData=data;const all=Array.isArray(data&&data.providers)?data.providers:[];const ready=all.filter(item=>item&&item.status==='ready'&&item.enabled!==false&&item.installed!==false&&(!item.auth||item.auth.status!=='unauthenticated')&&modelsFor(item).length>0);if(!ready.length){defaultsPanel.hidden=true;emptyProvider.hidden=false;return}setupData={...data,providers:ready};defaultsPanel.hidden=false;emptyProvider.hidden=true;clearSelect(provider);ready.forEach(item=>addOption(provider,providerValue(item),providerLabel(item)));const selection=data.defaultModelSelection||data.defaultSelection||data.selection||null;const selected=text(selection&&selection.instanceId);if(selected&&Array.from(provider.options).some(item=>item.value===selected))provider.value=selected;provider.disabled=false;renderModels(selection);save.disabled=false;note.textContent='Saved choices are sent with every spoken request.'};const showConnection=(host,label)=>{const value=host===undefined?initial.host:text(host);const display=text(label)||initial.nodeLabel||'Jarvis Host';const connected=Boolean(value);connectionState.textContent=connected?'CONNECTED':'NOT CONNECTED';connectionState.dataset.connected=connected?'true':'false';connectionHost.textContent=connected?display:'Pair with Jarvis Host to continue.';pairingPanel.hidden=connected;defaultsPanel.hidden=!connected;emptyProvider.hidden=true;if(!connected){setMessage('Paste a fresh pairing URL from Jarvis Host.');link.focus()}};const openHost=async()=>{const opened=await invoke('openHost');if(opened===undefined)setMessage('Open Jarvis Host from the companion tray menu.','ready')};const minimize=()=>{const result=invoke('minimize');if(result===undefined)window.close()};const saveDefaults=async()=>{if(!setupData)return;save.disabled=true;setMessage('Saving defaults to this companion…','progress');const selection={instanceId:provider.value,model:model.value,...(!effortField.hidden&&descriptor?{options:[{id:text(descriptor.id),value:effort.value}]}:{})};try{const result=await invoke('saveDefault',selection);if(result===undefined){setMessage('This companion build cannot save defaults yet. Install the current release.','error');return}if(!result.ok){setMessage(result.message||'Jarvis Host rejected those defaults.','error');return}setMessage('Defaults saved. Your next voice request is ready.','success')}catch{setMessage('Defaults could not be saved. Try again.','error')}finally{save.disabled=false}};const initialize=async()=>{showConnection(initial.host);if(!initial.configured)return;setMessage('Checking available providers…','progress');const result=await invoke('getSetup');if(result===undefined){defaultsPanel.hidden=true;emptyProvider.hidden=false;setMessage('Provider defaults will be available after the companion finishes updating.','ready');return}if(!result||result.ok===false){if(result&&result.needsPairing){showConnection(null);setMessage(result.message||'This companion needs a fresh pairing URL from Jarvis Host.','error');return}defaultsPanel.hidden=true;emptyProvider.hidden=false;setMessage(result&&result.message||'Jarvis Host could not load provider defaults.','error');return}if(result.connected===false){showConnection(null);return}showConnection(result.host||initial.host,result.nodeLabel);renderProviders(result);setMessage('Ready to save voice defaults.','success')};provider.addEventListener('change',()=>renderModels(null));model.addEventListener('change',()=>{renderEffort(null);updateSummary()});effort.addEventListener('change',updateSummary);defaultsForm.addEventListener('submit',event=>{event.preventDefault();void saveDefaults()});byId('test-voice').addEventListener('click',async()=>{setMessage('Testing Jarvis voice…','progress');try{const result=await invoke('testVoice');if(result===undefined){await api.speak('Jarvis Companion voice is ready.');setMessage('Voice test sent.','success');return}if(!result||result.ok!==true){setMessage(text(result&&result.message)||'Voice test could not start. Check your audio output and try again.','error');return}setMessage('Voice test sent.','success')}catch(error){setMessage(failureText(error),'error')}});[byId('open-host-settings'),byId('open-host-empty')].filter(Boolean).forEach(button=>button.addEventListener('click',()=>void openHost()));[byId('minimize'),byId('minimize-footer')].filter(Boolean).forEach(button=>button.addEventListener('click',minimize));byId('pair-form').addEventListener('submit',async event=>{event.preventDefault();const candidate=link.value.trim();link.removeAttribute('aria-invalid');if(!candidate){link.setAttribute('aria-invalid','true');setMessage('Paste the complete Jarvis pairing URL.','error');link.focus();return}connect.disabled=true;connect.textContent='Connecting…';setMessage('Verifying the private connection…','progress');try{const result=await api.submitPairingLink(candidate);if(!result.ok){link.setAttribute('aria-invalid','true');setMessage(result.message||'Jarvis could not complete that connection. Try a fresh pairing URL.','error');link.focus()}}catch{link.setAttribute('aria-invalid','true');setMessage('Jarvis could not complete that connection. Check the URL and try again.','error')}finally{connect.disabled=false;connect.textContent='Connect companion'}});link.addEventListener('input',()=>{link.removeAttribute('aria-invalid');setMessage('Ready to verify the private connection.')});window.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();minimize()}});void initialize();`;
  if (nextSurface === "voice") script = `${voicePresentationScript}${script}`;
  const renderedContent = canonicalSetupSurface(nextSurface, content);
  script = canonicalSetupSurface(nextSurface, script);
  const voiceReviewScript =
    nextSurface === "voice"
      ? `const updateReviewAffordance=()=>{const reviewing=['review','attention'].includes(document.body.dataset.state);const scrollable=reviewing&&detail.scrollHeight>detail.clientHeight;detail.tabIndex=scrollable?0:-1;if(scrollable)hint.textContent='Scroll to review'};new MutationObserver(updateReviewAffordance).observe(document.body,{attributes:true,attributeFilter:['data-state']});updateReviewAffordance();`
      : "";
  const conversationModeScript =
    nextSurface === "setup"
      ? `<script>(()=>{const mode=document.getElementById('conversation-mode');if(!mode)return;mode.value=${safeInlineJson(loadConversationMode())};mode.addEventListener('change',async()=>{const result=await window.jarvisCompanion.saveConversationMode?.(mode.value);if(!result||!result.ok){mode.value='new-thread';document.getElementById('setup-message').textContent=(result&&result.message)||'Conversation mode could not be saved.'}})})()</script>`
      : "";
  const voiceActionStyle =
    nextSurface === "voice"
      ? `<style>#voice-hint.voice-hint{cursor:default}.voice-action{appearance:none;border:0;background:transparent;cursor:pointer}</style>`
      : "";
  const companionPresentation = companionPresentationStyle(nextSurface);
  const companionWebgl = companionWebglScript(nextSurface);
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><title>${APP_NAME}</title><style>
:root{color-scheme:dark;--mono:"Cascadia Mono","SFMono-Regular",Consolas,monospace;--ui:"Segoe UI Variable","Segoe UI",system-ui,sans-serif}*{box-sizing:border-box}html,body,#surface-root{width:100%;height:100%}body{margin:0;background:transparent;color:#eeede8;font:13px var(--ui);overflow:hidden}#surface-root{width:100%;height:100%;overflow:hidden}button,input,select{font:inherit}
</style>${voiceActionStyle}${companionPresentation}</head><body><div id="surface-root">${renderedContent}</div><script>${script}${voiceReviewScript}</script>${conversationModeScript}${companionWebgl}</body></html>`)}`;
}

function placeVoiceOverlay(status?: CompanionVoiceStatus) {
  if (!bubbleWindow) return;
  const area = screen.getPrimaryDisplay().workArea;
  const baseSize = voiceOverlaySizeForStatus(status);
  const isLiveTranscript = status?.kind === "listening" || status?.kind === "capturing";
  const estimatedLines = Math.max(
    1,
    (status?.detail ?? "").split(/\r?\n/u).reduce((total, line) => {
      return total + Math.max(1, Math.ceil(line.length / 46));
    }, 0),
  );
  const size =
    isLiveTranscript && estimatedLines > 2
      ? { ...baseSize, height: Math.min(136, Math.max(baseSize.height, 42 + estimatedLines * 15)) }
      : baseSize;
  bubbleWindow.setBounds(voiceOverlayBounds(area, size));
}

function placeSetupWindow() {
  if (!bubbleWindow) return;
  const area = screen.getPrimaryDisplay().workArea;
  bubbleWindow.setBounds(setupWindowBounds(area));
}

async function loadSurface(
  nextSurface: "voice" | "setup",
  forceReload = false,
  voiceStatus?: CompanionVoiceStatus,
) {
  if (!bubbleWindow) return;
  const needsNavigation = forceReload || surface !== nextSurface;
  surface = nextSurface;
  if (nextSurface === "voice") placeVoiceOverlay(voiceStatus);
  else placeSetupWindow();
  if (needsNavigation) await bubbleWindow.loadURL(bubblePage(nextSurface));
}

function openCompanionSetup() {
  if (managedCompanionLaunch) return;
  hideBubbleAbort?.abort();
  void loadSurface("setup", true).then(() => bubbleWindow?.showInactive());
}

function createBubble(initialSurfaceOverride?: "voice" | "setup") {
  const configured = loadSavedHost() !== null;
  const area = screen.getPrimaryDisplay().workArea;
  const initialSurface = initialSurfaceOverride ?? (configured ? "voice" : "setup");
  const initialBounds =
    initialSurface === "voice" ? voiceOverlayBounds(area) : setupWindowBounds(area);
  bubbleWindow = new BrowserWindow({
    ...initialBounds,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: NodePath.join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  bubbleWindow.setAlwaysOnTop(true, "pop-up-menu");
  bubbleWindow.webContents.on("did-start-loading", () => {
    bubbleReady = false;
  });
  bubbleWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    bubbleWindow?.hide();
  });
  void loadSurface(initialSurface);
}

function flushVoiceOverlay() {
  if (!bubbleReady || !bubbleWindow || surface !== "voice") return;
  const next = queuedBubbleCaptureEvent({ bubbleReady, capturePending, phase: capturePhase });
  capturePending = next.capturePending;
  if (next.event === "start") bubbleWindow.webContents.send(CAPTURE_START_CHANNEL);
  if (next.event === "stop") bubbleWindow.webContents.send(CAPTURE_STOP_CHANNEL);
  if (latestBubbleStatus !== undefined) {
    bubbleWindow.webContents.send(STATUS_CHANNEL, latestBubbleStatus);
  }
}

function isBubbleSender(event: IpcMainInvokeEvent): boolean {
  return event.sender === bubbleWindow?.webContents;
}

function relayNodeForSender(event: IpcMainInvokeEvent): CompanionNode | undefined {
  for (const [nodeId, window] of relayWindows) {
    if (
      window.webContents === event.sender &&
      isTrustedRelayNavigation({
        destination: event.sender.getURL(),
        pairedHost: relayNodes.get(nodeId)?.host ?? null,
      })
    ) {
      return relayNodes.get(nodeId);
    }
  }
  return undefined;
}

function isRelaySender(event: IpcMainInvokeEvent): boolean {
  return relayNodeForSender(event) !== undefined;
}

async function loadRelay(node: CompanionNode) {
  const relay = relayWindows.get(node.nodeId);
  if (relay) await relay.loadURL(node.host);
}

function connectReportRelay(node: CompanionNode) {
  reportRelayAvailability.set(node.nodeId, false);
  reportRelayConnections.set(node.nodeId, { phase: "connecting" });
  relayNodes.set(node.nodeId, node);
  refreshTrayMenu();
  createRelay(node);
  void loadRelay(node).catch(() => {
    reportRelayAvailability.set(node.nodeId, false);
    reportRelayConnections.set(node.nodeId, {
      phase: "error",
      detail: "Jarvis Host did not answer. Retry the task connection or pair again.",
    });
    resolveReportRelayReadiness(node.nodeId, false);
    refreshTrayMenu();
  });
}

function waitForReportRelayReadiness(nodeId: string, timeoutMs = 10_000): Promise<boolean> {
  const current = reportRelayAvailability.get(nodeId);
  if (current === true) return Promise.resolve(true);
  return new Promise((resolve) => {
    const waiters = reportRelayReadinessWaiters.get(nodeId) ?? new Set();
    const finish = (ready: boolean) => {
      NodeTimers.clearTimeout(timeout);
      waiters.delete(finish);
      if (waiters.size === 0) reportRelayReadinessWaiters.delete(nodeId);
      resolve(ready);
    };
    waiters.add(finish);
    reportRelayReadinessWaiters.set(nodeId, waiters);
    const timeout = NodeTimers.setTimeout(() => finish(false), timeoutMs);
  });
}

function resolveReportRelayReadiness(nodeId: string, ready: boolean) {
  const waiters = reportRelayReadinessWaiters.get(nodeId);
  if (waiters === undefined) return;
  for (const waiter of [...waiters]) waiter(ready);
}

function createRelay(node: CompanionNode) {
  const existing = relayWindows.get(node.nodeId);
  if (existing !== undefined) return;
  const relayWindow = new BrowserWindow(relayWindowOptions(ensureCompanionOriginInteractionId()));
  relayWindows.set(node.nodeId, relayWindow);
  relayNodes.set(node.nodeId, node);
  relayWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const preventUntrustedRelayNavigation = (event: Electron.Event, url: string) => {
    if (
      isTrustedRelayNavigation({
        destination: url,
        pairedHost: relayNodes.get(node.nodeId)?.host ?? null,
      })
    )
      return;
    event.preventDefault();
    reportRelayAvailability.set(node.nodeId, false);
    reportRelayConnections.set(node.nodeId, {
      phase: "error",
      detail: "The task connection was redirected away from the paired Host.",
    });
    resolveReportRelayReadiness(node.nodeId, false);
    refreshTrayMenu();
  };
  relayWindow.webContents.on("will-navigate", preventUntrustedRelayNavigation);
  relayWindow.webContents.on("will-redirect", preventUntrustedRelayNavigation);
  relayWindow.webContents.on(
    "did-fail-load",
    (_event, _errorCode, _errorDescription, _url, isMainFrame) => {
      if (!isMainFrame) return;
      reportRelayAvailability.set(node.nodeId, false);
      reportRelayConnections.set(node.nodeId, {
        phase: "error",
        detail: `Jarvis Host could not load task reports (code ${_errorCode}).`,
      });
      resolveReportRelayReadiness(node.nodeId, false);
      refreshTrayMenu();
    },
  );
}

function disconnectReportRelay(nodeId?: string) {
  const ids = nodeId === undefined ? [...relayWindows.keys()] : [nodeId];
  for (const id of ids) {
    reportRelayAvailability.delete(id);
    reportRelayConnections.delete(id);
    latestRelayStatusIds.delete(id);
    relayWindows.get(id)?.destroy();
    relayWindows.delete(id);
    relayNodes.delete(id);
    resolveReportRelayReadiness(id, false);
  }
  refreshTrayMenu();
}

function finishCapture() {
  if (captureTimeout !== undefined) {
    NodeTimers.clearTimeout(captureTimeout);
    captureTimeout = undefined;
  }
  if (firstAudioFrameTimeout !== undefined) {
    NodeTimers.clearTimeout(firstAudioFrameTimeout);
    firstAudioFrameTimeout = undefined;
  }
  capturePending = false;
  capturePhase = "idle";
  captureInFlight = false;
  captureTimedOut = false;
  captureNoAudio = false;
  activeParakeetCapture = undefined;
}

const companionCaptureTimeoutMs = 30_000;
const companionFirstAudioFrameTimeoutMs = 5_000;

function armCaptureTimeout() {
  if (captureTimeout !== undefined) NodeTimers.clearTimeout(captureTimeout);
  captureTimedOut = false;
  captureNoAudio = false;
  captureTimeout = NodeTimers.setTimeout(() => {
    captureTimeout = undefined;
    captureTimedOut = true;
    heldReleaseRequested = true;
    capturePhase = "checking";
    showCompanionStatus({
      state: "Voice capture timed out",
      detail: "Jarvis did not receive a complete instruction. Try again.",
      kind: "error",
    });
    activeParakeetCapture?.cancel();
  }, companionCaptureTimeoutMs);
}

function armFirstAudioFrameTimeout() {
  if (firstAudioFrameTimeout !== undefined) NodeTimers.clearTimeout(firstAudioFrameTimeout);
  firstAudioFrameTimeout = NodeTimers.setTimeout(() => {
    firstAudioFrameTimeout = undefined;
    if (!captureInFlight) return;
    captureTimedOut = true;
    captureNoAudio = true;
    heldReleaseRequested = true;
    capturePhase = "checking";
    showCompanionStatus({
      state: "Microphone unavailable",
      detail:
        "Jarvis did not receive audio from this microphone. Check microphone permissions and that an input device is connected.",
      kind: "error",
    });
    activeParakeetCapture?.cancel();
  }, companionFirstAudioFrameTimeoutMs);
}

function clearFirstAudioFrameTimeout() {
  if (firstAudioFrameTimeout === undefined) return;
  NodeTimers.clearTimeout(firstAudioFrameTimeout);
  firstAudioFrameTimeout = undefined;
}

function captureFailurePresentation(cause: unknown) {
  const detail =
    cause instanceof Error ? cause.message : "Jarvis could not capture that instruction.";
  const code = classifyVoiceCaptureError(cause);
  if (
    code === "cancelled" ||
    /stopped before recognizing speech|didn't hear a complete instruction/iu.test(detail)
  ) {
    return {
      state: "I didn't catch that",
      detail: "Hold until the soft tone, then speak naturally and release when you finish.",
    };
  }
  if (code === "permission-denied") return { state: "Microphone permission denied", detail };
  if (code === "no-input-device") return { state: "No microphone found", detail };
  if (code === "no-audio-frames") return { state: "Microphone unavailable", detail };
  if (code === "capture-timeout") return { state: "Voice capture timed out", detail };
  return { state: "Voice transcription failed", detail };
}

function requireVoiceDefault(): CompanionVoiceDefault | undefined {
  const targetNodeId = attentionTarget?.nodeId ?? pendingProjectTask?.nodeId;
  const node =
    (targetNodeId === undefined
      ? undefined
      : loadSavedNodes().find((candidate) => candidate.nodeId === targetNodeId)) ?? loadSavedNode();
  const modelSelection = node === undefined ? undefined : loadSavedDefault(node.nodeId);
  if (node !== undefined && modelSelection !== undefined) {
    return {
      node,
      host: node.host,
      modelSelection,
      conversationMode: loadConversationMode(),
    };
  }
  if (!managedCompanionLaunch) openCompanionSetup();
  return undefined;
}

function showVoiceCapture() {
  capturePending = true;
  capturePhase = "listening";
  latestBubbleStatus = undefined;
  void loadSurface("voice").then(() => {
    if (companionShuttingDown || !captureInFlight) return;
    bubbleWindow?.showInactive();
    flushVoiceOverlay();
  });
}

async function dispatchCapturedTranscript(transcript: string, voiceDefault: CompanionVoiceDefault) {
  await refreshRecognitionVocabulary();
  const recognizedTranscript = recognitionTranscript(transcript);
  // Coalesce with the warm started at capture time. The queue reservation
  // below preserves acknowledgement order if Pocket is still cold, while a
  // broken worker can never hold written task dispatch for its startup timeout.
  const speechWarmStartedAt = Date.now();
  developmentDiagnostic("speech-prewarm-start", { transcriptLength: recognizedTranscript.length });
  const speechReady = prepareNativeSpeech()
    .then(() => {
      developmentDiagnostic("speech-prewarm-ready", {
        latencyMs: Date.now() - speechWarmStartedAt,
      });
    })
    .catch((cause: unknown) => {
      developmentDiagnostic("speech-prewarm-failed", {
        latencyMs: Date.now() - speechWarmStartedAt,
        message: cause instanceof Error ? cause.message : "Pocket could not warm.",
      });
    });
  showCompanionStatus({
    state: "Checking transcript",
    detail: recognizedTranscript,
    kind: "review",
  });
  // Host dispatch is independent from local acknowledgement speech. Do not
  // hold the task behind model startup or an arbitrary visual delay; the
  // reservation queue preserves acknowledgement order while the POST starts
  // immediately.
  void speechReady;
  const dispatchStartedAt = Date.now();
  developmentDiagnostic("speech-dispatch-start");
  const result = await submitTranscriptToHost(
    recognizedTranscript,
    voiceDefault,
    isNativeSpeechReady,
  );
  developmentDiagnostic("speech-dispatch-finished", {
    latencyMs: Date.now() - dispatchStartedAt,
  });
  return result;
}

async function startHeldCapture() {
  if (!bubbleWindow) return;
  if ((process.platform !== "win32" && process.platform !== "linux") || process.arch !== "x64") {
    showCompanionStatus({
      state: "Voice capture unavailable",
      detail: "Local microphone capture is currently supported on Windows and Linux x64.",
      kind: "error",
    });
    return;
  }
  interruptCompanionSpeech("capture");
  const voiceDefault = requireVoiceDefault();
  if (voiceDefault === undefined) return;
  if (!canStartCapture(captureInFlight)) {
    showCompanionStatus({
      state: "Jarvis is already listening",
      detail: "Finish your current instruction first.",
      kind: "listening",
    });
    return;
  }
  hideBubbleAbort?.abort();
  captureInFlight = true;
  heldReleaseRequested = false;
  armCaptureTimeout();
  // Voice capture is user intent to dispatch work, so use that speaking time
  // to hide Pocket's cold start without keeping the model resident at rest.
  // dispatchCapturedTranscript coalesces with and awaits this same warm attempt.
  void prepareNativeSpeech().catch(() => undefined);
  showVoiceCapture();
  showCompanionStatus({
    state: "Waking the microphone",
    detail: "One moment — start speaking when you hear the soft tone.",
    kind: "arming",
  });
  try {
    const recording = developmentRecognitionCapture();
    const capture = startParakeetCapture({
      ...parakeetPaths(),
      ...(recording === undefined ? {} : { recordingDirectory: recording.directory }),
      onReady: () => {
        // A very quick release may happen while the audio device is opening.
        // Never play the ready cue or regress the surface back to listening
        // after that release has already begun transcript finalisation.
        if (!captureInFlight || capturePhase !== "listening") return;
        armFirstAudioFrameTimeout();
        playCue();
        const tapMode = hotkeyMode === "tap";
        showCompanionStatus({
          state: tapMode ? "Listening — tap again to send" : "Listening — release to send",
          detail: tapMode
            ? "Speak naturally, then press Ctrl+Shift+J again."
            : "Speak naturally, then release the shortcut.",
          kind: "listening",
        });
      },
      onFirstAudioFrame: clearFirstAudioFrameTimeout,
      onTranscript: (transcript) => {
        if (!captureInFlight) return;
        showCompanionStatus({
          state:
            hotkeyMode === "tap" ? "Listening — tap again to send" : "Listening — release to send",
          detail: transcript,
          kind: "listening",
        });
      },
      onMetrics: (metrics) => developmentRecognitionMetrics(recording, metrics),
    });
    activeParakeetCapture = capture;
    if (captureTimedOut) capture.cancel();
    else if (heldReleaseRequested) capture.release();
    void capture.result
      .then(async (transcript) => {
        if (companionShuttingDown) return;
        return await dispatchCapturedTranscript(transcript, voiceDefault);
      })
      .catch((cause) => {
        if (companionShuttingDown) return;
        const presentation = captureFailurePresentation(cause);
        showCompanionStatus({
          ...(captureNoAudio
            ? {
                state: "Microphone unavailable",
                detail:
                  "Jarvis did not receive audio from this microphone. Check microphone permissions and that an input device is connected.",
              }
            : captureTimedOut
              ? {
                  state: "Voice capture timed out",
                  detail: "Jarvis did not receive a complete instruction. Try again.",
                }
              : presentation),
          kind: "error",
        });
      })
      .finally(finishCapture);
  } catch (cause) {
    if (companionShuttingDown) return;
    finishCapture();
    const presentation = captureFailurePresentation(cause);
    showCompanionStatus({
      ...presentation,
      kind: "error",
    });
  }
}

function releaseHeldCapture() {
  if (!captureInFlight) return;
  if (captureTimeout !== undefined) {
    NodeTimers.clearTimeout(captureTimeout);
    captureTimeout = undefined;
  }
  clearFirstAudioFrameTimeout();
  heldReleaseRequested = true;
  capturePhase = "checking";
  flushVoiceOverlay();
  showCompanionStatus({
    state: "Checking transcript",
    detail: "Listening for the final words…",
    kind: "checking",
  });
  activeParakeetCapture?.release();
}

function toggleTapCapture() {
  if (captureInFlight) {
    releaseHeldCapture();
    return;
  }
  void startHeldCapture();
}

function scheduleBubbleHide(delay: number | undefined) {
  hideBubbleAbort?.abort();
  if (delay === undefined) return;
  const controller = new AbortController();
  hideBubbleAbort = controller;
  void NodeTimersPromises.setTimeout(delay, undefined, { signal: controller.signal })
    .then(() => {
      if (hideBubbleAbort === controller) bubbleWindow?.hide();
    })
    .catch(() => undefined);
}

function showCompanionStatus(status: CompanionVoiceStatus) {
  if (companionShuttingDown) return;
  latestBubbleStatus = {
    ...status,
    presentationState: jarvisPresentationStateForKind(status.kind),
  };
  setNativeSpeechRetention(
    latestBubbleStatus.presentationState !== "idle" &&
      latestBubbleStatus.presentationState !== "error",
  );
  void loadSurface("voice", false, status).then(() => {
    if (companionShuttingDown) return;
    bubbleWindow?.showInactive();
    flushVoiceOverlay();
  });
  scheduleBubbleHide(voiceOverlayAutoHideDelay(status));
}

async function runDevelopmentScenario() {
  if (!developmentLaunch.enabled) return;
  if (developmentLaunch.injectText !== undefined) {
    developmentDiagnostic("text-injection", { transcript: developmentLaunch.injectText });
    await submitTranscriptToHost(developmentLaunch.injectText);
  }
  const scenario = developmentLaunch.simulateReport;
  if (scenario === undefined) return;
  const presentation = companionDevelopmentReport(scenario);
  developmentDiagnostic("report-simulated", { scenario });
  showCompanionStatus(presentation.status);
  await speakCompanionSpeech(presentation.spoken).catch(() => undefined);
}

async function pairHost(
  pairingUrl: string,
): Promise<{ readonly ok: boolean; readonly message?: string }> {
  ensureCompanionOriginInteractionId();
  const result = await pairCompanionHost({ fetch: hostFetch, pairingUrl });
  if (!result.ok) {
    if (managedCompanionLaunch)
      process.stdout.write(`${managedStatusLine("ERROR", "PAIRING_REJECTED")}\n`);
    return result;
  }
  // A descriptor failure is deliberately legacy-compatible. Reuse a known
  // stable node at this host when possible so a transient descriptor outage
  // cannot create a second synthetic directory entry.
  const pairedNode =
    result.node ??
    loadSavedNodes().find((candidate) => candidate.host === result.host) ??
    legacyNodeForHost(result.host);
  savePairedNode(pairedNode);
  const node = loadSavedNodes().find((candidate) => candidate.nodeId === pairedNode.nodeId);
  if (node !== undefined) {
    connectReportRelay(node);
    if (managedCompanionLaunch) {
      const relayReady = await waitForReportRelayReadiness(node.nodeId);
      if (!relayReady) {
        process.stdout.write(`${managedStatusLine("ERROR", "REPORT_RELAY_NOT_READY")}\n`);
        return {
          ok: false,
          message: "Jarvis Host pairing succeeded, but task reports are not ready yet.",
        };
      }
      process.stdout.write(`${managedStatusLine("PAIRED")}\n`);
    }
    void refreshRecognitionVocabulary();
  } else if (managedCompanionLaunch) {
    process.stdout.write(`${managedStatusLine("ERROR", "NODE_DESCRIPTOR_UNAVAILABLE")}\n`);
    return { ok: false, message: "Jarvis paired, but its Host descriptor is unavailable." };
  }
  await loadSurface(managedCompanionLaunch ? "voice" : "setup", true);
  if (!managedCompanionLaunch) bubbleWindow?.showInactive();
  refreshTrayMenu();
  return { ok: true };
}

function projectChoicePrompt(projects: ReadonlyArray<CompanionProjectTarget>): string {
  if (projects.length === 1) return `Did you mean ${projects[0]!.title}? Say yes or no.`;
  const titleCounts = new Map<string, number>();
  for (const project of projects) {
    const title = project.title.toLocaleLowerCase("en-US");
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  }
  const choices = projects
    .slice(0, 4)
    .map((project, index) => {
      const title = project.title.toLocaleLowerCase("en-US");
      const label =
        (titleCounts.get(title) ?? 0) > 1 ? companionProjectChoiceLabel(project) : project.title;
      return `${["first", "second", "third", "fourth"][index]} for ${label}`;
    })
    .join(", or ");
  return `Which project should I use? Say ${choices || "the project name"}.`;
}

async function resolveProjectForTranscript(input: {
  readonly transcript: string;
  readonly projects?: ReadonlyArray<CompanionProjectTarget>;
  readonly taskTranscript?: string;
  readonly requestId?: string;
  readonly originInteractionId?: string;
}): Promise<CompanionProjectTarget | undefined> {
  developmentDiagnostic("project-catalog", { hasProvidedCandidates: input.projects !== undefined });
  const catalog =
    input.projects !== undefined
      ? { kind: "ready" as const, projects: input.projects }
      : await (async () => {
          const catalogs = await Promise.all(
            loadSavedNodes().map((node) =>
              getCompanionProjectCatalog({
                fetch: hostFetch,
                host: node.host,
                nodeId: node.nodeId,
                nodeLabel: node.displayName,
              }),
            ),
          );
          const projects = catalogs.flatMap((entry) =>
            entry.kind === "ready" ? entry.projects : [],
          );
          if (catalogs.some((entry) => entry.kind === "ready") || catalogs.length === 0) {
            return { kind: "ready" as const, projects };
          }
          const failure = catalogs.find((entry) => entry.kind === "error");
          return failure ?? { kind: "ready" as const, projects };
        })();
  if (catalog.kind === "error") {
    showCompanionStatus({
      state: "I couldn't read your workspaces",
      detail: catalog.message,
      kind: "error",
    });
    void speakCompanionSpeech(
      "I couldn't read the projects on Jarvis Host. Please try once more.",
    ).catch(() => undefined);
    if (catalog.needsPairing) openCompanionSetup();
    return undefined;
  }

  rememberProjectTargets(catalog.projects);
  const recentProject = loadSavedProject();
  const resolution = resolveCompanionProjectTarget({
    transcript: input.transcript,
    projects: catalog.projects,
    ...(input.projects === undefined && recentProject !== undefined
      ? {
          ...(recentProject.nodeId === undefined
            ? {}
            : {
                recentProjectRef: {
                  nodeId: recentProject.nodeId,
                  projectId: recentProject.id,
                },
              }),
          recentProjectId: recentProject.id,
        }
      : {}),
  });
  if (resolution.kind === "resolved") {
    developmentDiagnostic("project-resolved", {
      projectId: resolution.project.id,
      source: resolution.source,
    });
    return resolution.project;
  }
  if (resolution.kind === "no-projects") {
    const message = "Open or create a project on Jarvis Host, then try that again.";
    showCompanionStatus({
      state: "There isn't a project to use yet",
      detail: message,
      kind: "attention",
    });
    void speakCompanionSpeech(message).catch(() => undefined);
    return undefined;
  }

  savePendingProjectTask({
    transcript: input.taskTranscript ?? input.transcript,
    projects: resolution.projects,
    ...(new Set(resolution.projects.map((project) => project.nodeId)).size === 1 &&
    resolution.projects[0]?.nodeId !== undefined
      ? { nodeId: resolution.projects[0].nodeId }
      : {}),
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.originInteractionId === undefined
      ? {}
      : { originInteractionId: input.originInteractionId }),
    ...(resolution.heardAlias === undefined ? {} : { heardAlias: resolution.heardAlias }),
  });
  developmentDiagnostic("project-clarification", {
    candidateCount: String(resolution.projects.length),
    hasHeardAlias: resolution.heardAlias !== undefined,
  });
  const prompt = projectChoicePrompt(resolution.projects);
  showCompanionStatus({
    state: "Which project?",
    detail: prompt,
    kind: "attention",
  });
  void speakCompanionSpeech(prompt).catch(() => undefined);
  return undefined;
}

async function submitTranscriptToHost(
  transcript: string,
  voiceDefault = requireVoiceDefault(),
  acknowledgementReady: () => boolean = isNativeSpeechReady,
): Promise<{ readonly ok: boolean; readonly message?: string }> {
  let taskTranscript = transcript.trim();
  developmentDiagnostic("transcript-received", { transcript: taskTranscript });
  if (taskTranscript.length === 0) {
    return { ok: false, message: "No task was heard." };
  }
  if (voiceDefault === undefined) {
    developmentDiagnostic("dispatch-rejected", { reason: "missing-voice-default" });
    return {
      ok: false,
      message: "Choose voice defaults before sending a task.",
    };
  }

  let selectedProject: CompanionProjectTarget | undefined;
  let correctionSaveFailed = false;
  const pending = pendingProjectTask;
  let requestId = pending?.requestId ?? NodeCrypto.randomUUID();
  const installationOriginInteractionId = ensureCompanionOriginInteractionId();
  let originInteractionId = pending?.originInteractionId ?? installationOriginInteractionId;
  if (pending !== undefined) {
    if (/^(?:no|cancel|never mind|nevermind|stop)$/iu.test(taskTranscript)) {
      savePendingProjectTask(undefined);
      showCompanionStatus({
        state: "Cancelled",
        detail: "That task wasn't started.",
        kind: "completed",
      });
      return { ok: true };
    }
    selectedProject = await resolveProjectForTranscript({
      transcript: taskTranscript,
      projects: pending.projects,
      taskTranscript: pending.transcript,
      requestId,
      originInteractionId,
    });
    if (selectedProject === undefined) return { ok: true };
    if (pending.heardAlias !== undefined) {
      const saved = await manageCompanionProjectAlias({
        fetch: hostFetch,
        host: nodeForProject(selectedProject)?.host ?? voiceDefault.host,
        projectId: selectedProject.id,
        ...(selectedProject.nodeId === undefined ? {} : { nodeId: selectedProject.nodeId }),
        alias: pending.heardAlias,
      }).catch(() => false);
      correctionSaveFailed = !saved;
      if (saved) {
        updateCachedAlias(selectedProject.id, pending.heardAlias, false, selectedProject.nodeId);
      }
    }
    taskTranscript = pending.transcript;
    savePendingProjectTask(undefined);
  }

  const explicitlyStartsNewTask = explicitlyStartsNewCompanionTask(taskTranscript);
  const continuationTarget = companionContinuationTarget({
    conversationMode: voiceDefault.conversationMode,
    transcript: taskTranscript,
    ...(attentionTarget === undefined ? {} : { attentionTarget }),
  });
  if (
    voiceDefault.conversationMode === "continue-last-thread" &&
    continuationTarget === undefined &&
    !explicitlyStartsNewTask &&
    attentionTarget === undefined
  ) {
    const message =
      "I don't have an exact task to continue yet. Open the task in the workspace, then wait for its next report or switch Voice defaults to start a new thread.";
    showCompanionStatus({
      state: "Choose the task to continue",
      detail: message,
      kind: "attention",
    });
    void speakCompanionSpeech(
      "I need the exact task before I can continue safely. Open it in the workspace, or switch me to a new thread.",
    ).catch(() => undefined);
    return { ok: false, message };
  }

  if (
    continuationTarget === undefined &&
    selectedProject === undefined &&
    !companionTranscriptHasProjectCue(taskTranscript) &&
    attentionTarget !== undefined
  ) {
    selectedProject = await resolveProjectTargetById(
      attentionTarget.projectId,
      attentionTarget.nodeId,
    );
  }
  if (continuationTarget === undefined && selectedProject === undefined) {
    selectedProject = await resolveProjectForTranscript({
      transcript: taskTranscript,
      requestId,
      originInteractionId,
    });
    if (selectedProject === undefined) return { ok: true };
  }

  // Recognition vocabulary is grounded in the live project catalog. Correct
  // only a clear entity match before the provider sees the task; never ask the
  // agent to infer a workspace from a sound-alike string.
  taskTranscript = canonicalizeCompanionTranscript(taskTranscript, [
    ...knownProjectTargets.values(),
  ]);

  const continuationContext =
    continuationTarget === undefined
      ? undefined
      : await resolveProjectContext(continuationTarget.projectId, continuationTarget.nodeId);
  const continuationNode =
    continuationTarget?.nodeId === undefined
      ? undefined
      : loadSavedNodes().find((node) => node.nodeId === continuationTarget.nodeId);
  if (continuationTarget?.nodeId !== undefined && continuationNode === undefined) {
    const message = "The Jarvis Host that owns this task is no longer paired.";
    showCompanionStatus({ state: "Reconnect the task's Host", detail: message, kind: "error" });
    void speakCompanionSpeech(message).catch(() => undefined);
    return { ok: false, message };
  }
  const selectedProjectNode =
    selectedProject === undefined ? undefined : nodeForProject(selectedProject);
  if (selectedProject?.nodeId !== undefined && selectedProjectNode === undefined) {
    const message = "The Jarvis Host that owns this project is no longer paired.";
    showCompanionStatus({ state: "Reconnect the project's Host", detail: message, kind: "error" });
    void speakCompanionSpeech(message).catch(() => undefined);
    return { ok: false, message };
  }
  const targetNode = continuationNode ?? selectedProjectNode ?? voiceDefault.node;
  const targetHost = targetNode.host;
  const targetModelSelection =
    targetNode.nodeId === voiceDefault.node.nodeId ? voiceDefault.modelSelection : undefined;
  const targetContext =
    continuationTarget === undefined
      ? projectTargetContext(selectedProject!)
      : (continuationContext ?? "Existing task · project details unavailable");
  const attentionBelongsToTargetNode =
    attentionTarget !== undefined &&
    (attentionTarget.nodeId !== undefined
      ? attentionTarget.nodeId === targetNode.nodeId
      : targetNode.nodeId === voiceDefault.node.nodeId);
  const requestProjectId = continuationTarget?.projectId ?? selectedProject!.id;
  const requestContextThreadId = continuationTarget?.threadId;
  const requestReferenceThreadId =
    attentionBelongsToTargetNode && attentionTarget !== undefined
      ? attentionTarget.threadId
      : undefined;
  const requestContinueContext = continuationTarget === undefined ? undefined : true;
  const savedSubmission = pendingSubmission;
  const retryingPendingSubmission =
    savedSubmission !== undefined &&
    savedSubmission.nodeId === targetNode.nodeId &&
    savedSubmission.projectId === requestProjectId &&
    savedSubmission.utterance === taskTranscript &&
    savedSubmission.contextThreadId === requestContextThreadId &&
    savedSubmission.referenceThreadId === requestReferenceThreadId &&
    savedSubmission.continueContext === requestContinueContext &&
    companionModelSelectionsMatch(savedSubmission.modelSelection, targetModelSelection);
  if (retryingPendingSubmission) {
    requestId = savedSubmission.requestId;
    originInteractionId = savedSubmission.originInteractionId;
  }
  const originNodeId = companionOriginNodeIdForInstallation(originInteractionId);
  showCompanionStatus({
    state: "Routing this safely",
    detail:
      continuationTarget === undefined
        ? `Starting a new task in ${selectedProject!.title}.`
        : "Returning to the exact conversation that asked for you.",
    kind: "routing",
    context: targetContext,
  });
  const submission: CompanionPendingSubmission = {
    requestId,
    originInteractionId,
    nodeId: targetNode.nodeId,
    projectId: requestProjectId,
    utterance: taskTranscript,
    ...(requestContextThreadId === undefined ? {} : { contextThreadId: requestContextThreadId }),
    ...(requestReferenceThreadId === undefined
      ? {}
      : { referenceThreadId: requestReferenceThreadId }),
    ...(requestContinueContext === undefined ? {} : { continueContext: requestContinueContext }),
    ...(targetModelSelection === undefined ? {} : { modelSelection: targetModelSelection }),
  };
  // Persist before crossing the network boundary. If the response is lost
  // after Host acceptance, a recreated Companion can retry the same payload
  // with the same idempotency key instead of starting a second task.
  savePendingSubmission(submission);
  // Hold the next speech position before the Host can emit a completion
  // report. Commit it only after acceptance so Jarvis never speaks a false
  // acknowledgement; release it on every non-acknowledgement result.
  const speechReservation = reserveNativeSpeech();
  const result = await submitCompanionTask({
    fetch: hostFetch,
    host: targetHost,
    utterance: taskTranscript,
    requestId,
    requestMetadata: {
      requestId,
      origin: { originNodeId, originInteractionId },
    },
    ...(continuationTarget === undefined
      ? explicitlyStartsNewTask
        ? {}
        : targetModelSelection === undefined
          ? {}
          : { modelSelection: targetModelSelection }
      : {
          projectId: continuationTarget.projectId,
          contextThreadId: continuationTarget.threadId,
          continueContext: true,
        }),
    ...(requestReferenceThreadId === undefined
      ? {}
      : { referenceThreadId: requestReferenceThreadId }),
    projectId: requestProjectId,
    ...(targetNode.nodeId.startsWith("legacy-host:")
      ? {}
      : {
          projectRef: {
            nodeId: targetNode.nodeId,
            projectId: requestProjectId,
          },
        }),
  });
  developmentDiagnostic("host-result", {
    kind: result.kind,
    ...(result.kind === "started" ? { threadId: result.threadId } : {}),
  });
  const acknowledgementText = acknowledgementReady()
    ? result.kind === "started"
      ? continuationTarget === undefined
        ? `On it in ${selectedProject!.title}. I'll let you know when there's something useful.${correctionSaveFailed ? " I couldn't save that pronunciation, so I may ask again next time." : ""}`
        : "Back on it. I'll let you know when there's something useful."
      : result.kind === "acknowledged"
        ? `${result.message}${correctionSaveFailed ? " I couldn't save that pronunciation, so I may ask again next time." : ""}`
        : undefined
    : undefined;
  if (acknowledgementText === undefined) {
    speechReservation.cancel();
    refreshTrayMenu();
  } else {
    void speechReservation
      .commit(acknowledgementText)
      .finally(refreshTrayMenu)
      .catch(() => undefined);
  }
  if (result.kind !== "error") savePendingSubmission(undefined);
  if (result.kind === "started") {
    if (!reportRelayAvailability.get(targetNode.nodeId)) connectReportRelay(targetNode);
    rememberAttentionTarget({
      nodeId: targetNode.nodeId,
      projectId: result.projectId,
      threadId: result.threadId,
    });
    if (continuationTarget === undefined) saveProject(selectedProject!);
    showCompanionStatus({
      state: continuationTarget === undefined ? "I’ve started the task" : "I’ve continued the task",
      detail: correctionSaveFailed
        ? `${result.objective} The pronunciation worked, but I couldn't save it for next time.`
        : result.objective,
      kind: "started",
      context: targetContext,
    });
    return { ok: true };
  }
  if (result.kind === "acknowledged") {
    if (result.threadId !== undefined) {
      rememberAttentionTarget({
        projectId: result.projectId ?? selectedProject!.id,
        threadId: result.threadId,
        nodeId: targetNode.nodeId,
      });
    }
    if (result.action === "focused" && selectedProject !== undefined) saveProject(selectedProject);
    showCompanionStatus({
      state:
        result.action === "queued"
          ? "Next step saved"
          : result.action === "steered"
            ? "Task updated"
            : result.action === "interrupted"
              ? "Task stopped"
              : result.action === "focused"
                ? "Project selected"
                : result.action === "projects-listed"
                  ? "Projects on this host"
                  : "Task status",
      detail: correctionSaveFailed
        ? `${result.message} I couldn't save that pronunciation for next time.`
        : result.message,
      kind: "completed",
      context: targetContext,
    });
    return { ok: true };
  }
  if (result.kind === "needs-input") {
    showCompanionStatus({
      state: "Jarvis needs one detail",
      detail: result.prompt,
      kind: "error",
    });
    void speakCompanionSpeech(result.prompt).catch(() => undefined);
    if (
      [
        "selection-unavailable",
        "provider-not-found",
        "provider-unavailable",
        "model-unavailable",
        "effort-missing",
        "effort-unavailable",
      ].includes(result.reason)
    ) {
      clearSavedDefault();
      openCompanionSetup();
    }
    return { ok: true };
  }
  showCompanionStatus({
    state: result.needsPairing ? "Reconnect Jarvis" : "Jarvis Host could not start the task",
    detail: result.message,
    kind: "error",
  });
  void speakCompanionSpeech(
    result.needsPairing
      ? "Jarvis needs a fresh pairing link."
      : "Jarvis Host could not start the task. Check the voice overlay for details.",
  ).catch(() => undefined);
  if (result.needsPairing) openCompanionSetup();
  if (result.reason === "project_not_found") {
    clearRememberedProject();
  }
  return { ok: false, message: result.message };
}

async function readSetup() {
  const node = loadSavedNode();
  if (node === undefined) {
    return {
      ok: true,
      connected: false,
      host: null,
      providers: [],
    } as const;
  }
  const providerCatalog = await getCompanionProviderCatalog({
    fetch: hostFetch,
    host: node.host,
    nodeId: node.nodeId,
    nodeLabel: node.displayName,
  });
  if (providerCatalog.kind === "error") {
    return {
      ok: false,
      message: providerCatalog.message,
      needsPairing: providerCatalog.needsPairing,
    } as const;
  }
  return {
    ok: true,
    connected: true,
    host: node.host,
    nodeId: node.nodeId,
    nodeLabel: node.displayName,
    providers: normalizeCompanionProviders(providerCatalog.providers),
    ...(loadSavedDefault(node.nodeId) === undefined
      ? {}
      : { defaultModelSelection: loadSavedDefault(node.nodeId) }),
    conversationMode: loadConversationMode(),
  } as const;
}

async function saveVoiceDefault(candidate: unknown) {
  const node = loadSavedNode();
  if (node === undefined) {
    return {
      ok: false,
      message: "Connect this companion to Jarvis Host first.",
      needsPairing: true,
    } as const;
  }
  const catalog = await getCompanionProviderCatalog({
    fetch: hostFetch,
    host: node.host,
    nodeId: node.nodeId,
    nodeLabel: node.displayName,
  });
  if (catalog.kind === "error") {
    if (catalog.needsPairing) openCompanionSetup();
    return {
      ok: false,
      message: catalog.message,
      needsPairing: catalog.needsPairing,
    } as const;
  }
  const selection = validateCompanionDefault({
    providers: readyCompanionProviders(normalizeCompanionProviders(catalog.providers)),
    candidate,
  });
  if (!selection.ok) return selection;
  saveDefault(selection.selection);
  return { ok: true } as const;
}

async function installVoiceHotkey() {
  if ((process.platform === "win32" || process.platform === "linux") && process.arch === "x64") {
    try {
      const { uIOhook } = await import("uiohook-napi");
      detachPushToTalk = attachPushToTalkHook({
        hook: uIOhook as PushToTalkHook,
        onPressed: startHeldCapture,
        onReleased: releaseHeldCapture,
      });
      hotkeyMode = "hold";
      refreshTrayMenu();
      return;
    } catch {
      // A local fallback remains useful if a device policy blocks the native hook.
    }
  }
  if (process.platform === "darwin") {
    hotkeyMode = "unavailable";
    refreshTrayMenu();
    return;
  }
  shortcutRegistered = globalShortcut.register("CommandOrControl+Shift+J", toggleTapCapture);
  hotkeyMode = shortcutRegistered ? "tap" : "unavailable";
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const speakLabel =
    hotkeyMode === "hold"
      ? "Hold Ctrl+Shift+J to talk"
      : hotkeyMode === "tap"
        ? "Tap Ctrl+Shift+J to start or send"
        : "Speak to Jarvis (hotkey unavailable)";
  const updateMenuItem = companionUpdateMenuItem({
    state: companionUpdateState,
    check: () => void companionUpdates?.check(),
    install: () => companionUpdates?.install(),
  });
  const aliasItems = [...knownProjectTargets.values()].flatMap((project) =>
    (project.aliasDetails ?? []).map((detail) => ({
      label: `${project.nodeLabel === undefined ? project.title : `${project.title} (${project.nodeLabel})`}: “${detail.alias}”`,
      click: async () => {
        const node = nodeForProject(project);
        if (node === undefined) return;
        const removed = await manageCompanionProjectAlias({
          fetch: hostFetch,
          host: node.host,
          projectId: project.id,
          ...(project.nodeId === undefined ? {} : { nodeId: project.nodeId }),
          alias: detail.alias,
          action: "remove",
        }).catch(() => false);
        if (!removed) await refreshRecognitionVocabulary();
        const stillPresent = knownProjectTargets
          .get(companionProjectKey(project))
          ?.aliases?.some(
            (candidate) =>
              candidate.toLocaleLowerCase("en-US") === detail.alias.toLocaleLowerCase("en-US"),
          );
        if (removed || stillPresent === false) {
          updateCachedAlias(project.id, detail.alias, true, project.nodeId);
          showCompanionStatus({
            state: "Pronunciation removed",
            detail: `Jarvis will ask again before treating “${detail.alias}” as ${project.title}.`,
            kind: "completed",
          });
        } else {
          showCompanionStatus({
            state: "Pronunciation wasn't removed",
            detail: "Jarvis Host could not update the project vocabulary. Try again.",
            kind: "error",
          });
        }
        refreshTrayMenu();
      },
    })),
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: speakLabel,
        click: toggleTapCapture,
      },
      {
        label: "Stop speaking",
        enabled: isNativeSpeechActive(),
        click: () => interruptCompanionSpeech("tray"),
      },
      {
        label: "Voice defaults…",
        click: openCompanionSetup,
      },
      {
        label: "Conversation mode",
        submenu: [
          {
            label: "Start each request in a new thread",
            type: "radio",
            checked: loadConversationMode() === "new-thread",
            click: () => {
              saveConversationMode("new-thread");
              refreshTrayMenu();
            },
          },
          {
            label: "Continue the latest reported thread",
            type: "radio",
            checked: loadConversationMode() === "continue-last-thread",
            click: () => {
              saveConversationMode("continue-last-thread");
              refreshTrayMenu();
            },
          },
        ],
      },
      (() => {
        const node = loadSavedNode();
        const connection =
          (node === undefined ? undefined : reportRelayConnections.get(node.nodeId)) ??
          (node === undefined
            ? { phase: "needs-pairing" as const }
            : { phase: "reconnecting" as const });
        const presentation = reportConnectionPresentation(connection);
        return {
          label: presentation.label,
          ...(connection.detail === undefined ? {} : { sublabel: connection.detail }),
          enabled: presentation.action !== "none",
          click: () => {
            if (presentation.action === "pair") {
              openCompanionSetup();
              return;
            }
            if (node !== undefined) connectReportRelay(node);
          },
        };
      })(),
      ...(!managedCompanionLaunch ? [updateMenuItem] : []),
      {
        label: `${APP_NAME} v${app.getVersion()}`,
        enabled: false,
      },
      {
        label: "Open Jarvis workspace in browser",
        enabled: loadSavedHost() !== null,
        click: () => {
          const host = loadSavedHost();
          if (host) void shell.openExternal(host);
        },
      },
      {
        label: "Learned project names",
        enabled: aliasItems.length > 0,
        submenu:
          aliasItems.length > 0 ? aliasItems : [{ label: "No learned names", enabled: false }],
      },
      { type: "separator" },
      {
        label: "Disconnect this companion",
        click: async () => {
          const node = loadSavedNode();
          if (node !== undefined) {
            const current = loadCompanionSettings();
            saveCompanionSettings(removeCompanionNode(current, node.nodeId));
            forgetProjectTargetsForNode(node.nodeId);
            disconnectReportRelay(node.nodeId);
          }
          attentionTarget = attentionTarget?.nodeId === node?.nodeId ? undefined : attentionTarget;
          if (node !== undefined) {
            await companionSession().clearStorageData({ origin: new URL(node.host).origin });
          }
          await loadSurface("setup", true);
          bubbleWindow?.showInactive();
          refreshTrayMenu();
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function start() {
  ensureCompanionOriginInteractionId();
  const settings = loadCompanionSettings();
  attentionTarget = settings.attentionTarget;
  pendingProjectTask = settings.pendingProjectTask;
  pendingSubmission = settings.pendingSubmission;
  for (const node of companionNodes(settings)) connectReportRelay(node);
  if (companionNodes(settings).length > 0) {
    void refreshRecognitionVocabulary();
    void upgradeLegacyNodeDescriptors();
  }
  createBubble(managedCompanionLaunch ? "voice" : undefined);
  if (!managedCompanionLaunch) {
    const iconPath = resolveCompanionTrayIconPath({
      packaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      exists: (path) => NodeFS.existsSync(path) && NodeFS.statSync(path).isFile(),
    });
    if (!NodeFS.existsSync(iconPath) || !NodeFS.statSync(iconPath).isFile()) {
      throw new Error(`Companion tray icon is missing: ${iconPath}`);
    }
    tray = new Tray(iconPath);
    tray.setToolTip(APP_NAME);
    tray.on("click", toggleTapCapture);
    refreshTrayMenu();
  }
  if (shouldInstallCompanionVoiceHotkey(packagedStartupSmoke)) {
    void installVoiceHotkey();
  }
  if (!managedCompanionLaunch)
    companionUpdates = configureCompanionUpdates({
      updater: electronCompanionUpdater,
      packaged: app.isPackaged,
      schedule: (delayMs, task, repeat = false) => {
        const controller = new AbortController();
        void (async () => {
          try {
            while (!controller.signal.aborted) {
              await NodeTimersPromises.setTimeout(delayMs, undefined, {
                signal: controller.signal,
              });
              if (!controller.signal.aborted) task();
              if (!repeat) break;
            }
          } catch {
            // Cancelling the updater cadence is normal during application quit.
          }
        })();
        return () => controller.abort();
      },
      onState: (state) => {
        const becameReady = companionUpdateState.status !== "ready" && state.status === "ready";
        companionUpdateState = state;
        refreshTrayMenu();
        if (becameReady && Notification.isSupported()) {
          new Notification({
            title: `${APP_NAME} update ready`,
            body: `Version ${state.version} is downloaded. Use the tray menu to restart and install it.`,
            silent: true,
          }).show();
        }
      },
    });

  ipcMain.handle(PAIR_CHANNEL, async (_event, candidate: unknown) => {
    if (!isBubbleSender(_event))
      return { ok: false, message: "This action is only available in Jarvis Companion." };
    if (typeof candidate !== "string")
      return { ok: false, message: "Paste the full pairing link." };
    const pairing = resolveCompanionLaunch({
      argv: [`--pairing-url=${candidate}`],
      savedHost: null,
    });
    if (pairing.kind !== "pairing")
      return {
        ok: false,
        message:
          "Paste the complete link ending in /pair#token=…, not only the Jarvis Host address.",
      };
    return pairHost(pairing.url);
  });
  ipcMain.handle(BUBBLE_READY_CHANNEL, (event) => {
    if (!isBubbleSender(event) || surface !== "voice") return { accepted: false };
    bubbleReady = true;
    if (managedCompanionLaunch && !managedCompanionReady) {
      managedCompanionReady = true;
      process.stdout.write(`${managedStatusLine("READY")}\n`);
    }
    flushVoiceOverlay();
    return { accepted: true };
  });
  ipcMain.handle(MANAGED_STATUS_CHANNEL, (event) => {
    if (!isBubbleSender(event)) return { managed: false, ready: false };
    return { managed: managedCompanionLaunch, ready: managedCompanionReady };
  });
  ipcMain.handle(SUBMIT_TRANSCRIPT_CHANNEL, async (event, transcript: unknown) => {
    if (!isBubbleSender(event)) {
      return { ok: false, message: "This action is only available in Jarvis Companion." };
    }
    if (typeof transcript !== "string" || transcript.trim().length === 0)
      return { ok: false, message: "No task was heard." };
    return await submitTranscriptToHost(transcript);
  });
  ipcMain.handle("jarvis-companion:get-setup", async (event) => {
    if (!isBubbleSender(event))
      return { ok: false, message: "This action is only available in Jarvis Companion." };
    return await readSetup();
  });
  ipcMain.handle("jarvis-companion:save-default", async (event, candidate: unknown) => {
    if (!isBubbleSender(event))
      return { ok: false, message: "This action is only available in Jarvis Companion." };
    return await saveVoiceDefault(candidate);
  });
  ipcMain.handle("jarvis-companion:save-conversation-mode", (event, candidate: unknown) => {
    if (!isBubbleSender(event)) {
      return { ok: false, message: "This action is only available in Jarvis Companion." };
    }
    const conversationMode = parseCompanionConversationMode(candidate);
    if (conversationMode === undefined) {
      return { ok: false, message: "Choose a valid conversation mode." };
    }
    saveConversationMode(conversationMode);
    refreshTrayMenu();
    return { ok: true };
  });
  ipcMain.handle("jarvis-companion:open-host", async (event) => {
    if (!isBubbleSender(event)) return false;
    const host = loadSavedHost();
    if (host === null) return false;
    await shell.openExternal(host);
    return true;
  });
  ipcMain.handle("jarvis-companion:minimize", (event) => {
    if (!isBubbleSender(event)) return;
    bubbleWindow?.hide();
  });
  ipcMain.handle("jarvis-companion:test-voice", async (event) => {
    if (!isBubbleSender(event))
      return { ok: false, message: "This action is only available in Jarvis Companion." };
    try {
      await speakCompanionSpeech("Jarvis Companion voice is ready.");
      return { ok: true };
    } catch (cause) {
      return { ok: false, message: companionSpeechFailureMessage(cause) };
    }
  });
  ipcMain.handle("jarvis-companion:set-attention-target", (event, target: unknown) => {
    const relayNode = relayNodeForSender(event);
    if (
      relayNode === undefined ||
      typeof target !== "object" ||
      target === null ||
      !("projectId" in target) ||
      !("threadId" in target) ||
      typeof target.projectId !== "string" ||
      typeof target.threadId !== "string" ||
      target.projectId.trim().length === 0 ||
      target.threadId.trim().length === 0
    ) {
      return { accepted: false };
    }
    rememberAttentionTarget({
      nodeId: relayNode.nodeId,
      projectId: target.projectId,
      threadId: target.threadId,
      ...("reportKind" in target &&
      ["completed", "waiting-for-input", "approval-needed", "failed"].includes(
        String(target.reportKind),
      )
        ? {
            reportKind: target.reportKind as
              | "completed"
              | "waiting-for-input"
              | "approval-needed"
              | "failed",
          }
        : {}),
    });
    return { accepted: true };
  });
  ipcMain.handle("jarvis-companion:task-status", async (event, status: unknown) => {
    const relayNode = relayNodeForSender(event);
    if (relayNode === undefined) return;
    if (
      typeof status !== "object" ||
      status === null ||
      !("state" in status) ||
      !("detail" in status) ||
      typeof status.state !== "string" ||
      typeof status.detail !== "string" ||
      !("kind" in status) ||
      typeof status.kind !== "string"
    ) {
      return;
    }
    const reportStatusId =
      "statusId" in status && typeof status.statusId === "string" ? status.statusId : undefined;
    if (reportStatusId !== undefined) latestRelayStatusIds.set(relayNode.nodeId, reportStatusId);
    const reportTarget = attentionTarget;
    const reportProjectContext =
      reportTarget === undefined
        ? undefined
        : await resolveProjectContext(reportTarget.projectId, reportTarget.nodeId);
    if (
      (reportStatusId !== undefined &&
        latestRelayStatusIds.get(relayNode.nodeId) !== reportStatusId) ||
      (reportTarget?.nodeId !== relayNode.nodeId &&
        !(reportTarget?.nodeId === undefined && relayWindows.size === 1)) ||
      reportTarget?.projectId !== attentionTarget?.projectId ||
      reportTarget?.threadId !== attentionTarget?.threadId
    ) {
      return;
    }
    showCompanionStatus({
      state: status.state,
      detail: status.detail,
      kind: status.kind,
      ...("context" in status && typeof status.context === "string"
        ? { context: status.context }
        : reportProjectContext === undefined
          ? {}
          : { context: reportProjectContext }),
      ...("stream" in status && typeof status.stream === "boolean"
        ? { stream: status.stream }
        : {}),
      ...("statusId" in status && typeof status.statusId === "string"
        ? { statusId: status.statusId }
        : {}),
    });
  });
  ipcMain.handle(PREPARE_SPEECH_CHANNEL, async (event) => {
    if (!isRelaySender(event)) return { ready: false };
    await prepareNativeSpeech();
    return { ready: true };
  });
  ipcMain.handle(SPEAK_CHANNEL, async (event, text: unknown) => {
    if (!isRelaySender(event)) return;
    if (typeof text !== "string" || text.trim().length === 0) return;
    await speakCompanionSpeech(text.trim());
  });
  ipcMain.handle(INTERRUPT_SPEECH_CHANNEL, (event) => {
    if (!isBubbleSender(event)) return { accepted: false };
    return interruptCompanionSpeech("overlay");
  });
  ipcMain.handle(FINISH_STATUS_CHANNEL, (event, statusId: unknown) => {
    const relayNode = relayNodeForSender(event);
    if (
      relayNode === undefined ||
      typeof statusId !== "string" ||
      latestBubbleStatus?.kind !== "completed" ||
      latestBubbleStatus.statusId !== statusId ||
      latestRelayStatusIds.get(relayNode.nodeId) !== statusId
    ) {
      return { accepted: false };
    }
    scheduleBubbleHide(voiceOverlaySpeechGraceDelay);
    return { accepted: true };
  });
  ipcMain.handle(REPORT_RELAY_STATUS_CHANNEL, (event, available: unknown, detail?: unknown) => {
    const relayNode = relayNodeForSender(event);
    if (relayNode === undefined) return { accepted: false };
    if (typeof available !== "boolean") return { accepted: false };
    reportRelayAvailability.set(relayNode.nodeId, available);
    reportRelayConnections.set(relayNode.nodeId, {
      phase: available ? "connected" : "reconnecting",
      ...(typeof detail === "string" && detail.trim().length > 0
        ? { detail: detail.trim().slice(0, 240) }
        : {}),
    });
    // The reporter emits `false` once on mount before its environment catalog
    // has connected. Only a positive report-subscription signal proves the
    // managed helper is ready; transport errors and the bounded timeout handle
    // the negative path.
    if (available) resolveReportRelayReadiness(relayNode.nodeId, true);
    refreshTrayMenu();
    return { accepted: true };
  });
  void runDevelopmentScenario();
}

/**
 * The packaged startup probe deliberately owns only the shell lifecycle. It
 * must prove that a produced Companion can construct its bubble and tray, but
 * it must not start the normal network/update/hotkey path (or touch audio).
 * Speech and native-loading coverage belong to --speech-smoke instead.
 */
function startPackagedStartupSmoke() {
  const iconPath = NodePath.join(process.resourcesPath, "icon.png");
  if (!NodeFS.existsSync(iconPath) || !NodeFS.statSync(iconPath).isFile()) {
    throw new Error(`Packaged Companion tray icon is missing: ${iconPath}`);
  }
  createBubble("setup");
  tray = new Tray(iconPath);
  tray.setToolTip(APP_NAME);
  return iconPath;
}

if (packagedSpeechSmoke) {
  void app
    .whenReady()
    .then(async () => {
      configureCompanionVoiceResources();
      prepareNativeMicrophone();
      await Promise.all([prepareParakeetRecognition(parakeetPaths().paths), prepareNativeSpeech()]);
      await speakCompanionSpeech("Jarvis Companion voice is ready.");
      await disposeNativeSpeech();
      app.exit(0);
    })
    .catch(async (cause: unknown) => {
      await disposeNativeSpeech();
      process.stderr.write(
        `${cause instanceof Error ? (cause.stack ?? cause.message) : "Packaged speech smoke failed."}\n`,
      );
      app.exit(1);
    });
} else if (packagedStartupSmoke) {
  void app
    .whenReady()
    .then(() => {
      const iconPath = startPackagedStartupSmoke();
      if (tray === undefined || tray.isDestroyed()) {
        throw new Error("Packaged Companion startup did not retain a live tray.");
      }
      const startupProbePath = resolveCompanionStartupProbePath();
      if (startupProbePath !== null) {
        writeCompanionStartupReceipt(startupProbePath, {
          version: app.getVersion(),
          platform: process.platform,
        });
      }
      process.stdout.write(`COMPANION_STARTUP_SMOKE_READY tray=true icon=${iconPath}\n`);
      app.exit(0);
    })
    .catch((cause: unknown) => {
      process.stderr.write(
        `${cause instanceof Error ? (cause.stack ?? cause.message) : "Packaged startup smoke failed."}\n`,
      );
      app.exit(1);
    });
} else if (
  !app.requestSingleInstanceLock(
    managedPairingUrl === null ? undefined : { pairingUrl: managedPairingUrl },
  )
) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv, _workingDirectory, additionalData) => {
    const pairingUrl =
      typeof additionalData === "object" &&
      additionalData !== null &&
      "pairingUrl" in additionalData &&
      typeof additionalData.pairingUrl === "string"
        ? additionalData.pairingUrl
        : undefined;
    const launch = resolveCompanionLaunch({
      argv,
      savedHost: loadSavedHost(),
      ...(pairingUrl === undefined ? {} : { pairingUrl }),
    });
    if (launch.kind === "pairing") {
      void pairHost(launch.url);
      return;
    }
    toggleTapCapture();
  });
  app.whenReady().then(() => {
    configureCompanionVoiceResources();
    start();
    void prepareParakeetRecognition(parakeetPaths().paths).catch((cause) =>
      developmentDiagnostic("recognition-warm-failed", {
        message: cause instanceof Error ? cause.message : "Parakeet could not warm.",
      }),
    );
    const launch = resolveCompanionLaunch({
      argv: process.argv,
      savedHost: loadSavedHost(),
      ...(managedPairingUrl === null ? {} : { pairingUrl: managedPairingUrl }),
    });
    if (launch.kind === "pairing") void pairHost(launch.url);
  });
  app.on("will-quit", () => {
    companionUpdates?.dispose();
    void disposeCompanionLocalRuntime({
      disposeSpeech: disposeNativeSpeech,
      clearCaptureDeadlines: () => {
        if (captureTimeout !== undefined) NodeTimers.clearTimeout(captureTimeout);
        if (firstAudioFrameTimeout !== undefined) NodeTimers.clearTimeout(firstAudioFrameTimeout);
        captureTimeout = undefined;
        firstAudioFrameTimeout = undefined;
      },
      cancelCapture: () => {
        companionShuttingDown = true;
        activeParakeetCapture?.cancel();
        activeParakeetCapture = undefined;
        captureInFlight = false;
        capturePending = false;
      },
    });
  });
}

app.on("will-quit", () => {
  interruptNativeSpeech();
  detachPushToTalk?.();
  globalShortcut.unregisterAll();
});
