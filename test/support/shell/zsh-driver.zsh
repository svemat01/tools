# Driver for zsh.ts. Run as:  zsh -f zsh-driver.zsh
#
# Spawns an interactive zsh inside a pseudo-terminal (zsh/zpty), waits until
# its line editor is ready, types the command line followed by TAB, waits for
# the instrumented completion widget (zsh-init.zsh) to signal completion, then
# tears the pty down.
#
# Inputs (environment):
#   CAP_DIR         scratch dir; must contain `line` (the text to type) and
#                   home/.zshrc (which sources zsh-init.zsh)
#   CAP_TIMEOUT_MS  overall deadline (default 5000)
#   CAP_CWD         directory the interactive shell starts in
#
# Exit status: 0 ok, 2 setup error, 3 timed out before ZLE was ready,
# 4 timed out waiting for completion, 5 interactive shell died.
# The raw pty transcript is written to $CAP_DIR/transcript for debugging.

zmodload zsh/zpty zsh/datetime zsh/zselect || exit 2

local dir=${CAP_DIR:?}
local -F deadline=$(( EPOCHREALTIME + ${CAP_TIMEOUT_MS:-5000} / 1000.0 ))
local transcript='' chunk

cleanup() {
  # `zpty -d` alone is not enough when the completion is stuck in a command
  # substitution (e.g. a hanging CLI): the HUP is deferred and the whole tree
  # lingers. The interactive shell runs with job control, so it leads its own
  # process group, which also contains the CLI it spawned: kill that group.
  local pid
  [[ -e $dir/pid ]] && pid=$(<$dir/pid)
  if [[ $pid == <-> ]]; then
    kill -KILL -$pid 2>/dev/null
    kill -KILL $pid 2>/dev/null
  fi
  zpty -d cap 2>/dev/null
  print -rn -- "$transcript" >| "$dir/transcript"
}
trap 'cleanup; exit 4' INT TERM HUP

cd -- "${CAP_CWD:-$dir}" || exit 2

# -d: skip /etc/zshrc & co; ZDOTDIR (set by zsh.ts) points at our .zshrc.
# -i: interactive, so ZLE and the completion widgets are active.
zpty cap zsh -d -i || exit 2

# Drain pty output (so the child never blocks on a full pty buffer) and keep
# it for debugging. Returns 1 if the deadline passed.
pump() {
  while zpty -rt cap chunk 2>/dev/null; do transcript+=$chunk; done
  (( EPOCHREALTIME < deadline ))
}

# Wait for `$1` to appear; fails with $2 on timeout or $3 if the shell died.
wait_for() {
  until [[ -e $dir/$1 ]]; do
    pump || { cleanup; exit $2 }
    # (`zpty -t` can block, so liveness is checked via the pid the shell wrote.)
    [[ ! -e $dir/pid ]] || kill -0 $(<$dir/pid) 2>/dev/null || { pump; cleanup; exit $3 }
    zselect -t 1 # 10ms
  done
}

wait_for ready 3 5

# Type the line and press TAB in one write; -n: no trailing newline.
zpty -n -w cap "$(<$dir/line)"$'\t'

wait_for done 4 5
pump
cleanup
exit 0
