// @effect-diagnostics-next-line nodeBuiltinImport:off -- A sync hash names the folder at module load.
import * as NodeCrypto from "node:crypto";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

// Shells T3 Code starts mark their prompts with OSC 133, so libghostty-vt
// clears the prompt rows the shell redraws after a resize instead of keeping
// a stale copy.
const ZSHENV = `# T3 Code points ZDOTDIR here so zsh reads this file, then this folder's
# .zshrc, and each hands over to the user's own startup file.
__t3code_dir="$ZDOTDIR"
if (( $+T3CODE_ZSH_ZDOTDIR )); then
  builtin export ZDOTDIR="$T3CODE_ZSH_ZDOTDIR"
  builtin unset T3CODE_ZSH_ZDOTDIR
else
  builtin unset ZDOTDIR
fi
if [[ -r "\${ZDOTDIR:-$HOME}/.zshenv" ]]; then
  builtin source "\${ZDOTDIR:-$HOME}/.zshenv"
fi
# Only an interactive non-login shell goes on to this folder's .zshrc; a
# login shell would read .zprofile and .zlogin from here too.
if [[ -o interactive && ! -o login ]]; then
  if (( $+ZDOTDIR )); then
    __t3code_user_zdotdir="$ZDOTDIR"
  fi
  builtin export ZDOTDIR="$__t3code_dir"
fi
builtin unset __t3code_dir
`;

const ZSHRC = `if (( $+__t3code_user_zdotdir )); then
  builtin export ZDOTDIR="$__t3code_user_zdotdir"
  builtin unset __t3code_user_zdotdir
else
  builtin unset ZDOTDIR
fi
if [[ -r "\${ZDOTDIR:-$HOME}/.zshrc" ]]; then
  builtin source "\${ZDOTDIR:-$HOME}/.zshrc"
fi

# Mark the prompt with OSC 133 so the terminal knows which rows zsh redraws
# after a resize and clears them first. A starts the prompt, and redraw=1 says
# zsh redraws it, which libghostty-vt doesn't assume unless told. I starts the
# input, which ends at the end of the line, where the command's output starts.
__t3code_mark_prompt() {
  builtin local ret=$?
  # Prompt themes rebuild PS1 in their own precmd, so this one runs last.
  if [[ "\${precmd_functions[-1]}" != __t3code_mark_prompt ]]; then
    precmd_functions=("\${(@)precmd_functions:#__t3code_mark_prompt}" __t3code_mark_prompt)
  fi
  if [[ -o prompt_percent && "$PS1" != *$'\\e]133;A;redraw=1\\a'* ]]; then
    PS1=$'%{\\e]133;A;redraw=1\\a%}'"$PS1"$'%{\\e]133;I\\a%}'
  fi
  return $ret
}
builtin typeset -ga precmd_functions
precmd_functions+=(__t3code_mark_prompt)
`;

const BASH_RCFILE = `# T3 Code starts bash in POSIX mode with ENV pointing here, as Ghostty's shell
# integration does. A POSIX-mode shell reads only this file, so it turns POSIX
# mode off and reads the startup files bash would have read. A login shell
# stays one: \`shopt login_shell\` is on and ~/.bash_logout runs on exit.
if [[ -n "$T3CODE_BASH_INJECT" ]]; then
  builtin unset ENV T3CODE_BASH_INJECT
  if [[ -n "$T3CODE_BASH_ENV" ]]; then
    builtin export ENV="$T3CODE_BASH_ENV"
    builtin unset T3CODE_BASH_ENV
  fi
  builtin set +o posix
  builtin shopt -u inherit_errexit 2>/dev/null
  if [[ -n "$T3CODE_BASH_UNEXPORT_HISTFILE" ]]; then
    builtin export -n HISTFILE
    builtin unset T3CODE_BASH_UNEXPORT_HISTFILE
  fi
  if builtin shopt -q login_shell; then
    if [[ -r /etc/profile ]]; then builtin source /etc/profile; fi
    for __t3code_rc in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
      if [[ -r "$__t3code_rc" ]]; then
        builtin source "$__t3code_rc"
        break
      fi
    done
  else
    # Where bash reads a system bashrc depends on how it was built.
    for __t3code_rc in /etc/bash.bashrc /etc/bash/bashrc /etc/bashrc; do
      if [[ -r "$__t3code_rc" ]]; then
        builtin source "$__t3code_rc"
        break
      fi
    done
    if [[ -r "$HOME/.bashrc" ]]; then builtin source "$HOME/.bashrc"; fi
  fi
  builtin unset __t3code_rc
fi

# Mark the prompt's last line with OSC 133, the only line bash draws again
# after a resize, so the terminal clears it first. P starts the prompt; I
# starts the input, which ends at the end of the line, where output starts.
# OSC 133;A;redraw=1, printed before bash draws the prompt, says bash redraws
# it, which libghostty-vt doesn't assume unless told. bash 3.2's readline
# miscounts a wrapped prompt's marks, so its prompts stay unmarked.
__t3code_mark_prompt() {
  builtin local ret=$?
  case "$PS1" in
    *'\\e]133;P;k=i\\a'*) ;;
    # A literal newline may sit inside $(...), where a mark would break it.
    *$'\\n'*) return $ret ;;
    *'\\n'*) PS1="\${PS1%'\\n'*}"'\\n\\[\\e]133;P;k=i\\a\\]'"\${PS1##*'\\n'}"'\\[\\e]133;I\\a\\]' ;;
    *) PS1='\\[\\e]133;P;k=i\\a\\]'"$PS1"'\\[\\e]133;I\\a\\]' ;;
  esac
  builtin printf '\\e]133;A;redraw=1\\a' >&2
  return $ret
}
if (( BASH_VERSINFO[0] >= 4 )); then
  if [[ "$(builtin declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    PROMPT_COMMAND+=(__t3code_mark_prompt)
  else
    PROMPT_COMMAND="\${PROMPT_COMMAND:+$PROMPT_COMMAND$'\\n'}__t3code_mark_prompt"
  fi
fi
`;

