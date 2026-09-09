import { useEffect, useState } from "react";
import { Action, ActionPanel, Color, Icon, List } from "@raycast/api";
import {
  currentGateway,
  gatewayList,
  isVpnRunning,
  prefs,
  reconnect,
} from "./gp";
import {
  isProgressRunning,
  progressHeadline,
  readProgress,
  shouldShowProgress,
  type OperationProgress,
} from "./progress";
import { runVpnAction } from "./run-action";

const POLL_MS = 1000;

interface GatewaySnapshot {
  connected: boolean;
  active: string;
  gateways: string[];
  running: boolean;
  progress: OperationProgress | null;
}

/** Read the gateway list and which host the tunnel is on. */
function readSnapshot(): GatewaySnapshot {
  const values = prefs();
  const progress = readProgress();
  return {
    connected: isVpnRunning(),
    active: currentGateway(values),
    gateways: gatewayList(values),
    running: isProgressRunning(progress),
    progress,
  };
}

/** Connect to `gateway` in this list on Tinycast; Raycast opens Live Progress. */
function connectGateway(gateway: string, running: boolean): void {
  if (running) {
    return;
  }
  void runVpnAction({ action: "switch", gateway }, () => reconnect(gateway));
}

/** Pick a portal gateway and connect. Tinycast has no menu-bar Switch Gateway submenu. */
export default function Command() {
  const [snapshot, setSnapshot] = useState<GatewaySnapshot>(readSnapshot);

  useEffect(() => {
    const id = setInterval(() => setSnapshot(readSnapshot()), POLL_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <List
      isLoading={snapshot.running}
      navigationTitle="Switch Gateway"
      searchBarPlaceholder={
        snapshot.running && snapshot.progress
          ? `${snapshot.progress.title} · ${progressHeadline(snapshot.progress)}`
          : snapshot.connected
            ? `Connected · ${snapshot.active}`
            : "Disconnected · pick a gateway"
      }
    >
      {shouldShowProgress(snapshot.progress) && snapshot.progress ? (
        <List.Section title="Progress">
          <List.Item
            title={snapshot.progress.title}
            subtitle={progressHeadline(snapshot.progress)}
            icon={Icon.CircleProgress}
          />
        </List.Section>
      ) : null}
      <List.Section title={snapshot.connected ? "Connected" : "Disconnected"}>
        {snapshot.gateways.map((gateway) => {
          const current = gateway === snapshot.active;
          return (
            <List.Item
              key={gateway}
              title={gateway}
              subtitle={
                current
                  ? snapshot.connected
                    ? "Current"
                    : "Last used"
                  : undefined
              }
              icon={{
                source: current ? Icon.CheckCircle : Icon.Globe,
                tintColor: current && snapshot.connected ? Color.Green : undefined,
              }}
              actions={
                <ActionPanel>
                  <Action
                    title={
                      current && snapshot.connected
                        ? "Reconnect This Gateway"
                        : `Connect ${gateway}`
                    }
                    icon={Icon.Globe}
                    onAction={() => connectGateway(gateway, snapshot.running)}
                  />
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>
    </List>
  );
}
