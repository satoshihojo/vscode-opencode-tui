export type ActiveSessionPanelSelection =
  | { type: "ignore" }
  | { type: "clear" }
  | { type: "select"; restoreId: string };

export function resolveActiveSessionPanelSelection<T>({
  terminalAtRequest,
  activeTerminal,
  restoreId,
}: {
  terminalAtRequest: T | undefined;
  activeTerminal: T | undefined;
  restoreId?: string;
}): ActiveSessionPanelSelection {
  if (terminalAtRequest !== activeTerminal) {
    return { type: "ignore" };
  }

  return restoreId
    ? { type: "select", restoreId }
    : { type: "clear" };
}
