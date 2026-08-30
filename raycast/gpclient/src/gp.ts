import {
  Clipboard,
  environment,
  getPreferenceValues,
  showHUD,
} from "@raycast/api";
import { execFileSync } from "child_process";
import { randomBytes } from "crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  unlinkSync,
  openSync,
  readSync,
  closeSync,
  statSync,
  accessSync,
  constants,
} from "fs";
import { homedir, tmpdir, userInfo } from "os";
import { dirname, join } from "path";
import {
  beginProgress,
  failProgress,
  isProgressRunning,
  progressLogPath,
  progressPath,
  setProgressStep,
  succeedProgress,
} from "./progress";

const PRIVILEGED_PATH =
  "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin";

export interface Preferences {
  portal: string;
  gateway: string;
  gateways: string;
  cookiePath: string;
}

/** Read Raycast extension preferences. */
export function prefs(): Preferences {
  return getPreferenceValues<Preferences>();
}

/** Cookie file path. Always an absolute user-home path so root `gpclient` does not write `/var/root`. */
export function cookiePath(values = prefs()): string {
  const custom = values.cookiePath?.trim();
  if (custom) {
    return custom;
  }
  return join(homedir(), ".config/gpclient/cookie.json");
}

/** True when a cookie cache file exists on disk. */
export function cookieExists(values = prefs()): boolean {
  return existsSync(cookiePath(values));
}

