const BRIDGE_URL_ENV = "OPENCODE_VSCODE_BRIDGE_URL";
const BRIDGE_TOKEN_ENV = "OPENCODE_VSCODE_BRIDGE_TOKEN";
const BRIDGE_TOKEN_HEADER = "x-opencode-vscode-bridge-token";
const OPENCODE_PORT_ENV = "_EXTENSION_OPENCODE_PORT";
const SESSION_ROUTE_POLL_MS = 250;
const MAX_SESSION_ID_LENGTH = 128;
const MAX_UPDATED_STRING_LENGTH = 64;

type TuiRoute = {
  name: string;
  params?: Record<string, unknown>;
};

type TuiApi = {
  route: {
    readonly current: TuiRoute;
  };
  state?: {
    session?: {
      messages?(sessionId: string): unknown;
    };
  };
  lifecycle?: {
    onDispose?(dispose: () => void): void;
  };
  slots?: {
    register?(plugin: {
      sidebar_title?(input: { session_id: string; title?: string }): unknown;
      sidebar_content?(input: { session_id: string }): unknown;
      session_prompt?(input: { session_id: string }): unknown;
    }): unknown;
  };
};

const tuiSessionPlugin = {
  id: "opencode-tui-integration.tui-session",
  async tui(api: TuiApi) {
    const bridgeUrl = process.env[BRIDGE_URL_ENV];
    const bridgeToken = process.env[BRIDGE_TOKEN_ENV];
    let deliveredSessionId: string | undefined;
    let pendingSessionId: string | undefined;
    let latestRequestId = 0;
    const latestSidebarTitles = new Map<string, string>();

    const postSessionId = (sessionId: string | undefined) => {
      if (!sessionId) {
        deliveredSessionId = undefined;
        return;
      }

      if (sessionId === deliveredSessionId || sessionId === pendingSessionId || !bridgeUrl || !bridgeToken) {
        return;
      }

      pendingSessionId = sessionId;
      const requestId = ++latestRequestId;
      void postActiveSession(bridgeUrl, bridgeToken, sessionId, readSessionMetadata(api, sessionId, latestSidebarTitles))
        .then((delivered) => {
          if (pendingSessionId === sessionId) {
            pendingSessionId = undefined;
          }
          if (delivered && requestId === latestRequestId && readSessionRouteId(api.route.current) === sessionId) {
            deliveredSessionId = sessionId;
          }
        });
    };

    const pollRoute = () => {
      const sessionId = readSessionRouteId(api.route.current);
      postSessionId(sessionId);
    };

    api.slots?.register?.({
      sidebar_content(input) {
        postSessionId(readValidSessionId(input.session_id));
        return undefined;
      },
      session_prompt(input) {
        postSessionId(readValidSessionId(input.session_id));
        return undefined;
      },
      sidebar_title(input) {
        const sessionId = readValidSessionId(input.session_id);
        const title = readCleanString(input.title);
        if (sessionId && title) {
          latestSidebarTitles.set(sessionId, title);
        }

        return undefined;
      },
    });
    pollRoute();
    const interval = setInterval(pollRoute, SESSION_ROUTE_POLL_MS);
    api.lifecycle?.onDispose?.(() => clearInterval(interval));
  },
};

export default tuiSessionPlugin;

function readSessionRouteId(route: TuiRoute) {
  if (route.name !== "session" && route.name !== "sessions") {
    return undefined;
  }

  return readValidSessionId(route.params?.sessionID)
    ?? readValidSessionId(route.params?.sessionId)
    ?? readValidSessionId(route.params?.id)
    ?? readValidSessionId(readRecord(route.params?.session)?.sessionID)
    ?? readValidSessionId(readRecord(route.params?.session)?.sessionId)
    ?? readValidSessionId(readRecord(route.params?.session)?.id);
}

function readValidSessionId(value: unknown) {
  return typeof value === "string" && value.length <= MAX_SESSION_ID_LENGTH && /^ses[A-Za-z0-9_]+$/.test(value)
    ? value
    : undefined;
}

async function postActiveSession(
  bridgeUrl: string,
  bridgeToken: string,
  sessionId: string,
  metadata: Record<string, unknown>,
) {
  try {
    const response = await fetch(bridgeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [BRIDGE_TOKEN_HEADER]: bridgeToken,
      },
      body: JSON.stringify({
        type: "tui.session.active",
        sessionID: sessionId,
        ...readOpenCodePort(),
        ...metadata,
        activationTimestamp: Date.now(),
      }),
    });
    return response.ok || (response.status !== 409 && response.status < 500);
  } catch {
    // Route polling must never interrupt the TUI if the VS Code bridge disappears.
    return false;
  }
}

function readSessionMetadata(api: TuiApi, sessionId: string, latestSidebarTitles: Map<string, string>) {
  const messages = api.state?.session?.messages?.(sessionId);
  const sidebarTitle = latestSidebarTitles.get(sessionId);
  if (!Array.isArray(messages)) {
    return {
      ...(sidebarTitle ? { title: sidebarTitle } : {}),
    };
  }

  const title = sidebarTitle ?? readTitle(messages);
  const updated = readUpdated(messages);
  return {
    ...(title ? { title } : {}),
    ...(updated !== undefined ? { updated } : {}),
  };
}

function readTitle(messages: unknown[]) {
  for (const message of messages) {
    const record = readRecord(message);
    const title = readCleanString(record?.title);
    if (title) {
      return title;
    }

    const summary = readCleanString(record?.summary);
    if (summary) {
      return summary;
    }
  }

  return undefined;
}

function readUpdated(messages: unknown[]) {
  for (const message of [...messages].reverse()) {
    const record = readRecord(message);
    const updated = record?.timeUpdated ?? record?.updated;
    if (typeof updated === "number" && Number.isFinite(updated)) {
      return updated;
    }

    if (typeof updated === "string" && updated.length <= MAX_UPDATED_STRING_LENGTH) {
      return updated;
    }
  }

  return undefined;
}

function readRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readCleanString(value: unknown) {
  const cleaned = typeof value === "string"
    ? sanitizeDisplayText(value, 240)
    : undefined;
  return cleaned
    ? cleaned
    : undefined;
}

function sanitizeDisplayText(value: string, maxLength: number) {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length <= maxLength
    ? cleaned
    : `${cleaned.slice(0, maxLength - 3)}...`;
}

function readOpenCodePort() {
  const rawPort = process.env[OPENCODE_PORT_ENV];
  if (!rawPort) {
    return {};
  }

  const openCodePort = Number.parseInt(rawPort, 10);
  return Number.isInteger(openCodePort) && openCodePort > 0 && openCodePort <= 65535
    ? { openCodePort }
    : {};
}
