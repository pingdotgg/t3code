autoload -Uz compinit colors vcs_info

if [ -d /usr/share/zsh/site-functions ]; then
  fpath=(/usr/share/zsh/site-functions $fpath)
fi

if [ -d /usr/share/zsh/vendor-completions ]; then
  fpath=(/usr/share/zsh/vendor-completions $fpath)
fi

compinit
colors

setopt auto_cd
setopt interactive_comments
setopt prompt_subst
setopt complete_in_word
setopt always_to_end

HISTFILE=$HOME/.zsh_history
HISTSIZE=10000
SAVEHIST=10000
setopt hist_ignore_dups
setopt share_history

zstyle ':completion:*' menu select
zstyle ':completion:*' matcher-list 'm:{a-zA-Z}={A-Za-z}'
zstyle ':completion:*' list-colors ''${(s.:.)LS_COLORS}
zstyle ':completion:*' completer _complete _match _approximate

zstyle ':vcs_info:*' enable git
zstyle ':vcs_info:git:*' formats ' %F{magenta}(%b)%f'
precmd() { vcs_info }

export CLICOLOR=1
export LS_COLORS='di=1;34:ln=1;36:so=1;35:pi=33:ex=1;32:bd=1;33:cd=1;33:su=37;41:sg=30;43:tw=30;42:ow=34;42'
export EDITOR=vim
export VISUAL=vim
export PAGER=less
export FZF_DEFAULT_COMMAND='fd --type f --hidden --follow --exclude .git'
export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"
export ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE='fg=8'

alias ls='ls --color=auto -F'
alias ll='ls -lah'
alias la='ls -A'
alias grep='grep --color=auto'
alias diff='diff --color=auto'
alias cat='bat --style=plain'

if [ -f /usr/share/doc/fzf/examples/key-bindings.zsh ]; then
  source /usr/share/doc/fzf/examples/key-bindings.zsh
fi

if [ -f /usr/share/doc/fzf/examples/completion.zsh ]; then
  source /usr/share/doc/fzf/examples/completion.zsh
fi

if [ -f /usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh ]; then
  source /usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh
fi

if [ -f /usr/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh ]; then
  source /usr/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh
fi

PROMPT='%F{green}%n@%m%f %F{cyan}%~%f${vcs_info_msg_0_}
%F{yellow}%#%f '