const FILES = [
  ["zsh/.zshenv", ZSHENV],
  ["zsh/.zshrc", ZSHRC],
  ["bash/t3code.bash", BASH_RCFILE],
] as const;

// Servers of different versions can share a T3 home; each keeps its own files.
const FOLDER = NodeCrypto.createHash("sha256")
  .update(FILES.flat().join("\0"))
  .digest("hex")
  .slice(0, 12);

export interface ShellIntegrationPaths {
  readonly zdotdir: string;
  readonly bashRcfile: string;
}

export const writeShellIntegration = Effect.fn("TerminalShellIntegration.write")(function* (
  baseDir: string,
) {
  const path = yield* Path.Path;
  const directory = path.join(baseDir, FOLDER);
  for (const [name, contents] of FILES) {
    yield* writeFileStringAtomically({ filePath: path.join(directory, name), contents });
  }
  return {
    zdotdir: path.join(directory, "zsh"),
    bashRcfile: path.join(directory, "bash", "t3code.bash"),
  } satisfies ShellIntegrationPaths;
});

export function withShellIntegration(input: {
  readonly shell: string;
  readonly shellName: string;
  readonly platform: NodeJS.Platform;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly paths: ShellIntegrationPaths;
}): { readonly args: ReadonlyArray<string>; readonly env: NodeJS.ProcessEnv } {
  const { shell, shellName, platform, args, env, paths } = input;
  if (shellName === "zsh") {
    return {
      args,
      env: {
        ...env,
        ZDOTDIR: paths.zdotdir,
        ...(env.ZDOTDIR === undefined ? {} : { T3CODE_ZSH_ZDOTDIR: env.ZDOTDIR }),
      },
    };
  }
  if (shellName === "bash" && bashReadsEnvInPosixMode(shell, platform)) {
    const home = env.HOME;
    // T3 Code starts bash with no arguments or with -l; anything else is left as it is.
    if (home === undefined || args.some((arg) => arg !== "-l")) return { args, env };
    return {
      // bash takes long options only before short ones such as -l.
      args: ["--posix", ...args],
      env: {
        ...env,
        ENV: paths.bashRcfile,
        T3CODE_BASH_INJECT: "1",
        ...(env.ENV === undefined ? {} : { T3CODE_BASH_ENV: env.ENV }),
        // POSIX mode would keep history in ~/.sh_history.
        ...(env.HISTFILE === undefined
          ? { HISTFILE: `${home}/.bash_history`, T3CODE_BASH_UNEXPORT_HISTFILE: "1" }
          : {}),
      },
    };
  }
  return { args, env };
}

// Apple's bash 3.2 in /bin/bash doesn't read ENV in POSIX mode, so it would start
// without the user's files. As in Ghostty, it starts as before, and so does a bare
// "bash" on macOS, which may resolve to it. The caller passes the shell's real path,
// so a link to /bin/bash counts as /bin/bash.
function bashReadsEnvInPosixMode(shell: string, platform: NodeJS.Platform): boolean {
  return platform !== "darwin" || (shell.startsWith("/") && shell !== "/bin/bash");
}
