#!/bin/bash
# First SSO outside the Raycast worker. Raycast unloads commands that block
# through a browser login ("Worker unloaded"). This process stays alive.
set -u
set -o pipefail
export PATH="${GP_PRIVILEGED_PATH:-/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin}"

LOCK_FILE="/var/run/gpclient.lock"
CONNECT_LOG="/tmp/gpclient-raycast-connect.log"

# Quote a string as an AppleScript literal via JSON.
osascript_quote() {
  /usr/bin/python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"
}

# Record the error for the menu's Copy last error item, then notify.
fail() {
  local msg="$1"
  mkdir -p "$(dirname "${GP_LAST_ERROR}")" "$(dirname "${GP_ERROR_LOG}")"
  local at
  at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s\n%s\n' "$at" "$msg" >"${GP_LAST_ERROR}"
  printf '%s %s\n' "$at" "$msg" >>"${GP_ERROR_LOG}"
  progress_fail "$msg"
  local short
  short="$(printf '%s' "$msg" | tr '\n' ' ')"
  if [ "${#short}" -gt 180 ]; then
    short="${short:0:177}..."
  fi
  osascript -e "display notification $(osascript_quote "$short") with title \"VPN SSO sign-in\"" >/dev/null 2>&1 || true
  exit 1
}

# Update the menu-bar step list. No-op when GP_PROGRESS is unset.
progress_cmd() {
  if [ -z "${GP_PROGRESS:-}" ] || [ ! -f "${GP_PROGRESS_PY:-}" ]; then
    return 0
  fi
  /usr/bin/python3 "${GP_PROGRESS_PY}" "$@" 2>/dev/null || true
}

progress_set() {
  progress_cmd set "$GP_PROGRESS" "$1" "$2"
}

progress_ok() {
  progress_cmd ok "$GP_PROGRESS"
}

progress_fail() {
  progress_cmd fail "$GP_PROGRESS" "$1"
}

notify_ok() {
  progress_set tunnel done
  progress_ok
  osascript -e 'display notification "VPN connected" with title "VPN SSO sign-in"' >/dev/null 2>&1 || true
}

# Wait until gpclient writes its lock file (tunnel is up), not until it exits.
wait_for_tunnel() {
  local i
  for i in $(seq 1 90); do
    if [ -s "$LOCK_FILE" ]; then
      notify_ok
      return 0
    fi
    sleep 1
  done
  return 1
}

: "${GP_PORTAL:?}" "${GP_GATEWAY:?}" "${GP_COOKIE:?}" "${GP_GPAUTH:?}" "${GP_GPCLIENT:?}"
: "${GP_LAST_ERROR:?}" "${GP_ERROR_LOG:?}" "${GP_USER:?}"
GP_SLICE="${GP_SLICE:-}"
CONFIG_DIR="$(dirname "${GP_COOKIE}")"
GP_GROUP="$(id -gn)"

osascript -e 'display notification "Finish SSO in the browser" with title "VPN SSO sign-in"' >/dev/null 2>&1 || true

stderr_file="$(mktemp /tmp/gpclient-raycast-gpauth.XXXXXX)"
stdin_file="$(mktemp /tmp/gpclient-raycast-stdin.XXXXXX)"
root_script="$(mktemp /tmp/gpclient-raycast-root.XXXXXX)"
trap 'rm -f "$stderr_file" "$stdin_file" "$root_script"' EXIT
chmod 600 "$stdin_file"

if ! cookie="$("${GP_GPAUTH}" "${GP_PORTAL}" --browser default 2>"$stderr_file")"; then
  fail "gpauth failed: $(tr '\n' ' ' <"$stderr_file")"
fi
cookie="$(printf '%s' "$cookie" | tr -d '\r')"
if [ -z "$cookie" ]; then
  fail "gpauth produced no cookie. Finish SSO, add 1 to globalprotectcallback if the URL has no 1, then retry."
fi
printf '%s\n' "$cookie" >"$stdin_file"
progress_set cookie done

connect_args=(
  connect "${GP_PORTAL}"
  --cookie-on-stdin
  --gateway "${GP_GATEWAY}"
  --csc no
  --no-dtls
  --cookie-cache "${GP_COOKIE}"
)
if [ -n "$GP_SLICE" ]; then
  connect_args+=(-s "$GP_SLICE")
fi

sudo_err="$(mktemp /tmp/gpclient-raycast-sudo.XXXXXX)"
trap 'rm -f "$stderr_file" "$stdin_file" "$root_script" "$sudo_err"' EXIT

: >"$CONNECT_LOG"
# Leave the tunnel running after this script exits; otherwise disconnect has to
# signal a process still parented by osascript, which ignores SIGINT.
nohup sudo -n --preserve-env=PATH "${GP_GPCLIENT}" "${connect_args[@]}" \
  <"$stdin_file" >"$CONNECT_LOG" 2>&1 &
disown || true
progress_set connect done
sleep 1
if grep -qiE 'password is required|a terminal is required|no tty present|a password is required' "$CONNECT_LOG"; then
  :
elif grep -qi 'already running' "$CONNECT_LOG"; then
  fail "$(tr '\n' ' ' <"$CONNECT_LOG")"
elif wait_for_tunnel; then
  exit 0
else
  fail "gpclient did not come up: $(tr '\n' ' ' <"$CONNECT_LOG")"
fi

# Cookie dir is often 0700 root from an earlier sudo gpclient. chown it in the
# same admin dialog as connect so Raycast can later see cookie.json.
{
  printf '#!/bin/bash\nset -euo pipefail\n'
  printf 'export PATH=%s\n' "$(printf '%q' "$PATH")"
  printf 'mkdir -p %s\n' "$(printf '%q' "$CONFIG_DIR")"
  printf 'chown %s:%s %s || true\n' "$(printf '%q' "$GP_USER")" "$(printf '%q' "$GP_GROUP")" "$(printf '%q' "$CONFIG_DIR")"
  printf 'chmod 755 %s || true\n' "$(printf '%q' "$CONFIG_DIR")"
  printf 'nohup %s' "$(printf '%q' "$GP_GPCLIENT")"
  for arg in "${connect_args[@]}"; do
    printf ' %s' "$(printf '%q' "$arg")"
  done
  printf ' < %s >%s 2>&1 &\n' "$(printf '%q' "$stdin_file")" "$(printf '%q' "$CONNECT_LOG")"
  printf 'disown || true\n'
  printf 'for i in $(seq 1 90); do\n'
  printf '  if [ -s %s ]; then\n' "$(printf '%q' "$LOCK_FILE")"
  printf '    chown %s:%s %s || true\n' "$(printf '%q' "$GP_USER")" "$(printf '%q' "$GP_GROUP")" "$(printf '%q' "$GP_COOKIE")"
  printf '    chmod 600 %s || true\n' "$(printf '%q' "$GP_COOKIE")"
  printf '    exit 0\n'
  printf '  fi\n'
  printf '  sleep 1\n'
  printf 'done\n'
  printf 'exit 1\n'
} >"$root_script"
chmod 700 "$root_script"

quoted="$(osascript_quote "/bin/bash ${root_script}")"
if ! osascript -e "do shell script ${quoted} with administrator privileges" 2>"$sudo_err"; then
  fail "$(cat "$sudo_err")"
fi
if ! wait_for_tunnel; then
  fail "gpclient did not come up: $(tr '\n' ' ' <"$CONNECT_LOG") $(cat "$sudo_err")"
fi
exit 0
