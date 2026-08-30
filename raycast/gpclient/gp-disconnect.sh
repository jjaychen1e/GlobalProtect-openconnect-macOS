#!/bin/bash
# Stop the CLI tunnel without spawning a second `gpclient`.
# While a tunnel is up, a new `gpclient` process is SIGKILL'd (exit 137).
set -u

LOCK="/var/run/gpclient.lock"
SESSION=""
if [ -n "${SUDO_USER:-}" ]; then
  SESSION="/Users/${SUDO_USER}/.config/gpclient/session.pid"
else
  # osascript `with administrator privileges` does not set SUDO_USER.
  for f in /Users/*/.config/gpclient/session.pid; do
    if [ -r "$f" ]; then
      SESSION="$f"
      break
    fi
  done
fi

pid=""
if [ -r "$LOCK" ]; then
  pid="$(tr -d ' \n' <"$LOCK")"
elif [ -n "$SESSION" ] && [ -r "$SESSION" ]; then
  pid="$(tr -d ' \n' <"$SESSION")"
fi

# Already down.
if [ -z "$pid" ] || ! /bin/kill -0 "$pid" 2>/dev/null; then
  rm -f "$LOCK"
  if [ -n "$SESSION" ]; then
    rm -f "$SESSION"
  fi
  exit 0
fi

/bin/kill -s TERM "$pid" 2>/dev/null || true
i=0
while [ "$i" -lt 8 ]; do
  if ! /bin/kill -0 "$pid" 2>/dev/null; then
    break
  fi
  sleep 1
  i=$((i + 1))
done
if /bin/kill -0 "$pid" 2>/dev/null; then
  /bin/kill -s KILL "$pid" 2>/dev/null || true
  sleep 1
fi

rm -f "$LOCK"
if [ -n "$SESSION" ]; then
  rm -f "$SESSION"
fi

if /bin/kill -0 "$pid" 2>/dev/null; then
  echo "PID $pid still running after SIGKILL" >&2
  exit 1
fi
exit 0