/** True when the current user can read cookie.json (root 0600 files fail this). */
export function cookieReadable(values = prefs()): boolean {
  try {
    accessSync(cookiePath(values), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Last error text from the most recent Reconnect/Disconnect attempt. */
export function lastErrorPath(): string {
  return join(homedir(), "Library/Logs/gpclient-raycast-last.txt");
}

/** Append-only log of privileged command failures. */
export function errorLogPath(): string {
  return join(homedir(), "Library/Logs/gpclient-raycast.log");
}

/** Path for nohup output from Reconnect. */
export function reconnectLogPath(): string {
  return join(homedir(), "Library/Logs/gpclient-raycast-reconnect.log");
}

/** Path for nohup output from the browser SSO sign-in. */
export function firstLoginLogPath(): string {
  return join(homedir(), "Library/Logs/gpclient-raycast-first-login.log");
}

export interface LogFile {
  key: string;
  title: string;
  path: string;
}

/** The log files the Logs command tails, in the order they are shown. */
export function logFiles(): LogFile[] {
  return [
    { key: "reconnect", title: "Reconnect", path: reconnectLogPath() },
    { key: "first-login", title: "SSO sign-in", path: firstLoginLogPath() },
    { key: "progress", title: "Progress", path: progressLogPath() },
    { key: "errors", title: "Errors", path: errorLogPath() },
  ];
}

/**
 * Open a log file in Console.app, which tails it live. Creates the file first:
 * `open` fails on a path that gpclient has not written yet.
 */
export function openInConsole(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, "");
  }
  execFileSync(
    "open",
    ["-a", "/System/Applications/Utilities/Console.app", path],
    { timeout: 10_000 },
  );
}

/** Menu-bar subtitle telling how stale a log is, e.g. `12m ago` or `no output yet`. */
export function logAge(path: string, now = Date.now()): string {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return "no output yet";
  }
  if (stats.size === 0) {
    return "empty";
  }
  const minutes = Math.floor((now - stats.mtimeMs) / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

export interface LogGroup {
  file: LogFile;
  /** Newest line first. Empty when the file is missing or has no output yet. */
  lines: string[];
  exists: boolean;
  modified?: Date;
}

/**
 * Tail one log file, or every log file when `key` is undefined.
 * @param key `LogFile.key` to read, or undefined for all files.
 * @param maxLines Lines kept per file.
 */
export function readLogGroups(key?: string, maxLines = 300): LogGroup[] {
  return logFiles()
    .filter((file) => !key || file.key === key)
    .map((file) => {
      let modified: Date | undefined;
      try {
        modified = statSync(file.path).mtime;
      } catch {
        // File not created yet.
      }
      return {
        file,
        lines: tailLines(file.path, maxLines).reverse(),
        exists: modified !== undefined,
        modified,
      };
    });
}

/** Chronological plain text of the last `maxLines` lines per group, for the clipboard. */
export function formatLogTail(groups: LogGroup[], maxLines = 50): string {
  return groups
    .map((group) => {
      const body = group.lines.slice(0, maxLines).reverse().join("\n");
      return `# ${group.file.title} — ${group.file.path}\n${body || "(empty)"}`;
    })
    .join("\n\n");
}

/**
 * Last `maxLines` non-empty lines of a file, oldest first. Only the final
 * `maxBytes` are read, so a log that grew for weeks stays cheap to open.
 */
export function tailLines(
  path: string,
  maxLines: number,
  maxBytes = 256 * 1024,
): string[] {
  let handle: number | undefined;
  try {
    const size = statSync(path).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    handle = openSync(path, "r");
    readSync(handle, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    if (length < size) {
      // First line is cut in the middle by the byte window.
      lines.shift();
    }
    return lines
      .map((line) => stripAnsi(line).trimEnd())
      .filter((line) => line.length > 0)
      .slice(-maxLines);
  } catch {
    return [];
  } finally {
    if (handle !== undefined) {
      closeSync(handle);
    }
  }
}

/** Drop terminal colour codes so gpclient output is readable in a Raycast list. */
function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

/** Copy the error and show a HUD. Menu-bar commands cannot use Toast. */
export async function notifyFailure(message: string): Promise<void> {
  await Clipboard.copy(message);
  const hud = message.length > 90 ? `${message.slice(0, 87)}…` : message;
  try {
    await showHUD(hud);
  } catch {
    notifyMac(hud);
  }
}

/** Notification Center. Works from the interval menu bar; HUD/Toast often do not. */
export function notifyMac(message: string, title = "VPN"): void {
  try {
    execFileSync(
      "osascript",
      [
        "-e",
        `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
      ],
      { timeout: 5000 },
    );
  } catch {
    // Notification Center can be disabled; the helper still runs.
  }
}

/** Read the last recorded error, if any. */
export function readLastError(): string {
  try {
    return readFileSync(lastErrorPath(), "utf8").trim();
  } catch {
    return "";
  }
}

/** Default gateway plus extra hostnames from preferences and cookie.json. */
export function gatewayList(values = prefs()): string[] {
  const extra = (values.gateways ?? "")
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);
  return [
    ...new Set(
      [values.gateway, ...cookieGateways(values), ...extra].filter(Boolean),
    ),
  ];
}

/**
 * Structured split-tunnel settings, edited by the Split Tunnel command.
 * Three separate lists because vpn-slice treats them differently:
 * `dnsDomains` only affect name resolution, `subnets` and `hosts` add routes.
 */
export interface SplitTunnelConfig {
  /** `--domains-vpn-dns`: any depth under these resolves through the VPN DNS. */
  dnsDomains: string[];
  /** `-d`: search domain, so short names like `wiki` resolve. */
  searchDomain: string;
  /** CIDRs routed into the tunnel, e.g. `10.0.0.0/8`. */
  subnets: string[];
  /** Individual hosts. Needed for names whose address falls outside `subnets`. */
  hosts: string[];
}

const EMPTY_SPLIT_TUNNEL: SplitTunnelConfig = {
  dnsDomains: [],
  searchDomain: "",
  subnets: [],
  hosts: [],
};

function splitTunnelPath(): string {
  return join(environment.supportPath, "split-tunnel.json");
}

/** Structured config, or undefined before the Split Tunnel command has saved one. */
export function splitTunnelConfig(): SplitTunnelConfig | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(splitTunnelPath(), "utf8"),
    ) as Partial<SplitTunnelConfig>;
    return {
      dnsDomains: parsed.dnsDomains ?? [],
      searchDomain: parsed.searchDomain ?? "",
      subnets: parsed.subnets ?? [],
      hosts: parsed.hosts ?? [],
    };
  } catch {
    return undefined;
  }
}

export function saveSplitTunnelConfig(config: SplitTunnelConfig): void {
  mkdirSync(environment.supportPath, { recursive: true });
  writeFileSync(splitTunnelPath(), JSON.stringify(config, null, 2));
}

/** Start the editor from an empty config. */
export function emptySplitTunnelConfig(): SplitTunnelConfig {
  return { ...EMPTY_SPLIT_TUNNEL, dnsDomains: [], subnets: [], hosts: [] };
}

/** Render the structured config back into a single `-s` argument. */
export function buildVpnSliceArg(config: SplitTunnelConfig): string {
  const parts = ["vpn-slice"];
  if (config.searchDomain.trim()) {
    parts.push("-d", config.searchDomain.trim());
  }
  if (config.dnsDomains.length) {
    parts.push("--domains-vpn-dns", config.dnsDomains.join(","));
  }
  parts.push(...config.subnets, ...config.hosts);
  return parts.length > 1 ? parts.join(" ") : "";
}

/** The `-s` argument for gpclient. Empty when nothing has been configured yet. */
export function vpnSliceArg(): string {
  const config = splitTunnelConfig();
  return config ? buildVpnSliceArg(config) : "";
}

/** `split` routes only the vpn-slice hosts; `full` sends everything through the tunnel. */
export type TunnelMode = "split" | "full";

/** Chosen tunnel mode. Lives in the extension support dir so every command agrees. */
function tunnelModePath(): string {
  return join(environment.supportPath, "tunnel-mode");
}

export function tunnelMode(): TunnelMode {
  try {
    return readFileSync(tunnelModePath(), "utf8").trim() === "full"
      ? "full"
      : "split";
  } catch {
    return "split";
  }
}

/** Persist the mode. It only takes effect on the next connect, not the live tunnel. */
export function setTunnelMode(mode: TunnelMode): void {
  mkdirSync(environment.supportPath, { recursive: true });
  writeFileSync(tunnelModePath(), mode);
}

/** Gateway session, as reported by the gateway on connect. */
export interface SessionExpiry {
  /** Unix seconds when the gateway will drop the session. */
  userExpires: number;
  /** Portal policy. When false nothing renews the session; a new SSO is required. */
  allowExtendSession: boolean;
}

/** Written by gpclient next to cookie.json while the tunnel is up. */
function sessionInfoPath(values = prefs()): string {
  return join(dirname(cookiePath(values)), "session.json");
}

/**
 * Session expiry from `session.json`, falling back to the last
 * `VPN session info:` line in the reconnect log (older gpclient builds).
 */
export function sessionExpiry(values = prefs()): SessionExpiry | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(sessionInfoPath(values), "utf8"),
    ) as {
      userExpires?: number;
      allowExtendSession?: boolean;
    };
    if (parsed.userExpires) {
      return {
        userExpires: parsed.userExpires,
        allowExtendSession: Boolean(parsed.allowExtendSession),
      };
    }
  } catch {
    // Not written yet, or gpclient predates session.json.
  }

  const lines = tailLines(reconnectLogPath(), 4000).filter((line) =>
    line.includes("VPN session info:"),
  );
  const last = lines[lines.length - 1];
  if (!last) {
    return undefined;
  }
  const expires = /user_expires=(\d+)/.exec(last);
  if (!expires) {
    return undefined;
  }
  return {
    userExpires: Number(expires[1]),
    allowExtendSession: /allow_extend_session=true/.test(last),
  };
}

/** `6d 8h` / `45m` / `expired`. */
export function formatRemaining(userExpires: number, now = Date.now()): string {
  const secs = userExpires - Math.floor(now / 1000);
  if (secs <= 0) {
    return "expired";
  }
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  const minutes = Math.floor((secs % 3600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/**
 * Terminal equivalent of the browser SSO sign-in. Includes `--cookie-cache` so
 * later Reconnect can skip the browser. Do not add `--os-version`: spoofing
 * 13.4.0 while gpauth reports the real macOS string caused HTTP 512.
 */
export function firstLoginCommand(values = prefs()): string {
  const slice = tunnelMode() === "full" ? "" : vpnSliceArg();
  const gpauth = gpauthBin();
  const gpclient = gpclientBin();
  return `${gpauth} ${values.portal} --browser default 2>/dev/null | sudo ${gpclient} connect ${values.portal} --cookie-on-stdin --gateway ${values.gateway} --no-dtls --csc no --cookie-cache ${JSON.stringify(cookiePath(values))}${slice ? ` -s ${JSON.stringify(slice)}` : ""}`;
}

/** Homebrew ARM first. Do not fall back to `/usr/local/bin` (old 2.4.5). */
function gpclientBin(): string {
  const arm = "/opt/homebrew/bin/gpclient";
  return existsSync(arm) ? arm : "gpclient";
}

/**
 * Kill wrapper. A second `gpclient` process is SIGKILL'd (exit 137) while a
 * tunnel is up, so Disconnect must not invoke `gpclient`.
 */
function gpDisconnectBin(): string {
  const arm = "/opt/homebrew/bin/gp-disconnect";
  if (existsSync(arm)) {
    return arm;
  }
  const message =
    "Missing /opt/homebrew/bin/gp-disconnect. Run: bash raycast/gpclient/install-sudoers.sh";
  recordError(message);
  throw new Error(message);
}

/** Same Homebrew preference as `gpclientBin`. */
function gpauthBin(): string {
  const arm = "/opt/homebrew/bin/gpauth";
  return existsSync(arm) ? arm : "gpauth";
}

/** The gateway last written to cookie.json, else the Default gateway preference. */
export function currentGateway(values = prefs()): string {
  try {
    const parsed = JSON.parse(readFileSync(cookiePath(values), "utf8")) as {
      last_gateway?: string;
    };
    const last = parsed.last_gateway?.trim();
    if (last) {
      return last;
    }
  } catch {
    // Unreadable or missing cookie.
  }
  return values.gateway;
}

/** Gateway hostnames stored from the last portal getconfig. Ignores auth fields. */
function cookieGateways(values = prefs()): string[] {
  try {
    const parsed = JSON.parse(readFileSync(cookiePath(values), "utf8")) as {
      last_gateway?: string;
      gateways?: string[];
    };
    return [...(parsed.gateways ?? []), parsed.last_gateway ?? ""].filter(
      Boolean,
    );
  } catch {
    return [];
  }
}

/** Flatten execFileSync stdout/stderr into one string. */
function formatExecError(error: unknown): string {
  if (error && typeof error === "object") {
    const execError = error as {
      message?: string;
      stderr?: Buffer | string;
      stdout?: Buffer | string;
    };
    const stderr = bufferText(execError.stderr);
    const stdout = bufferText(execError.stdout);
    return [execError.message, stderr, stdout]
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return String(error);
}

function bufferText(value?: Buffer | string): string {
  if (!value) {
    return "";
  }
  return Buffer.isBuffer(value) ? value.toString("utf8") : value;
}

/** Persist the error so the menu can copy it after the HUD disappears. */
function recordError(message: string): void {
  const stamped = `${new Date().toISOString()} ${message}\n`;
  mkdirSync(dirname(errorLogPath()), { recursive: true });
  writeFileSync(lastErrorPath(), message);
  appendFileSync(errorLogPath(), stamped);
}

function sudoNeedsPassword(message: string): boolean {
  return /password is required|a terminal is required|no tty present/i.test(
    message,
  );
}

/**
 * Run a Homebrew binary as root. Uses passwordless sudo when configured,
 * otherwise falls back to the macOS admin-password dialog.
 */
function runSudoBin(bin: string, args: string[], stdin?: string): void {
  const env = { ...process.env, PATH: PRIVILEGED_PATH };
  try {
    execFileSync("sudo", ["-n", "--preserve-env=PATH", bin, ...args], {
      timeout: 180_000,
      env,
      input: stdin,
    });
    return;
  } catch (error) {
    const message = formatExecError(error);
    if (!sudoNeedsPassword(message)) {
      recordError(message);
      throw new Error(message);
    }
  }

  // Do not write under ~/.config/gpclient: sudo gpclient often leaves that
  // directory 0700 root, which caused EACCES from the Raycast user process.
  const stdinFile = stdin
    ? join(
        tmpdir(),
        `gpclient-raycast-stdin-${randomBytes(8).toString("hex")}.json`,
      )
    : undefined;
  try {
    if (stdinFile && stdin) {
      writeFileSync(stdinFile, stdin, { mode: 0o600 });
    }
    const redirect = stdinFile ? ` < ${JSON.stringify(stdinFile)}` : "";
    const command =
      [bin, ...args].map((part) => JSON.stringify(part)).join(" ") + redirect;
    execFileSync(
      "osascript",
      [
        "-e",
        `do shell script ${JSON.stringify(`export PATH=${JSON.stringify(PRIVILEGED_PATH)}; ${command}`)} with administrator privileges`,
      ],
      { timeout: 180_000, env },
    );
  } catch (error) {
    const message = formatExecError(error);
    recordError(message);
    throw new Error(message);
  } finally {
    if (stdinFile) {
      try {
        unlinkSync(stdinFile);
      } catch {
        // Best-effort cleanup of the temporary cookie pipe file.
      }
    }
  }
}

/** Run gpclient as root. */
function runGpclient(args: string[], stdin?: string): void {
  runSudoBin(gpclientBin(), args, stdin);
}

/** True when a tunnel is up. Prefer `~/.config/gpclient/session.pid` (Raycast can read home; not `/var/run`). */
export function isVpnRunning(): boolean {
  try {
    const pid = Number(readFileSync(sessionPidPath(), "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) {
      return true;
    }
  } catch {
    // Sidecar missing.
  }
  try {
    const pid = Number(readFileSync("/var/run/gpclient.lock", "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) {
      return true;
    }
  } catch {
    // Lock missing or unreadable.
  }
  for (const binary of ["gpclient", "gpservice"]) {
    try {
      execFileSync("pgrep", ["-x", binary], { stdio: "ignore" });
      return true;
    } catch {
      // Process is not running or pgrep is blocked.
    }
  }
  return false;
}

/** User-readable PID written next to cookie.json so the menu bar can see a root tunnel. */
function sessionPidPath(): string {
  return join(homedir(), ".config/gpclient/session.pid");
}

/** `kill(pid, 0)`: ESRCH = gone. EPERM = exists but owned by root. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when the macOS handler for `globalprotectcallback1://` is installed. */
export function urlHandlerInstalled(): boolean {
  return existsSync("/Applications/GlobalProtectURLHandler.app");
}

/**
 * Start the browser SSO sign-in outside the Raycast process. The menu-bar worker
 * is unloaded as soon as the menu closes; a Node `spawn` child is killed with it.
 * @returns `"started"` when gpauth was launched, `"already-connected"` if not.
 */
export function firstLogin(): "started" | "already-connected" {
  if (!urlHandlerInstalled()) {
    const message =
      "Missing /Applications/GlobalProtectURLHandler.app. Run ./install-macos-url-handler.sh so globalprotectcallback1:// is registered.";
    recordError(message);
    throw new Error(message);
  }

  const helper = join(environment.assetsPath, "scripts/first-login.sh");
  if (!existsSync(helper)) {
    const message = `Missing ${helper}. Re-import the extension so assets/scripts is included.`;
    recordError(message);
    throw new Error(message);
  }

  if (isVpnRunning()) {
    notifyMac("VPN is already connected. Disconnect first for a new SSO.");
    return "already-connected";
  }

  if (isProgressRunning()) {
    throw new Error("Already working. Open the menu to see the current step.");
  }

  const values = prefs();
  beginProgress("first-login", "Signing in with SSO", [
    { id: "browser", label: "Finish SSO in the browser", status: "active" },
    { id: "cookie", label: "Receive portal cookie", status: "pending" },
    { id: "connect", label: "Start gpclient", status: "pending" },
    { id: "tunnel", label: "Bring up tunnel", status: "pending" },
  ]);
  startFirstLoginHelper(helper, {
    PATH: PRIVILEGED_PATH,
    HOME: homedir(),
    GP_PORTAL: values.portal,
    GP_GATEWAY: values.gateway,
    GP_COOKIE: cookiePath(values),
    GP_SLICE: tunnelMode() === "full" ? "" : vpnSliceArg(),
    GP_GPAUTH: gpauthBin(),
    GP_GPCLIENT: gpclientBin(),
    GP_LAST_ERROR: lastErrorPath(),
    GP_ERROR_LOG: errorLogPath(),
    GP_USER: userInfo().username,
    GP_PRIVILEGED_PATH: PRIVILEGED_PATH,
    GP_PROGRESS: progressPath(),
    GP_PROGRESS_PY: join(environment.assetsPath, "scripts/progress.py"),
  });
  notifyMac("Finish SSO in the browser");
  return "started";
}

/** Launch the helper with nohup so it is not a child of the Raycast worker. */
function startFirstLoginHelper(
  helper: string,
  env: Record<string, string>,
): void {
  const log = firstLoginLogPath();
  mkdirSync(dirname(log), { recursive: true });
  const exports = Object.entries(env)
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("; ");
  const cmd = `${exports}; /usr/bin/nohup /bin/bash ${JSON.stringify(helper)} >>${JSON.stringify(log)} 2>&1 </dev/null &`;
  execFileSync("/bin/zsh", ["-c", cmd], { timeout: 5000 });
}

/**
 * Reconnect with the stored portal cookie. Pass `gateway` to switch without a new SSO.
 * Returns as soon as gpclient is spawned; `assets/scripts/progress.py watch` finishes
 * the step list so the Live Progress window keeps updating after Raycast unloads us.
 */
export function reconnect(gateway?: string): void {
  if (isProgressRunning()) {
    throw new Error("Already working. Open the menu to see the current step.");
  }
  const values = prefs();
  const path = cookiePath(values);
  if (!existsSync(path)) {
    const message = `No cookie at ${path}. Use Sign in with SSO in the menu.`;
    recordError(message);
    throw new Error(message);
  }
  const target = gateway ?? values.gateway;
  const switching = Boolean(gateway) && gateway !== currentGateway(values);
  const wasRunning = isVpnRunning();
  beginProgress(
    switching ? "switch" : "reconnect",
    switching ? `Switching to ${target}` : "Reconnecting",
    [
      {
        id: "stop",
        label: wasRunning ? "Stop current tunnel" : "No tunnel to stop",
        status: wasRunning ? "active" : "skipped",
      },
      {
        id: "portal",
        label: "Ask portal for gateway list",
        status: "pending",
      },
      {
        id: "gateway",
        label: `Log in to ${target}`,
        status: "pending",
      },
      { id: "tunnel", label: "Bring up tunnel", status: "pending" },
    ],
  );
  if (wasRunning) {
    disconnectVpn({ nested: true });
    setProgressStep("stop", "done");
  } else {
    setProgressStep("portal", "active");
  }
  const args = [
    "connect",
    values.portal,
    "--cookie-cache",
    path,
    "--csc",
    "no",
    "--no-dtls",
    "--gateway",
    target,
  ];
  const slice = tunnelMode() === "full" ? "" : vpnSliceArg();
  if (slice) {
    args.push("-s", slice);
  }
  startReconnectHelper(args);
}

/** Start `gpclient connect` with nohup so Raycast does not wait for the tunnel. */
function startReconnectHelper(args: string[]): void {
  const log = reconnectLogPath();
  mkdirSync(dirname(log), { recursive: true });
  const offset = logSize(log);
  const quoted = ["sudo", "-n", "--preserve-env=PATH", gpclientBin(), ...args]
    .map((part) => JSON.stringify(part))
    .join(" ");
  const cmd = `export PATH=${JSON.stringify(PRIVILEGED_PATH)}; /usr/bin/nohup ${quoted} >>${JSON.stringify(log)} 2>&1 </dev/null &`;
  execFileSync("/bin/zsh", ["-c", cmd], { timeout: 5000 });
  startReconnectWatcher(offset);
}

/** Current log length, used so the watcher ignores lines from previous runs. */
function logSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Watcher keeps progress.json moving after the Raycast worker unloads. */
function startReconnectWatcher(logOffset: number): void {
  const py = join(environment.assetsPath, "scripts/progress.py");
  if (!existsSync(py)) {
    return;
  }
  const quoted = [
    "/usr/bin/python3",
    py,
    "watch",
    progressPath(),
    reconnectLogPath(),
    sessionPidPath(),
    "60",
    String(logOffset),
  ]
    .map((part) => JSON.stringify(part))
    .join(" ");
  const cmd = `/usr/bin/nohup ${quoted} >/dev/null 2>&1 &`;
  execFileSync("/bin/zsh", ["-c", cmd], { timeout: 5000 });
}

/** Tear down the tunnel. Leaves the cookie file in place. */
export function disconnectVpn(opts?: { nested?: boolean }): void {
  if (!opts?.nested) {
    if (isProgressRunning()) {
      throw new Error(
        "Already working. Open the menu to see the current step.",
      );
    }
    beginProgress("disconnect", "Disconnecting", [
      { id: "stop", label: "Stop tunnel", status: "active" },
      { id: "confirm", label: "Confirm process is gone", status: "pending" },
    ]);
  }
  // Do not call `gpclient disconnect`: a second gpclient is SIGKILL'd (137).
  runSudoBin(gpDisconnectBin(), []);
  if (isVpnRunning()) {
    const message =
      "VPN process is still running after gp-disconnect. Use Copy last error.";
    recordError(message);
    failProgress(message);
    throw new Error(message);
  }
  if (!opts?.nested) {
    setProgressStep("confirm", "done");
    succeedProgress();
  }
}
