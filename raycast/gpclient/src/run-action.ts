import { notifyFailure } from "./gp";
import {
  isTinycastHost,
  openLiveProgress,
  type LiveProgressContext,
} from "./progress";

/**
 * Start reconnect / switch / disconnect.
 * Tinycast drops launchCommand context and unloads this view when another
 * command opens, so the work runs here and the list stays put.
 * Raycast still hands the action to Live Progress.
 */
export async function runVpnAction(
  context: LiveProgressContext,
  fallback: () => void,
): Promise<void> {
  if (isTinycastHost()) {
    try {
      fallback();
    } catch (error) {
      await notifyFailure(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  try {
    await openLiveProgress(context);
    return;
  } catch {
    // Command not indexed yet; do the work in this view instead.
  }
  try {
    fallback();
  } catch (error) {
    await notifyFailure(error instanceof Error ? error.message : String(error));
  }
}
