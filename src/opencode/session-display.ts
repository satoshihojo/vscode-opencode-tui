export function readSessionDirectoryLabel(directory?: string) {
  const normalized = directory?.trim()?.replaceAll("\\", "/");
  if (!normalized) {
    return undefined;
  }

  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return normalized === "/" ? "/" : normalized;
  }

  return segments.at(-1);
}

export function formatSessionUpdatedLabel(
  updated?: number | string,
  options: { now?: Date } = {},
) {
  const timestamp = readSessionUpdatedTimestamp(updated);
  if (timestamp === undefined) {
    return undefined;
  }

  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    return undefined;
  }

  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    return undefined;
  }

  const timeLabel = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (isSameLocalDate(date, now)) {
    return timeLabel;
  }

  const monthDayLabel = `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  if (date.getFullYear() === now.getFullYear()) {
    return `${timeLabel} ${monthDayLabel}`;
  }

  return `${timeLabel} ${date.getFullYear()}-${monthDayLabel}`;
}

function readSessionUpdatedTimestamp(updated?: number | string) {
  if (updated === undefined) {
    return undefined;
  }

  const numericValue = typeof updated === "number"
    ? updated
    : Number.parseInt(updated.trim(), 10);
  if (!Number.isFinite(numericValue)) {
    return undefined;
  }

  const truncatedValue = Math.trunc(numericValue);
  if (truncatedValue >= 946684800000) {
    return truncatedValue;
  }

  if (truncatedValue >= 946684800 && truncatedValue < 32503680000) {
    return truncatedValue * 1000;
  }

  return undefined;
}

function isSameLocalDate(left: Date, right: Date) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function pad2(value: number) {
  return value.toString().padStart(2, "0");
}
