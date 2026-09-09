import { Color, Icon, LaunchType, environment, launchCommand } from "@raycast/api";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export type StepStatus = "pending" | "active" | "done" | "failed" | "skipped";

export interface ProgressStep {
  id: string;
  label: string;
  status: StepStatus;
}

export type ProgressStatus = "running" | "succeeded" | "failed";

export interface OperationProgress {
  operation: "reconnect" | "disconnect" | "switch" | "first-login";
  title: string;
  status: ProgressStatus;
  steps: ProgressStep[];
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

const SUCCEEDED_VISIBLE_MS = 90_000;
const FAILED_VISIBLE_MS = 5 * 60_000;
const STALE_RUNNING_MS = 180_000;

/** JSON file the menu bar reads so progress survives the worker unloading. */
export function progressPath(): string {
  return join(homedir(), "Library/Logs/gpclient-raycast-progress.json");
}

/** Human-readable trail of which command asked for which action. */
export function progressLogPath(): string {
  return join(homedir(), "Library/Logs/gpclient-raycast-progress.log");
}

/** Append one timestamped line to the progress log. Never throws. */
export function logProgressEvent(line: string): void {
  try {
    const path = progressLogPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Logging must not break an operation.
  }
}

/** What the Live Progress window should start doing as soon as it opens. */
export interface LiveProgressContext {
  action: "reconnect" | "switch" | "disconnect";
  gateway?: string;
}

interface PendingAction extends LiveProgressContext {
  writtenAt: number;
}

const PENDING_MAX_AGE_MS = 60_000;

/** Sidecar so Live Progress still sees the action when the host drops launchContext. */
export function pendingActionPath(): string {
  return join(homedir(), "Library/Logs/gpclient-raycast-pending.json");
}

/** Tinycast cannot run menu-bar commands and drops launchCommand context. */
export function isTinycastHost(): boolean {
  return /tinycast/i.test(environment.supportPath);
}

/** Write the next action to disk before launching another command. */
export function writePendingAction(context: LiveProgressContext): void {
  const path = pendingActionPath();
  mkdirSync(dirname(path), { recursive: true });
  const pending: PendingAction = { ...context, writtenAt: Date.now() };
  writeFileSync(path, JSON.stringify(pending));
  logProgressEvent(`pending action ${JSON.stringify(context)}`);
}

/** Read and delete a pending action written in the last minute. */
export function takePendingAction(): LiveProgressContext | undefined {
  const path = pendingActionPath();
  try {
    const pending = JSON.parse(readFileSync(path, "utf8")) as PendingAction;
    unlinkSync(path);
    if (
      !pending?.action ||
      Date.now() - pending.writtenAt > PENDING_MAX_AGE_MS
    ) {
      return undefined;
    }
    return { action: pending.action, gateway: pending.gateway };
  } catch {
    return undefined;
  }
}

/**
 * Open the live-updating step window, optionally telling it to run an action.
 * Raycast only knows commands it has indexed, so a fresh command needs a
 * Raycast restart (or re-import) before this resolves.
 * Tinycast drops `launchCommand` context, so the action is also written to disk.
 */
export async function openLiveProgress(
  context?: LiveProgressContext,
): Promise<void> {
  if (context) {
    writePendingAction(context);
  }
  logProgressEvent(
    `launch live-progress context=${JSON.stringify(context ?? null)}`,
  );
  await launchCommand({
    name: "live-progress",
    type: LaunchType.UserInitiated,
    context: context ?? null,
  }).catch((error) => {
    logProgressEvent(`launchCommand failed: ${String(error)}`);
    throw new Error(
      "Raycast has not indexed VPN Live Progress yet. Quit and reopen Raycast, then try again.",
    );
  });
}

/** Tinycast cannot run menu-bar commands; launching one surfaces a host error. */
function hostSupportsMenuBar(): boolean {
  return !isTinycastHost();
}

/** Re-render the menu bar extra so the icon switches to loading without waiting for the interval. */
export function requestMenuRefresh(): void {
  if (!hostSupportsMenuBar()) {
    return;
  }
  void launchCommand({ name: "menu-bar", type: LaunchType.Background }).catch(
    () => {
      // Interval will pick up the progress file.
    },
  );
}

/** Read the on-disk progress, or null when missing/corrupt. Expires a stuck "running" state. */
export function readProgress(): OperationProgress | null {
  try {
    const parsed = JSON.parse(
      readFileSync(progressPath(), "utf8"),
    ) as OperationProgress;
    if (!parsed?.steps || !parsed.status) {
      return null;
    }
    if (
      parsed.status === "running" &&
      Date.now() - parsed.startedAt > STALE_RUNNING_MS
    ) {
      parsed.status = "failed";
      parsed.error = "Timed out";
      parsed.finishedAt = Date.now();
      for (const step of parsed.steps) {
        if (step.status === "active") {
          step.status = "failed";
        }
      }
      writeProgress(parsed);
    }
    return parsed;
  } catch {
    return null;
  }
}

/** True when an operation is mid-flight. */
export function isProgressRunning(progress = readProgress()): boolean {
  return progress?.status === "running";
}

/** True when the menu should list steps (in flight, or just finished so the user can look). */
export function shouldShowProgress(progress = readProgress()): boolean {
  if (!progress) {
    return false;
  }
  if (progress.status === "running") {
    return true;
  }
  const finished = progress.finishedAt ?? 0;
  const age = Date.now() - finished;
  if (progress.status === "succeeded") {
    return age < SUCCEEDED_VISIBLE_MS;
  }
  return age < FAILED_VISIBLE_MS;
}

/** Start a new operation and refresh the menu bar icon. */
export function beginProgress(
  operation: OperationProgress["operation"],
  title: string,
  steps: ProgressStep[],
): void {
  writeProgress({
    operation,
    title,
    status: "running",
    steps,
    startedAt: Date.now(),
  });
  requestMenuRefresh();
}

/** Advance one step. `done` activates the next pending step. */
export function setProgressStep(id: string, status: StepStatus): void {
  const progress = readProgress();
  if (!progress || progress.status !== "running") {
    return;
  }
  applyStep(progress, id, status);
  writeProgress(progress);
}

/** Mark the whole operation failed and refresh the icon. */
export function failProgress(message: string): void {
  const progress = readProgress();
  if (!progress) {
    return;
  }
  progress.status = "failed";
  progress.error = message;
  progress.finishedAt = Date.now();
  const active = progress.steps.find((step) => step.status === "active");
  if (active) {
    active.status = "failed";
  }
  writeProgress(progress);
  requestMenuRefresh();
}

/** Mark remaining steps done and refresh the icon. */
export function succeedProgress(): void {
  const progress = readProgress();
  if (!progress) {
    return;
  }
  progress.status = "succeeded";
  progress.finishedAt = Date.now();
  for (const step of progress.steps) {
    if (step.status === "pending" || step.status === "active") {
      step.status = "done";
    }
  }
  writeProgress(progress);
  requestMenuRefresh();
}

/** Menu bar icon: orange progress ring while running, red X on failure, lock otherwise. */
export function menuBarIcon(
  connected: boolean,
  progress: OperationProgress | null,
): { source: Icon; tintColor: Color } {
  if (progress?.status === "running") {
    const done = progress.steps.filter(
      (step) => step.status === "done" || step.status === "skipped",
    ).length;
    const ratio = done / Math.max(progress.steps.length, 1);
    const source =
      ratio < 0.25
        ? Icon.CircleProgress
        : ratio < 0.5
          ? Icon.CircleProgress25
          : ratio < 0.75
            ? Icon.CircleProgress50
            : ratio < 1
              ? Icon.CircleProgress75
              : Icon.CircleProgress100;
    return { source, tintColor: Color.Orange };
  }
  if (progress?.status === "failed" && shouldShowProgress(progress)) {
    return { source: Icon.XMarkCircle, tintColor: Color.Red };
  }
  return {
    source: connected ? Icon.Lock : Icon.LockUnlocked,
    tintColor: connected ? Color.Green : Color.SecondaryText,
  };
}

/** Icon for one row in the Progress section. */
export function stepIcon(status: StepStatus): {
  source: Icon;
  tintColor: Color;
} {
  switch (status) {
    case "done":
    case "skipped":
      return { source: Icon.CheckCircle, tintColor: Color.Green };
    case "active":
      return { source: Icon.CircleProgress, tintColor: Color.Orange };
    case "failed":
      return { source: Icon.XMarkCircle, tintColor: Color.Red };
    default:
      return { source: Icon.Circle, tintColor: Color.SecondaryText };
  }
}

/** `2/4 · Log in to gateway` — current step for the status line. */
export function progressHeadline(progress: OperationProgress): string {
  const index = progress.steps.findIndex((step) => step.status === "active");
  const current =
    index >= 0
      ? progress.steps[index]
      : progress.steps.find((step) => step.status === "failed");
  const n = progress.steps.length;
  const done = progress.steps.filter(
    (step) => step.status === "done" || step.status === "skipped",
  ).length;
  if (progress.status === "succeeded") {
    return `${n}/${n} · Done`;
  }
  if (progress.status === "failed") {
    return current ? `Failed · ${current.label}` : "Failed";
  }
  if (current) {
    return `${done + 1}/${n} · ${current.label}`;
  }
  return `${done}/${n}`;
}

/** Short `2/4` next to the menu bar icon. Raycast forbids long titles. */
export function progressBarTitle(progress: OperationProgress): string {
  const n = Math.max(progress.steps.length, 1);
  const done = progress.steps.filter(
    (step) => step.status === "done" || step.status === "skipped",
  ).length;
  if (progress.status === "running") {
    return `${Math.min(done + 1, n)}/${n}`;
  }
  if (progress.status === "failed") {
    return "err";
  }
  return `${n}/${n}`;
}

function applyStep(
  progress: OperationProgress,
  id: string,
  status: StepStatus,
): boolean {
  const index = progress.steps.findIndex((step) => step.id === id);
  if (index < 0) {
    return false;
  }
  const step = progress.steps[index];
  if (step.status === "done" && status === "active") {
    return false;
  }
  if (step.status === status) {
    return false;
  }
  if (step.status === "failed") {
    return false;
  }
  step.status = status;
  if (status === "done") {
    const next = progress.steps
      .slice(index + 1)
      .find((item) => item.status === "pending");
    if (next) {
      next.status = "active";
    }
  }
  return true;
}

function writeProgress(progress: OperationProgress): void {
  const path = progressPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(progress));
  try {
    renameSync(tmp, path);
  } catch {
    writeFileSync(path, JSON.stringify(progress));
    if (existsSync(tmp)) {
      try {
        unlinkSync(tmp);
      } catch {
        // Best-effort.
      }
    }
  }
}
