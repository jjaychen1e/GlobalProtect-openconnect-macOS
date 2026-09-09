import { useEffect, useState } from "react";
import {
  Action,
  ActionPanel,
  Color,
  Icon,
  LaunchType,
  List,
  launchCommand,
  openExtensionPreferences,
} from "@raycast/api";
import {
  cookieExists,
  cookieReadable,
  currentGateway,
  disconnectVpn,
  firstLogin,
  firstLoginCommand,
  formatLogTail,
  formatRemaining,
  formatWhen,
  gatewayList,
  isVpnRunning,
  logAge,
  logFiles,
  notifyFailure,
  openInConsole,
  prefs,
  readLastError,
  readLogGroups,
  reconnect,
  sessionExpiry,
  setTunnelMode,
  tunnelMode,
  urlHandlerInstalled,
  type LastError,
  type LogFile,
  type SessionExpiry,
  type TunnelMode,
} from "./gp";
import {
  isProgressRunning,
  menuBarIcon,
  openLiveProgress,
  progressHeadline,
  readProgress,
  shouldShowProgress,
  type OperationProgress,
} from "./progress";
import { runVpnAction } from "./run-action";

const POLL_MS = 1000;

/** Picking a mode rewrites the stored choice and reconnects; the cookie is reused. */
const TUNNEL_MODES: { id: TunnelMode; title: string; subtitle: string }[] = [
  { id: "split", title: "Split", subtitle: "vpn-slice hosts only" },
  { id: "full", title: "Full", subtitle: "all traffic" },
];

interface StatusSnapshot {
  connected: boolean;
  hasCookie: boolean;
  cookieOk: boolean;
  lastError: LastError | undefined;
  loginCommand: string;
  activeGateway: string;
  session: SessionExpiry | undefined;
  tunnel: TunnelMode;
  progress: OperationProgress | null;
  gateways: string[];
  logs: LogFile[];
  handlerInstalled: boolean;
}

/** Amber inside the last day, red inside the last hour. */
function sessionTint(userExpires: number): Color {
  const secsLeft = userExpires - Math.floor(Date.now() / 1000);
  if (secsLeft <= 3600) {
    return Color.Red;
  }
  if (secsLeft <= 86400) {
    return Color.Orange;
  }
  return Color.SecondaryText;
}

/** Read connection, session, tunnel mode, and progress from disk. */
function readSnapshot(): StatusSnapshot {
  const values = prefs();
  return {
    connected: isVpnRunning(),
    hasCookie: cookieExists(values),
    cookieOk: cookieReadable(values),
    lastError: readLastError(),
    loginCommand: firstLoginCommand(values),
    activeGateway: currentGateway(values),
    session: sessionExpiry(values),
    tunnel: tunnelMode(),
    progress: readProgress(),
    gateways: gatewayList(values),
    logs: logFiles(),
    handlerInstalled: urlHandlerInstalled(),
  };
}

/** Cookie row subtitle: missing, unreadable, or present. */
function cookieDetail(hasCookie: boolean, readable: boolean): string {
  if (!hasCookie) {
    return "No cookie.json";
  }
  if (!readable) {
    return "cookie.json not readable";
  }
  return "cookie.json readable";
}

/** Session row title: remaining time, expired, or missing file. */
function sessionTitle(session: SessionExpiry | undefined): string {
  if (!session) {
    return "No session info";
  }
  if (session.userExpires * 1000 <= Date.now()) {
    return "Session expired";
  }
  return `Session ${formatRemaining(session.userExpires)}`;
}

/** Session row subtitle: expiry clock and whether SSO must run again. */
function sessionDetail(session: SessionExpiry | undefined): string | undefined {
  if (!session) {
    return undefined;
  }
  const expires = new Date(session.userExpires * 1000).toLocaleString();
  return session.allowExtendSession
    ? `Expires ${expires}`
    : `Expires ${expires} · sign in with SSO again`;
}

/** Launch Sign In with SSO; fall back to starting the helper from this view. */
async function signInWithSso(): Promise<void> {
  try {
    await launchCommand({
      name: "first-login",
      type: LaunchType.UserInitiated,
    });
  } catch {
    try {
      firstLogin();
    } catch (inner) {
      await notifyFailure(
        inner instanceof Error ? inner.message : String(inner),
      );
    }
  }
}

