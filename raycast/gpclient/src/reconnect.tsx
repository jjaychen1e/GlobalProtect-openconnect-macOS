import { showHUD } from "@raycast/api";
import { notifyFailure, reconnect } from "./gp";

export default async function Command() {
  try {
    reconnect();
    await showHUD("Reconnecting VPN");
  } catch (error) {
    await notifyFailure(
      error instanceof Error ? error.message : "Reconnect failed",
    );
  }
}
