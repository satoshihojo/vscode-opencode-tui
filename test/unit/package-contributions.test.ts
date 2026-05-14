import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

type PackageJson = {
  activationEvents: string[];
  engines: {
    vscode: string;
  };
  contributes: {
    commands: Array<{
      command: string;
      icon?: {
        light: string;
        dark: string;
      };
    }>;
    menus: {
      "commandPalette"?: Array<{
        command: string;
      }>;
      "editor/title"?: Array<{
        command: string;
        group: string;
      }>;
    };
    viewsContainers?: {
      panel?: Array<{
        id: string;
        title: string;
      }>;
    };
    configuration?: {
      properties: Record<string, { type: string; default: unknown }>;
    };
    views?: Record<string, Array<{
      id: string;
      name: string;
      type?: string;
      when?: string;
    }>>;
  };
};

describe("package contributions", () => {
  it("keeps the OpenCode start command off the editor title toolbar", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;

    assert.equal(packageJson.contributes.menus["editor/title"]?.some(
      (item) => item.command === "opencodeEdit.startSession",
    ) ?? false, false);
  });

  it("does not expose internal debug commands through package contributions", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;
    const contributedCommands = packageJson.contributes.commands.map((command) => command.command);
    const commandPaletteCommands = packageJson.contributes.menus.commandPalette?.map((item) => item.command) ?? [];
    const exposedCommands = [
      ...packageJson.activationEvents,
      ...contributedCommands,
      ...commandPaletteCommands,
    ];

    assert.equal(exposedCommands.some((command) => command.includes("opencodeEdit.debug.")), false);
  });

  it("contributes OpenCode notification settings", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;
    const properties = packageJson.contributes.configuration?.properties ?? {};

    assert.equal(properties["opencodeEdit.notifications.enabled"]?.default, true);
    assert.equal(properties["opencodeEdit.notifications.backgroundOnly"]?.default, true);
    assert.equal(properties["opencodeEdit.notifications.onIdle"]?.default, true);
    assert.equal(properties["opencodeEdit.notifications.onPermission"]?.default, true);
    assert.equal(properties["opencodeEdit.notifications.onError"]?.default, true);
  });

  it("declares the minimum VS Code runtime needed for node:sqlite support", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;

    assert.equal(packageJson.engines.vscode, "^1.118.0");
  });

  it("contributes the OpenCode sessions webview", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;

    assert.equal(packageJson.activationEvents.includes("onView:opencodeEdit.sessionsPanel"), false);
    assert.equal(packageJson.contributes.viewsContainers?.panel?.find(
      (container) => container.id === "opencodeEdit",
    )?.title, "OpenCode");
    assert.deepEqual(packageJson.contributes.views?.opencodeEdit?.find(
      (view) => view.id === "opencodeEdit.sessionsPanel",
    ), {
      id: "opencodeEdit.sessionsPanel",
      name: "Sessions",
      type: "webview",
    });
    assert.deepEqual(packageJson.contributes.views?.opencodeEdit?.find(
      (view) => view.id === "opencodeEdit.reviewPanel",
    ), {
      id: "opencodeEdit.reviewPanel",
      name: "Review",
      type: "webview",
    });
    assert.equal(packageJson.contributes.views?.opencodeEdit?.find(
      (view) => view.id === "opencodeEdit.reviewPanel",
    )?.when, undefined);
  });
});
