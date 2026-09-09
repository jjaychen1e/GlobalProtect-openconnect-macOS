import { useEffect, useState } from "react";
import {
  Clipboard,
  Color,
  Icon,
  LaunchType,
  MenuBarExtra,
  launchCommand,
  openExtensionPreferences,
  showHUD,
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
  gatewayList,
  isVpnRunning,
  logAge,
  logFiles,
  notifyFailure,
  openInConsole,
  prefs,
  formatWhen,
  readLastError,
  readLogGroups,
  reconnect,
  sessionExpiry,
  setTunnelMode,
  tunnelMode,
  urlHandlerInstalled,
  notifyMac,
  type TunnelMode,
} from "./gp";
import {
  isProgressRunning,
  menuBarIcon,
  progressBarTitle,
  progressHeadline,
  openLiveProgress,
  readProgress,
  type LiveProgressContext,
  type OperationProgress,
} from "./progress";

/**
 * Hand the action to the Live Progress window so the user sees steps advance.
 * Falls back to running it here (with a notification) if that window cannot open.
 */
async function run(
  label: string,
  context: LiveProgressContext,
  fallback: () => void,
): Promise<void> {
  try {
    await openLiveProgress(context);
    return;
  } catch {
    // Command not indexed yet; do the work in this worker instead.
  }
  try {
    fallback();
    notifyMac(label);
    try {
      await showHUD(label);
    } catch {
      // Interval menu-bar sessions reject HUD.
    }
    try {
      await launchCommand({ name: "menu-bar", type: LaunchType.Background });
    } catch {
      // Refresh is best-effort; interval will catch up.
    }
  } catch (error) {
    await notifyFailure(error instanceof Error ? error.message : String(error));
  }
}

/** Picking a mode rewrites the stored choice and reconnects; the cookie is reused. */
const TUNNEL_MODES: { id: TunnelMode; title: string; subtitle: string }[] = [
  { id: "split", title: "Split", subtitle: "vpn-slice hosts only" },
  { id: "full", title: "Full", subtitle: "all traffic" },
];

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

