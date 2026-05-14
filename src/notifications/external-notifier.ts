import os from "node:os";
import nodeNotifier from "node-notifier";
import type { ExternalNotification, ExternalNotifier } from "./opencode-notifier";

export type NodeNotifierNotification = {
  title: string;
  message: string;
  urgency: "normal" | "critical";
  timeout: number;
};

type NodeNotifierLike = {
  notify(notification: NodeNotifierNotification, callback?: (error: Error | null, response: string) => void): unknown;
};

const EXTERNAL_NOTIFICATION_TIMEOUT_SECONDS = 10;
const MAX_EXTERNAL_TEXT_LENGTH = 512;

export class NodeNotifierExternalNotifier implements ExternalNotifier {
  constructor(private readonly notifier: NodeNotifierLike | undefined = createPlatformNotifier()) {}

  notify(notification: ExternalNotification) {
    if (!this.notifier) {
      return;
    }

    this.notifier.notify(toNodeNotifierNotification(notification), () => undefined);
  }
}

export function createPlatformNotifier(
  platform: NodeJS.Platform = process.platform,
  release: string = os.release(),
): NodeNotifierLike | undefined {
  if (platform === "linux" && release.toLowerCase().includes("microsoft")) {
    return new nodeNotifier.WindowsToaster({ withFallback: false });
  }

  switch (platform) {
    case "linux":
      return new nodeNotifier.NotifySend({ withFallback: false });
    case "darwin":
      return new nodeNotifier.NotificationCenter({ withFallback: false });
    case "win32":
      return new nodeNotifier.WindowsToaster({ withFallback: false });
    default:
      return undefined;
  }
}

export function toNodeNotifierNotification(notification: ExternalNotification): NodeNotifierNotification {
  return {
    title: sanitizeExternalText(notification.title),
    message: sanitizeExternalText(notification.message),
    urgency: notification.kind === "idle" ? "normal" : "critical",
    timeout: EXTERNAL_NOTIFICATION_TIMEOUT_SECONDS,
  };
}

function sanitizeExternalText(value: string) {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const safeValue = cleaned || "OpenCode";
  return safeValue.length <= MAX_EXTERNAL_TEXT_LENGTH
    ? safeValue
    : `${safeValue.slice(0, MAX_EXTERNAL_TEXT_LENGTH - 3)}...`;
}
