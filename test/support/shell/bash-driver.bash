# Driver for bash.ts. Run as:  bash --noprofile --norc bash-driver.bash
#
# Invokes a bash completion function the way readline would, without a
# terminal: it sources bash-completion and the script under test, looks up the
# function registered for the command (`complete -p`), sets COMP_WORDS /
# COMP_CWORD / COMP_LINE / COMP_POINT and calls it, then dumps COMPREPLY.
#
# Inputs (environment):
#   CAP_DIR              scratch dir containing `words` (NUL-separated
#                        COMP_WORDS), `cword`, `line`, `point`
#   CAP_SCRIPT           completion script under test
#   CAP_NAME             command name
#   CAP_BASH_COMPLETION  bash-completion main script to source ("" = none)
#   CAP_CWD              working directory
#
# Outputs (files in $CAP_DIR): reply (NUL-separated COMPREPLY), spec (output of
# `complete -p`), compopt (NUL-separated argument strings of compopt calls),
# status (exit status of the completion function).
# Exit status: 0 ok, 2 setup error, 6 no completion registered for CAP_NAME.

cd -- "${CAP_CWD:?}" || exit 2

# Some bash-completion loaders only do anything in "interactive-looking" shells.
PS1='$ '

if [[ -n ${CAP_BASH_COMPLETION:-} ]]; then
  # shellcheck disable=SC1090
  . "$CAP_BASH_COMPLETION" >/dev/null 2>&1
fi

# `compopt` only works while readline is running a completion function; called
# from here it fails with "not currently executing completion function". Record
# the calls (so tests can assert e.g. nospace/filenames) and swallow errors.
compopt() {
  printf '%s\0' "$*" >> "$CAP_DIR/compopt"
  builtin compopt "$@" 2>/dev/null
  return 0
}

# shellcheck disable=SC1090
. "$CAP_SCRIPT" || exit 2

spec=$(complete -p -- "$CAP_NAME" 2>/dev/null) || exit 6
printf '%s' "$spec" > "$CAP_DIR/spec"
re='-F ([^ ]+)'
[[ $spec =~ $re ]] || exit 6
fn=${BASH_REMATCH[1]}

COMP_WORDS=()
while IFS= read -r -d '' w; do COMP_WORDS+=("$w"); done < "$CAP_DIR/words"
COMP_CWORD=$(<"$CAP_DIR/cword")
COMP_LINE=$(<"$CAP_DIR/line")
COMP_POINT=$(<"$CAP_DIR/point")
COMP_TYPE=9 # TAB (normal completion)
COMP_KEY=9
COMPREPLY=()

cur=${COMP_WORDS[COMP_CWORD]}
prev=''
((COMP_CWORD > 0)) && prev=${COMP_WORDS[COMP_CWORD - 1]}

# Same arguments readline passes: command name, current word, previous word.
"$fn" "${COMP_WORDS[0]}" "$cur" "$prev" < /dev/null
printf '%s' "$?" > "$CAP_DIR/status"

: > "$CAP_DIR/reply"
for r in "${COMPREPLY[@]}"; do printf '%s\0' "$r" >> "$CAP_DIR/reply"; done
exit 0