export default function Command() {
  const values = prefs();
  const connected = isVpnRunning();
  const hasCookie = cookieExists(values);
  const lastError = readLastError();
  const loginCommand = firstLoginCommand(values);
  const activeGateway = currentGateway(values);
  const session = sessionExpiry(values);
  const tunnel = tunnelMode();
  const [progress, setProgress] = useState<OperationProgress | null>(
    readProgress,
  );
  const running = isProgressRunning(progress);

  useEffect(() => {
    if (!running) {
      return;
    }
    const id = setInterval(() => {
      setProgress(readProgress());
    }, 1000);
    return () => clearInterval(id);
  }, [running, progress?.startedAt]);

  const icon = menuBarIcon(connected, progress);
  const tooltip =
    running && progress
      ? `${progress.title} · ${progressHeadline(progress)}`
      : connected
        ? `VPN connected (${activeGateway})`
        : "VPN disconnected";

  return (
    <MenuBarExtra
      isLoading={running}
      icon={icon}
      title={running && progress ? progressBarTitle(progress) : undefined}
      tooltip={tooltip}
    >
      <MenuBarExtra.Item
        title={
          running && progress
            ? progress.title
            : connected
              ? `Connected · ${activeGateway}`
              : "Disconnected"
        }
        subtitle={
          running && progress
            ? progressHeadline(progress)
            : !hasCookie
              ? "No cookie.json"
              : cookieReadable(values)
                ? undefined
                : "cookie.json not readable"
        }
        icon={{ source: icon.source, tintColor: icon.tintColor }}
      />
      {session ? (
        <MenuBarExtra.Item
          title={
            session.userExpires * 1000 <= Date.now()
              ? "Session expired"
              : `Session ${formatRemaining(session.userExpires)}`
          }
          icon={{
            source: Icon.Clock,
            tintColor: sessionTint(session.userExpires),
          }}
          tooltip={`Expires ${new Date(session.userExpires * 1000).toLocaleString()}${
            session.allowExtendSession ? "" : " · sign in with SSO again"
          }`}
        />
      ) : null}
      <MenuBarExtra.Submenu title="Tunnel Mode" icon={Icon.Filter}>
        {TUNNEL_MODES.map((mode) => (
          <MenuBarExtra.Item
            key={mode.id}
            title={mode.title}
            subtitle={mode.subtitle}
            icon={mode.id === tunnel ? Icon.CheckCircle : undefined}
            onAction={() => {
              if (mode.id === tunnel) {
                return;
              }
              setTunnelMode(mode.id);
              return run(mode.title, { action: "reconnect" }, () =>
                reconnect(),
              );
            }}
          />
        ))}
        <MenuBarExtra.Item
          title="Configure split tunnel…"
          icon={Icon.Cog}
          onAction={() =>
            launchCommand({
              name: "split-tunnel",
              type: LaunchType.UserInitiated,
            })
          }
        />
      </MenuBarExtra.Submenu>
      <MenuBarExtra.Item
        title="Live progress"
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
      <MenuBarExtra.Item
        title="Sign in with SSO"
        icon={Icon.Key}
        subtitle={urlHandlerInstalled() ? undefined : "Needs URL handler"}
        onAction={async () => {
          try {
            await launchCommand({
              name: "first-login",
              type: LaunchType.UserInitiated,
            });
          } catch (error) {
            try {
              firstLogin();
            } catch (inner) {
              await notifyFailure(
                inner instanceof Error ? inner.message : String(error),
              );
            }
          }
        }}
      />
      <MenuBarExtra.Item
        title="Reconnect"
        icon={Icon.Repeat}
        onAction={() =>
          run("Reconnecting VPN", { action: "reconnect" }, () => reconnect())
        }
      />
      <MenuBarExtra.Item
        title="Disconnect"
        icon={Icon.Stop}
        onAction={() =>
          run("Disconnecting VPN", { action: "disconnect" }, () =>
            disconnectVpn(),
          )
        }
      />
      <MenuBarExtra.Submenu title="Switch Gateway" icon={Icon.Globe}>
        {gatewayList(values).map((gateway) => (
          <MenuBarExtra.Item
            key={gateway}
            title={gateway}
            icon={
              connected && gateway === activeGateway
                ? Icon.CheckCircle
                : undefined
            }
            onAction={() =>
              run(`Connecting ${gateway}`, { action: "switch", gateway }, () =>
                reconnect(gateway),
              )
            }
          />
        ))}
      </MenuBarExtra.Submenu>
      <MenuBarExtra.Section>
        <MenuBarExtra.Submenu title="Logs" icon={Icon.Terminal}>
          {logFiles().map((file) => (
            <MenuBarExtra.Item
              key={file.key}
              title={`${file.title} log`}
              subtitle={logAge(file.path)}
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
          <MenuBarExtra.Section>
            <MenuBarExtra.Item
              title="Copy last 50 lines"
              icon={Icon.Clipboard}
              onAction={() => {
                Clipboard.copy(formatLogTail(readLogGroups(), 50));
                showHUD("Copied last 50 lines of each log");
              }}
            />
          </MenuBarExtra.Section>
        </MenuBarExtra.Submenu>
        <MenuBarExtra.Item
          title="Copy SSO sign-in command"
          icon={Icon.Clipboard}
          onAction={() => {
            Clipboard.copy(loginCommand);
            showHUD("Copied SSO sign-in command");
          }}
        />
        {lastError ? (
          <MenuBarExtra.Item
            title="Copy last error"
            subtitle={formatWhen(lastError.at)}
            icon={Icon.Warning}
            onAction={() => {
              Clipboard.copy(
                `${formatWhen(lastError.at)}\n${lastError.message}`,
              );
              showHUD("Copied last error");
            }}
          />
        ) : null}
        <MenuBarExtra.Item
          title="Preferences"
          icon={Icon.Gear}
          onAction={openExtensionPreferences}
        />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