/** Dashboard that replaces the menu-bar extra in hosts that cannot run menu-bar. */
export default function Command() {
  const [snapshot, setSnapshot] = useState<StatusSnapshot>(readSnapshot);

  useEffect(() => {
    const id = setInterval(() => setSnapshot(readSnapshot()), POLL_MS);
    return () => clearInterval(id);
  }, []);

  const running = isProgressRunning(snapshot.progress);
  const icon = menuBarIcon(snapshot.connected, snapshot.progress);
  const tunnel = TUNNEL_MODES.find((mode) => mode.id === snapshot.tunnel);
  const actions = <StatusActions snapshot={snapshot} running={running} />;

  return (
    <List
      isLoading={running}
      navigationTitle="VPN Status"
      searchBarPlaceholder={
        running && snapshot.progress
          ? `${snapshot.progress.title} · ${progressHeadline(snapshot.progress)}`
          : snapshot.connected
            ? `Connected · ${snapshot.activeGateway}`
            : "Disconnected"
      }
    >
      <List.Section title="Connection">
        <List.Item
          title={
            snapshot.connected
              ? `Connected · ${snapshot.activeGateway}`
              : "Disconnected"
          }
          icon={{ source: icon.source, tintColor: icon.tintColor }}
          actions={actions}
        />
        <List.Item
          title="Cookie"
          subtitle={cookieDetail(snapshot.hasCookie, snapshot.cookieOk)}
          icon={{
            source: snapshot.hasCookie && snapshot.cookieOk ? Icon.Key : Icon.Warning,
            tintColor:
              snapshot.hasCookie && snapshot.cookieOk
                ? Color.SecondaryText
                : Color.Orange,
          }}
          actions={actions}
        />
        <List.Item
          title={sessionTitle(snapshot.session)}
          subtitle={sessionDetail(snapshot.session)}
          icon={{
            source: Icon.Clock,
            tintColor: snapshot.session
              ? sessionTint(snapshot.session.userExpires)
              : Color.SecondaryText,
          }}
          actions={actions}
        />
        <List.Item
          title={`Tunnel · ${tunnel?.title ?? snapshot.tunnel}`}
          subtitle={tunnel?.subtitle}
          icon={Icon.Filter}
          actions={actions}
        />
      </List.Section>
      {shouldShowProgress(snapshot.progress) && snapshot.progress ? (
        <List.Section title="Progress">
          <List.Item
            title={snapshot.progress.title}
            subtitle={progressHeadline(snapshot.progress)}
            icon={{ source: icon.source, tintColor: icon.tintColor }}
            actions={actions}
          />
        </List.Section>
      ) : null}
      <List.Section title="Gateways">
        {snapshot.gateways.map((gateway) => {
          const current = gateway === snapshot.activeGateway;
          return (
            <List.Item
              key={gateway}
              title={gateway}
              subtitle={
                current
                  ? snapshot.connected
                    ? "Current"
                    : "Last used"
                  : "Switch"
              }
              icon={{
                source: current ? Icon.CheckCircle : Icon.Globe,
                tintColor: current && snapshot.connected ? Color.Green : undefined,
              }}
              actions={
                <StatusActions
                  snapshot={snapshot}
                  running={running}
                  switchTo={gateway}
                />
              }
            />
          );
        })}
      </List.Section>
      {snapshot.lastError ? (
        <List.Section title={`Last error · ${formatWhen(snapshot.lastError.at)}`}>
          <List.Item
            title={snapshot.lastError.message}
            subtitle={formatWhen(snapshot.lastError.at)}
            icon={{ source: Icon.Warning, tintColor: Color.Red }}
            actions={actions}
          />
        </List.Section>
      ) : null}
    </List>
  );
}

