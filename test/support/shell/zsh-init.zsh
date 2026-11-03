# Sourced (as $ZDOTDIR/.zshrc) by the interactive zsh that runs inside the
# zpty spawned by zsh-driver.zsh. It loads compsys, sources the completion
# script under test and instruments completion so that every match the
# completion system *really adds* is recorded in a file.
#
# Inputs (environment):
#   CAP_DIR     scratch directory (see zsh-driver.zsh / zsh.ts for layout)
#   CAP_SCRIPT  path of the completion script under test
#
# Outputs (files in $CAP_DIR):
#   pid         $$ of this shell (liveness check for the driver)
#   ready       created by zle-line-init once ZLE is reading the terminal
#   matches     one record per added match (see __cap_record)
#   state       compstate snapshot taken at the end of _main_complete
#   result      BUFFER/CURSOR after the completion widget finished
#   done        created last; the driver waits for it
#   init-error  created if sourcing the script failed

print -r -- $$ >| "$CAP_DIR/pid"

# No prompts: keeps the pty transcript readable and avoids prompt hooks.
PS1='' PS2='' RPS1='' PROMPT_EOL_MARK=''
unsetopt beep
# Never ask "do you wish to see all N possibilities?" (it would block).
LISTMAX=1000000
# A real size so ZLE/listing code behaves like in a normal terminal.
stty rows 100 cols 250 2>/dev/null

autoload -Uz compinit && compinit -u -D
zstyle ':completion:*' list-prompt ''
zstyle ':completion:*' select-prompt ''

# The record separators used in $CAP_DIR/matches. They are control characters
# that cannot reasonably occur in file names or Tab candidates.
typeset -g __cap_fs=$'\x1f' __cap_rs=$'\x1e'

if ! source "$CAP_SCRIPT"; then
  : >| "$CAP_DIR/init-error"
fi

