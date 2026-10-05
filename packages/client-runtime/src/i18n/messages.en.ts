/**
 * Every message a client can display, in the source language.
 *
 * `en` is authoritative: its keys define what is translatable, and every other
 * catalog falls back to it. Keep values byte-identical to the literals they
 * replace so behaviour does not shift while the UI is being migrated.
 *
 * Interpolation uses i18next's `{{name}}` syntax. Plurals use the `_one` /
 * `_other` suffixes; a language with one form (Chinese, Japanese) only needs
 * `_other`, since i18next falls back to it for every count.
 *
 * Not every message is translatable text: provider names (Codex, Claude Code)
 * and shell commands are deliberately absent, because a client must never
 * rename another product or rewrite a command it tells the user to run.
 */
export const en = {
  // Shared across steps.
  "wizard.continue": "Continue",
  "wizard.retry": "Retry",
  "wizard.close": "Close",
  "wizard.run": "Run",
  "wizard.install": "Install",
  "wizard.signIn": "Sign in",
  "wizard.ready": "Ready",
  "wizard.checking": "Checking...",
  "wizard.disabled": "Disabled",
  "wizard.computer": "Computer",

  // Steps.
  "wizard.step.connect": "Connect",
  "wizard.step.agents": "Agents",
  "wizard.step.projects": "Projects",

  // Connection step.
  "wizard.connection.title": "Connect your computers",
  "wizard.connection.description":
    "Choose one or more computers. We’ll set up agents and projects on each.",
  "wizard.connection.computersToSetUp": "Computers to set up",
  "wizard.connection.addComputer": "Add a computer",
  "wizard.connection.loadingComputers": "Loading computers…",
  "wizard.connection.loadingSignIn": "Loading sign-in…",
  "wizard.connection.t3Connect": "T3 Connect",
  "wizard.connection.noComputersLinked": "No computers linked yet.",
  "wizard.connection.runOnEachComputer": "Run this on each computer you want to connect.",
  "wizard.connection.keepRunning":
    "Keep T3 Code running. Select the computers you want to set up above.",
  "wizard.connection.pairingLink": "Pairing link",
  "wizard.connection.needPairingLink": "Need a pairing link?",
  "wizard.connection.runOnCodeComputer": "Run this on the computer with your code.",
  "wizard.connection.startFirstOrRun": "Start T3 Code first, or run ",
  "wizard.connection.addTailscale_before": ". Add ",
  "wizard.connection.tailnetSuffix": " to use your tailnet.",
  "wizard.connection.pair": "Pair",
  "wizard.connection.pairing": "Pairing...",
  "wizard.connection.pairingFailed": "Pairing failed.",
  "wizard.connection.connected": "Connected",
  "wizard.connection.connecting": "Connecting…",
  "wizard.connection.connectAnotherChatGpt": "Connect another ChatGPT account",

  // Agents step.
  "wizard.header.title": "Set up T3 Code",
  "wizard.agents.connectTitle": "Connect your agents",
  "wizard.agents.connectDescription": "Choose an agent to start coding. You can add more later.",
  "wizard.agents.readyToCode": "Ready to code.",
  "wizard.agents.reviewCommand": "Review the command, then press Enter to run it.",
  "wizard.agents.couldNotOpenTerminal": "Could not open the setup terminal.",
  "wizard.agents.preparingCommand": "Preparing command...",
  /**
   * Split around an inline command element so each language owns its own
   * spacing and word order: English needs a space around the command, Chinese
   * does not.
   */
  "wizard.runInTerminal_before": "Run ",
  "wizard.runInTerminal_after": " in this terminal.",
  "wizard.agents.terminalLabel": "Install {{driver}}",
  "wizard.agents.copyCommand": "Copy command",

  // Projects step.
  "wizard.projects.title": "Your projects",
  "wizard.projects.chooseTitle": "Choose your projects",
  "wizard.projects.chooseDescription":
    "Import projects and conversations from your selected computers.",
  "wizard.projects.lookingForProjects": "Looking for projects…",
  "wizard.projects.lookingForImported": "Looking for projects from Claude Code and Codex…",
  "wizard.projects.noneFound": "No existing Claude Code or Codex projects found.",
  "wizard.projects.couldNotCheck": "Could not check projects. {{error}}",
  "wizard.projects.doNotImport": "Do not import projects",
  "wizard.projects.selectAll": "Select all",
  "wizard.projects.selectNone": "Select none",
  "wizard.projects.otherFolders": "Other folders",
  "wizard.projects.importing": "Importing…",
  "wizard.projects.folderCount_one": "{{count}} folder",
  "wizard.projects.folderCount_other": "{{count}} folders",
  "wizard.projects.selectedCount": "{{selected}} of {{total}} selected",
  "wizard.projects.importCount_one": "Import {{count}} project",
  "wizard.projects.importCount_other": "Import {{count}} projects",
  "wizard.projects.scanLimitReached":
    "Scan limit reached. Some projects or conversations may be missing.",

  // Import results.
  "wizard.import.imported_one": "Imported {{count}} thread",
  "wizard.import.imported_other": "Imported {{count}} threads",
  "wizard.import.skipped_one": "{{count}} thread could not be imported.",
  "wizard.import.skipped_other": "{{count}} threads could not be imported.",
  "wizard.import.importedWithRemaining_one":
    "Imported {{count}} thread. Some thread history could not be imported.",
  "wizard.import.importedWithRemaining_other":
    "Imported {{count}} threads. Some thread history could not be imported.",
  "wizard.import.couldNotImport": "Could not import thread history.",
  "wizard.import.someHistoryNotImported": "Some history was not imported",
  /**
   * Joins the two sentences of the partial-import warning. Its own message
   * because the separator is punctuation, not whitespace: Chinese needs its
   * own full stop rather than a Latin period followed by a space.
   */
  "wizard.import.sentenceSeparator": ". ",

  // Completion.
  "wizard.completion.couldNotFinish": "Could not finish setup",
  "wizard.completion.settingsNotSaved": "Your settings could not be saved. Try again.",

  // Settings row for choosing the interface language.
  "settings.language.title": "Language",
  "settings.language.description": "System default follows your browser or OS language.",
  "settings.language.system": "System default",
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;
