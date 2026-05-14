export type OpenCodeSessionTabStatus = "normal" | "running" | "idle" | "permission" | "error";

export type OpenCodeSessionTab = {
  restoreId: string;
  title: string;
  sessionId?: string;
  cwd?: string;
  updated?: number | string;
  status: OpenCodeSessionTabStatus;
  hidden: boolean;
  unread: boolean;
};

export type OpenCodeSessionTabState = {
  tabsByRestoreId: Record<string, OpenCodeSessionTab>;
  order: string[];
  selectedRestoreId?: string;
};

export type RegisterOpenCodeSessionTabInput = {
  restoreId: string;
  title?: string;
  sessionId?: string;
  cwd?: string;
  updated?: number | string;
  status?: OpenCodeSessionTabStatus;
  hidden?: boolean;
};

export function registerOpenCodeSessionTab(
  state: OpenCodeSessionTabState,
  input: RegisterOpenCodeSessionTabInput,
): OpenCodeSessionTabState {
  const existing = state.tabsByRestoreId[input.restoreId];
  const hasUpdated = Object.prototype.hasOwnProperty.call(input, "updated");
  const nextTab: OpenCodeSessionTab = existing
    ? withRegisteredUpdated(
        {
          ...existing,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.hidden !== undefined ? { hidden: input.hidden } : {}),
        },
        hasUpdated,
        input.updated,
      )
    : withRegisteredUpdated(
        {
          restoreId: input.restoreId,
          title: input.title?.trim() || input.sessionId || "new session",
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
          status: input.status ?? "normal",
          hidden: input.hidden ?? false,
          unread: false,
        },
        hasUpdated,
        input.updated,
      );

  const order = existing || state.order.includes(input.restoreId)
    ? state.order
    : [...state.order, input.restoreId];
  const selectedRestoreId = state.selectedRestoreId ?? (state.order.length === 0 ? input.restoreId : undefined);

  if (existing && tabsEqual(existing, nextTab) && order === state.order && selectedRestoreId === state.selectedRestoreId) {
    return state;
  }

  return {
    tabsByRestoreId: existing && tabsEqual(existing, nextTab)
      ? state.tabsByRestoreId
      : { ...state.tabsByRestoreId, [input.restoreId]: nextTab },
    order,
    selectedRestoreId,
  };
}

export function selectOpenCodeSessionTab(state: OpenCodeSessionTabState, restoreId: string): OpenCodeSessionTabState {
  const tab = state.tabsByRestoreId[restoreId];
  if (!tab) {
    return state;
  }

  const nextTab = tab.hidden || tab.unread ? { ...tab, hidden: false, unread: false } : tab;
  if (state.selectedRestoreId === restoreId && nextTab === tab) {
    return state;
  }

  return {
    ...state,
    selectedRestoreId: restoreId,
    tabsByRestoreId: nextTab === tab
      ? state.tabsByRestoreId
      : { ...state.tabsByRestoreId, [restoreId]: nextTab },
  };
}

export function updateOpenCodeSessionTabStatus(
  state: OpenCodeSessionTabState,
  restoreId: string,
  status: OpenCodeSessionTabStatus,
): OpenCodeSessionTabState {
  return updateOpenCodeSessionTab(state, restoreId, (tab) => {
    if (tab.status === status) {
      return tab;
    }
    return {
      ...tab,
      status,
      unread: shouldMarkUnread(state, tab),
    };
  });
}

export function updateOpenCodeSessionTabTitle(
  state: OpenCodeSessionTabState,
  restoreId: string,
  title: string,
): OpenCodeSessionTabState {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) {
    return state;
  }

  return updateOpenCodeSessionTab(state, restoreId, (tab) => {
    if (tab.title === normalizedTitle) {
      return tab;
    }
    return {
      ...tab,
      title: normalizedTitle,
      unread: shouldMarkUnread(state, tab),
    };
  });
}

export function closeOpenCodeSessionTab(state: OpenCodeSessionTabState, restoreId: string): OpenCodeSessionTabState {
  if (!state.tabsByRestoreId[restoreId]) {
    return state;
  }

  const closedIndex = state.order.indexOf(restoreId);
  const order = state.order.filter((candidate) => candidate !== restoreId);
  const { [restoreId]: _closed, ...tabsByRestoreId } = state.tabsByRestoreId;
  const selectedRestoreId = state.selectedRestoreId === restoreId
    ? order[closedIndex] ?? order[closedIndex - 1]
    : state.selectedRestoreId;

  return {
    tabsByRestoreId,
    order,
    ...(selectedRestoreId ? { selectedRestoreId } : {}),
  };
}

export function clearOpenCodeSessionTabSelection(state: OpenCodeSessionTabState): OpenCodeSessionTabState {
  if (!state.selectedRestoreId) {
    return state;
  }

  return {
    ...state,
    selectedRestoreId: undefined,
  };
}

function updateOpenCodeSessionTab(
  state: OpenCodeSessionTabState,
  restoreId: string,
  update: (tab: OpenCodeSessionTab) => OpenCodeSessionTab,
) {
  const tab = state.tabsByRestoreId[restoreId];
  if (!tab) {
    return state;
  }

  const nextTab = update(tab);
  if (nextTab === tab || tabsEqual(nextTab, tab)) {
    return state;
  }

  return {
    ...state,
    tabsByRestoreId: {
      ...state.tabsByRestoreId,
      [restoreId]: nextTab,
    },
  };
}

function shouldMarkUnread(state: OpenCodeSessionTabState, tab: OpenCodeSessionTab) {
  return tab.unread || tab.hidden || state.selectedRestoreId !== tab.restoreId;
}

function tabsEqual(left: OpenCodeSessionTab, right: OpenCodeSessionTab) {
  return left.restoreId === right.restoreId
    && left.title === right.title
    && left.sessionId === right.sessionId
    && left.cwd === right.cwd
    && left.updated === right.updated
    && left.status === right.status
    && left.hidden === right.hidden
    && left.unread === right.unread;
}

function withRegisteredUpdated<T extends OpenCodeSessionTab>(
  tab: T,
  hasUpdated: boolean,
  updated: number | string | undefined,
): T {
  if (!hasUpdated) {
    return tab;
  }

  if (updated === undefined) {
    const { updated: _updated, ...withoutUpdated } = tab;
    return withoutUpdated as T;
  }

  return {
    ...tab,
    updated,
  };
}
