import {
  Action,
  ActionPanel,
  Color,
  Icon,
  LaunchProps,
  List,
} from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import {
  currentGateway,
  disconnectVpn,
  gatewayList,
  isVpnRunning,
  prefs,
  reconnect,
} from "./gp";
import {
  failProgress,
  isProgressRunning,
  logProgressEvent,
  progressHeadline,
  readProgress,
  stepIcon,
  type LiveProgressContext,
  type OperationProgress,
} from "./progress";

const POLL_MS = 400;

/**
 * Live step list for the current VPN operation. Unlike a MenuBarExtra dropdown,
 * a view command keeps rendering while it is open, so steps advance in place.
 * When launched with a context it also starts that operation.
 */
export default function Command(
  props: LaunchProps<{ launchContext?: LiveProgressContext }>,
) {
  const values = prefs();
  const [progress, setProgress] = useState<OperationProgress | null>(
    readProgress,
  );
  const [actionError, setActionError] = useState<string>("");
  const started = useRef(false);

  // Kick off the requested action after the first paint so the window is
  // already visible while `sudo gp-disconnect` blocks for a second or two.
  useEffect(() => {
    const action = props.launchContext?.action;
    if (started.current) {
      return;
    }
    started.current = true;
    logProgressEvent(
      `live-progress opened context=${JSON.stringify(props.launchContext ?? null)}`,
    );
    if (
      action !== "disconnect" &&
      action !== "reconnect" &&
      action !== "switch"
    ) {
      return;
    }
    // No cleanup: React runs effects twice in development, and cancelling this
    // timer there would drop the only scheduled start (the ref blocks the retry).
    setTimeout(() => {
      try {
        if (action === "disconnect") {
          disconnectVpn();
        } else {
          reconnect(props.launchContext?.gateway);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logProgressEvent(`action ${action} failed: ${message}`);
        setActionError(message);
        failProgress(message);
      }
      setProgress(readProgress());
    }, 50);
  }, [props.launchContext?.action, props.launchContext?.gateway]);

  useEffect(() => {
    const id = setInterval(() => setProgress(readProgress()), POLL_MS);
    return () => clearInterval(id);
  }, []);

  const running = isProgressRunning(progress);
  const connected = isVpnRunning();
  const activeGateway = currentGateway(values);

  return (
    <List
      isLoading={running}
      navigationTitle={progress?.title ?? "VPN Progress"}
      searchBarPlaceholder={
        running
          ? "Working…"
          : connected
            ? `Connected · ${activeGateway}`
            : "Disconnected"
      }
    >
      {progress ? (
        <List.Section title={progressHeadline(progress)}>
          {progress.steps.map((step) => (
            <List.Item
              key={step.id}
              title={step.label}
              subtitle={step.status}
              icon={stepIcon(step.status)}
              actions={
                <Controls running={running} gateways={gatewayList(values)} />
              }
            />
          ))}
          {actionError || progress.error ? (
            <List.Item
              title="Error"
              subtitle={actionError || progress.error}
              icon={{ source: Icon.Warning, tintColor: Color.Red }}
              actions={
                <ActionPanel>
                  <Action.CopyToClipboard
                    title="Copy Error"
                    content={actionError || progress.error || ""}
                  />
                </ActionPanel>
              }
            />
          ) : null}
        </List.Section>
      ) : (
        <List.EmptyView
          title="Nothing running"
          description="Start Reconnect, Disconnect, or Switch Gateway to see steps here."
          icon={connected ? Icon.Lock : Icon.LockUnlocked}
          actions={<Controls running={false} gateways={gatewayList(values)} />}
        />
      )}
    </List>
  );
}

/** Same actions as the menu bar, so the window is usable on its own. */
function Controls({
  running,
  gateways,
}: {
  running: boolean;
  gateways: string[];
}) {
  return (
    <ActionPanel>
      <Action
        title="Reconnect"
        icon={Icon.Repeat}
        onAction={() => !running && reconnect()}
      />
      <Action
        title="Disconnect"
        icon={Icon.Stop}
        onAction={() => !running && disconnectVpn()}
      />
      <ActionPanel.Submenu title="Switch Gateway" icon={Icon.Globe}>
        {gateways.map((gateway) => (
          <Action
            key={gateway}
            title={gateway}
            onAction={() => !running && reconnect(gateway)}
          />
        ))}
      </ActionPanel.Submenu>
    </ActionPanel>
  );
}
