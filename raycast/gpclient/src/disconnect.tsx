import { showHUD } from "@raycast/api";
import { disconnectVpn, notifyFailure } from "./gp";

export default async function Command() {
  try {
    disconnectVpn();
    await showHUD("Disconnecting VPN");
  } catch (error) {
    await notifyFailure(
      error instanceof Error ? error.message : "Disconnect failed",
    );
  }
}
