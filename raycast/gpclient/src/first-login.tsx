import { showHUD } from "@raycast/api";
import { firstLogin, notifyFailure } from "./gp";

export default async function Command() {
  try {
    const result = firstLogin();
    if (result === "started") {
      await showHUD("Finish SSO in the browser");
    }
  } catch (error) {
    await notifyFailure(
      error instanceof Error ? error.message : "SSO sign-in failed",
    );
  }
}