/** Same actions as the menu bar, hosted on every row. */
function StatusActions({
  snapshot,
  running,
  switchTo,
}: {
  snapshot: StatusSnapshot;
  running: boolean;
  switchTo?: string;
}) {
  const target = switchTo ?? snapshot.activeGateway;
  const switching = Boolean(switchTo) && switchTo !== snapshot.activeGateway;
  return (
    <ActionPanel>
      <Action
        title={
          switching
            ? `Connect ${target}`
            : snapshot.connected
              ? "Reconnect"
              : "Connect"
        }
        icon={switching ? Icon.Globe : Icon.Repeat}
        shortcut={{ modifiers: ["cmd"], key: "r" }}
        onAction={() =>
          !running &&
          runVpnAction(
            switching
              ? { action: "switch", gateway: target }
              : { action: "reconnect" },
            () => (switching ? reconnect(target) : reconnect()),
          )
        }
      />
      <Action
        title="Disconnect"
        icon={Icon.Stop}
        onAction={() =>
          !running &&
          runVpnAction({ action: "disconnect" }, () => disconnectVpn())
        }
      />
      <Action
        title="Open Switch Gateway"
        icon={Icon.Globe}
        onAction={async () => {
          try {
            await launchCommand({
              name: "switch-gateway",
              type: LaunchType.UserInitiated,
            });
          } catch (error) {
            await notifyFailure(
              error instanceof Error ? error.message : String(error),
            );
          }
        }}
      />
      <ActionPanel.Submenu title="Switch Gateway" icon={Icon.Globe}>
        {snapshot.gateways.map((gateway) => (
          <Action
            key={gateway}
            title={gateway}
            icon={
              snapshot.connected && gateway === snapshot.activeGateway
                ? Icon.CheckCircle
                : undefined
            }
            onAction={() =>
              !running &&
              runVpnAction({ action: "switch", gateway }, () =>
                reconnect(gateway),
              )
            }
          />
        ))}
      </ActionPanel.Submenu>
      <ActionPanel.Submenu title="Tunnel Mode" icon={Icon.Filter}>
        {TUNNEL_MODES.map((mode) => (
          <Action
            key={mode.id}
            title={`${mode.title} · ${mode.subtitle}`}
            icon={mode.id === snapshot.tunnel ? Icon.CheckCircle : undefined}
            onAction={() => {
              if (running || mode.id === snapshot.tunnel) {
                return;
              }
              setTunnelMode(mode.id);
              void runVpnAction({ action: "reconnect" }, () => reconnect());
            }}
          />
        ))}
      </ActionPanel.Submenu>
      <Action
        title="Sign In with SSO"
        icon={Icon.Key}
        shortcut={{ modifiers: ["cmd"], key: "s" }}
        onAction={signInWithSso}
      />
      {!snapshot.handlerInstalled ? (
        <Action
          title="SSO Needs URL Handler"
          icon={Icon.Warning}
          onAction={signInWithSso}
        />
      ) : null}
      <Action
        title="Configure Split Tunnel"
        icon={Icon.Cog}
        onAction={() =>
          launchCommand({
            name: "split-tunnel",
            type: LaunchType.UserInitiated,
          })
        }
      />
      <Action
        title="Open Live Progress"
        icon={Icon.Eye}
        onAction={async () => {
          try {
            await openLiveProgress();
          } catch (error) {
            await notifyFailure(
              error instanceof Error ? error.message : String(error),
            );
          }
        }}
      />
      <ActionPanel.Section>
        <ActionPanel.Submenu title="Logs" icon={Icon.Terminal}>
          {snapshot.logs.map((file) => (
            <Action
              key={file.key}
              title={`${file.title} log · ${logAge(file.path)}`}
              icon={Icon.Document}
              onAction={async () => {
                try {
                  openInConsole(file.path);
                } catch (error) {
                  await notifyFailure(
                    error instanceof Error ? error.message : String(error),
                  );
                }
              }}
            />
          ))}
          <Action.CopyToClipboard
            title="Copy Last 50 Lines"
            icon={Icon.Clipboard}
            content={formatLogTail(readLogGroups(), 50)}
          />
        </ActionPanel.Submenu>
        <Action.CopyToClipboard
          title="Copy SSO Sign-In Command"
          icon={Icon.Clipboard}
          content={snapshot.loginCommand}
        />
        {snapshot.lastError ? (
          <Action.CopyToClipboard
            title="Copy Last Error"
            icon={Icon.Warning}
            content={`${formatWhen(snapshot.lastError.at)}\n${snapshot.lastError.message}`}
          />
        ) : null}
        <Action
          title="Open Preferences"
          icon={Icon.Gear}
          onAction={openExtensionPreferences}
        />
      </ActionPanel.Section>
    </ActionPanel>
  );
}
