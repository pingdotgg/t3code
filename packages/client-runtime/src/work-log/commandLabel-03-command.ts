

export type CommandWrapper = "env" | "sudo";
export type CommandProgramContext = "exec" | "shell";

export const MAX_COMMAND_SEGMENTS = 64;

export const SHELL_PROGRAMS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "fish"]);
export const WINDOWS_SHELL_PROGRAMS = new Set([
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
]);
export const SHELL_OPTIONS_WITH_VALUE = new Set(["-o", "-O", "--rcfile", "--init-file"]);
export const SHELL_COMMAND_WRAPPERS = new Set(["builtin", "command", "exec"]);
export const SHELL_PRECOMMAND_MODIFIERS = new Set(["nocorrect", "noglob", "time"]);
export const POWERSHELL_SETUP_PROGRAMS = new Set(["pop-location", "push-location", "set-location"]);
export const POWERSHELL_FLAGS = new Set(["-mta", "-nologo", "-noninteractive", "-noprofile", "-sta"]);
export const POWERSHELL_OPTIONS_WITH_VALUE = new Set([
  "-configurationname",
  "-executionpolicy",
  "-inputformat",
  "-outputformat",
  "-version",
  "-windowstyle",
  "-workingdirectory",
]);
export const START_PROCESS_FLAGS = new Set([
  "-confirm",
  "-debug",
  "-loaduserprofile",
  "-nonewwindow",
  "-passthru",
  "-usenewenvironment",
  "-verbose",
  "-wait",
  "-whatif",
]);
export const START_PROCESS_OPTIONS_WITH_VALUE = new Set([
  "-argumentlist",
  "-credential",
  "-environment",
  "-erroraction",
  "-errorvariable",
  "-informationaction",
  "-informationvariable",
  "-outbuffer",
  "-outvariable",
  "-pipelinevariable",
  "-progressaction",
  "-redirectstandarderror",
  "-redirectstandardinput",
  "-redirectstandardoutput",
  "-verb",
  "-warningaction",
  "-warningvariable",
  "-windowstyle",
  "-workingdirectory",
]);
export const SKIPPABLE_SUDO_PROBES = new Set(["[", "[[", "test", "true"]);
export const NON_PROGRAM_PREFIX_CHARACTERS = "<>(){}[];|&$`#!%@:";
export const NON_PROGRAM_SUFFIX_CHARACTERS = "){]}`";

export const NON_DESCRIPTIVE_SHELL_PROGRAMS = new Set([
  "!",
  "#",
  ".",
  ":",
  "[",
  "[[",
  "alias",
  "and",
  "autoload",
  "begin",
  "bg",
  "bind",
  "bindkey",
  "break",
  "builtin",
  "caller",
  "case",
  "catch",
  "cd",
  "command",
  "compgen",
  "complete",
  "compopt",
  "continue",
  "coproc",
  "declare",
  "dirs",
  "disown",
  "do",
  "done",
  "elif",
  "else",
  "enable",
  "end",
  "esac",
  "eval",
  "exec",
  "exit",
  "export",
  "false",
  "fc",
  "fg",
  "fi",
  "finally",
  "for",
  "foreach",
  "function",
  "getopts",
  "history",
  "if",
  "in",
  "jobs",
  "let",
  "local",
  "logout",
  "mapfile",
  "nocorrect",
  "noglob",
  "not",
  "or",
  "popd",
  "pushd",
  "read",
  "readarray",
  "readonly",
  "repeat",
  "return",
  "select",
  "set",
  "setopt",
  "shift",
  "shopt",
  "source",
  "switch",
  "suspend",
  "test",
  "then",
  "time",
  "times",
  "trap",
  "try",
  "true",
  "type",
  "typeset",
  "ulimit",
  "umask",
  "unalias",
  "until",
  "unset",
  "unsetopt",
  "wait",
  "while",
]);

export type ShellCommandSplit = {
  readonly firstCommand: string;
  readonly remainingCommand: string | null;
  readonly separator: string | null;
};

export type Heredoc = {
  readonly delimiter: string;
  readonly stripTabs: boolean;
};

export type ShellSeparator = {
  readonly index: number;
  readonly length: number;
};

export type ShellCommentRange = {
  readonly start: number;
  readonly end: number;
};

export type PowerShellAssignment = {
  readonly matched: boolean;
  readonly program: string | null;
};

export type WindowsShellPayload = {
  readonly matched: boolean;
  readonly program: string | null;
};

