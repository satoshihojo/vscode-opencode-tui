import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPlatformNotifier,
  NodeNotifierExternalNotifier,
  toNodeNotifierNotification,
} from "../../src/notifications/external-notifier";
import nodeNotifier from "node-notifier";

describe("toNodeNotifierNotification", () => {
  it("maps idle notifications to a normal-priority payload", () => {
    assert.deepEqual(toNodeNotifierNotification({
      kind: "idle",
      title: "OpenCode",
      message: "OpenCode session finished.",
    }), {
      title: "OpenCode",
      message: "OpenCode session finished.",
      urgency: "normal",
      timeout: 10,
    });
  });

  it("maps permission and error notifications to critical priority", () => {
    assert.equal(toNodeNotifierNotification({
      kind: "permission",
      title: "OpenCode",
      message: "OpenCode is waiting for permission: Run command",
    }).urgency, "critical");

    assert.equal(toNodeNotifierNotification({
      kind: "error",
      title: "OpenCode",
      message: "OpenCode session reported an error.",
    }).urgency, "critical");
  });

  it("sanitizes and truncates notification text", () => {
    const notification = toNodeNotifierNotification({
      kind: "permission",
      title: "\u202e\n\t",
      message: `Run\ncommand\u202e ${"x".repeat(600)}`,
    });

    assert.equal(notification.title, "OpenCode");
    assert.match(notification.message, /^Run command x+/);
    assert.equal(notification.message.includes("\n"), false);
    assert.equal(notification.message.includes("\u202e"), false);
    assert.equal(notification.message.length, 512);
    assert.equal(notification.message.endsWith("..."), true);
  });
});

describe("NodeNotifierExternalNotifier", () => {
  it("uses node-notifier platform notifiers without fallback", () => {
    const linuxNotifier = new nodeNotifier.NotifySend({ withFallback: false });
    const macNotifier = new nodeNotifier.NotificationCenter({ withFallback: false });
    const windowsNotifier = new nodeNotifier.WindowsToaster({ withFallback: false });

    assert.equal(typeof linuxNotifier.notify, "function");
    assert.equal(typeof macNotifier.notify, "function");
    assert.equal(typeof windowsNotifier.notify, "function");
  });

  it("uses Windows toast notifications on WSL", () => {
    const notifier = createPlatformNotifier("linux", "5.15.167.4-microsoft-standard-WSL2");

    assert.ok(notifier instanceof nodeNotifier.WindowsToaster);
  });

  it("uses notify-send on non-WSL Linux", () => {
    const notifier = createPlatformNotifier("linux", "6.8.0-58-generic");

    assert.ok(notifier instanceof nodeNotifier.NotifySend);
  });

  it("forwards built notifications to node-notifier", () => {
    const notifications: unknown[] = [];
    const notifier = new NodeNotifierExternalNotifier({
      notify: (notification, callback) => {
        notifications.push(notification);
        callback?.(null, "sent");
      },
    });

    notifier.notify({
      kind: "error",
      title: "OpenCode",
      message: "OpenCode session reported an error.",
    });

    assert.deepEqual(notifications, [{
      title: "OpenCode",
      message: "OpenCode session reported an error.",
      urgency: "critical",
      timeout: 10,
    }]);
  });
});