# --- compadd wrapper ---------------------------------------------------------
# Every completer (_describe, _files/_path_files, _arguments, ...) ends up
# calling `compadd`. We shadow it with a function that (1) asks the builtin
# which of the offered words actually match the current word (-O/-D do the
# matching without adding anything), (2) records them, and (3) runs the real
# builtin with the original arguments so completion proceeds unchanged and the
# final BUFFER is exactly what an interactive user would get.
compadd() {
  setopt local_options extended_glob
  # Option letters of compadd that take an argument (attached or separate).
  local __cap_argopts='PSpsiIWdJVXxrRMFOADE'
  local -A __cap_o
  local __cap_flags='' __cap_a __cap_c
  integer __cap_i=1 __cap_j
  while (( __cap_i <= $# )); do
    __cap_a=${argv[__cap_i]}
    [[ $__cap_a == (-|--) ]] && break
    [[ $__cap_a == -?* ]] || break
    __cap_j=2
    while (( __cap_j <= $#__cap_a )); do
      __cap_c=${__cap_a[__cap_j]}
      if [[ $__cap_argopts == *$__cap_c* ]]; then
        if (( __cap_j < $#__cap_a )); then
          __cap_o[$__cap_c]=${__cap_a[__cap_j+1,-1]}
        else
          (( __cap_i++ ))
          __cap_o[$__cap_c]=${argv[__cap_i]}
        fi
        break
      elif [[ $__cap_c == o ]]; then
        # -o takes an optional sort-order argument, attached or (as used by
        # zsh 5.9's _describe: `-o nosort`) as the next word.
        local __cap_ord='(match|nosort|numeric|reverse)'
        if (( __cap_j == $#__cap_a )) &&
           [[ ${argv[__cap_i+1]-} == ${~__cap_ord}(,${~__cap_ord})# ]]; then
          (( __cap_i++ ))
        fi
        break
      fi
      __cap_flags+=$__cap_c
      (( __cap_j++ ))
    done
    (( __cap_i++ ))
  done

  # Query-only calls (used internally by completers to test words) never add
  # matches: just delegate.
  if (( ${+__cap_o[O]} || ${+__cap_o[A]} || ${+__cap_o[D]} )); then
    builtin compadd "$@"
    return
  fi

  # Display strings (-d) are passed as an array name or an inline "(...)" list.
  local -a __cap_hits __cap_disp
  if (( ${+__cap_o[d]} )); then
    if [[ ${__cap_o[d]} == \(* ]]; then
      eval "__cap_disp=${__cap_o[d]}"
    else
      __cap_disp=( "${(@P)__cap_o[d]}" )
    fi
  fi
  # -O: matching words; -D: the parallel display array filtered the same way.
  builtin compadd -O __cap_hits -D __cap_disp "$@"

  local __cap_w __cap_ins __cap_path __cap_isdir
  integer __cap_k
  for (( __cap_k = 1; __cap_k <= $#__cap_hits; __cap_k++ )); do
    __cap_w=${__cap_hits[__cap_k]}
    # What zsh inserts: IPREFIX, -P and -p verbatim; the word itself is
    # quoted by zsh unless -Q was given (then the caller pre-quoted it).
    if [[ $__cap_flags == *Q* ]]; then
      __cap_ins=$__cap_w
    else
      __cap_ins=${(q)__cap_w}
    fi
    __cap_ins="$IPREFIX${__cap_o[P]}${__cap_o[p]}$__cap_ins${__cap_o[s]}"
    # -f (file) matches: zsh appends '/' to directories. Per the compadd docs
    # the file tested is (-W dir)(-p prefix)(word), but _path_files passes a
    # -W that already includes the typed path, so accept either. Words (and
    # -p) are pre-quoted when -Q is set, so unquote before testing.
    __cap_isdir=0
    if [[ $__cap_flags == *f* ]]; then
      [[ $__cap_flags == *Q* ]] && __cap_w=${(Q)__cap_w}
      __cap_path="${(Q)__cap_o[p]}$__cap_w"
      if [[ -n ${__cap_o[W]-} ]]; then
        [[ -d ${__cap_o[W]%/}/$__cap_path || -d ${__cap_o[W]%/}/$__cap_w ]] && __cap_isdir=1
      else
        [[ -d $__cap_path ]] && __cap_isdir=1
      fi
      __cap_w=${__cap_hits[__cap_k]}
    fi
    # Field order is parsed by zsh.ts (parseRecords) -- keep in sync.
    __cap_record M "$__cap_flags" "$IPREFIX" "${__cap_o[P]}" "${__cap_o[p]}" \
      "$__cap_w" "${__cap_o[s]}" "${+__cap_o[S]}${__cap_o[S]-}" "${__cap_o[W]-}" \
      "${__cap_disp[__cap_k]-}" "$__cap_isdir" "$__cap_ins" "${(Q)__cap_ins}"
  done
  builtin compadd "$@"
}

# Append one record: fields joined by \x1f, terminated by \x1e.
__cap_record() {
  local IFS=$__cap_fs
  print -rn -- "$*$__cap_rs" >> "$CAP_DIR/matches"
}

# Snapshot of the completion state after all completers ran.
__cap_post() {
  {
    print -r -- "nmatches=${compstate[nmatches]}"
    print -r -- "unambiguous=${compstate[unambiguous]}"
    print -r -- "insert=${compstate[insert]}"
    print -r -- "context=${compstate[context]}"
  } >| "$CAP_DIR/state"
}
comppostfuncs+=( __cap_post )

# TAB runs this widget: normal completion, then dump the resulting buffer.
__cap_complete() {
  : >| "$CAP_DIR/matches"
  zle complete-word
  print -rn -- "BUFFER=$BUFFER"$'\x1e'"CURSOR=$CURSOR"$'\x1e' >| "$CAP_DIR/result"
  : >| "$CAP_DIR/done"
}
zle -N __cap_complete
bindkey '^I' __cap_complete

# Tell the driver that ZLE is up and reading keystrokes.
__cap_line_init() { : >| "$CAP_DIR/ready" }
zle -N zle-line-init __cap_line_init
