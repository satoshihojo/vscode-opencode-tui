export type PatchHunk =
  | { type: "add"; path: string; contents: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; move_path?: string; chunks: UpdateFileChunk[] };

export type UpdateFileChunk = {
  old_lines: string[];
  new_lines: string[];
  change_context?: string;
  is_end_of_file?: boolean;
};

export class PatchApplicationError extends Error {
  constructor(filePath: string, hunkIndex: number, reason: string) {
    super(`Patch hunk ${hunkIndex} failed in ${filePath}: ${reason}. No files were changed.`);
    this.name = "PatchApplicationError";
  }
}

export function parsePatch(patchText: string): PatchHunk[] {
  const cleaned = stripHeredoc(patchText.trim());
  const lines = cleaned.split("\n");
  const beginIdx = lines.findIndex((line) => line.trim() === "*** Begin Patch");
  const endIdx = lines.findIndex((line) => line.trim() === "*** End Patch");
  if (beginIdx === -1 || endIdx === -1 || beginIdx >= endIdx) {
    throw new Error("Invalid patch format: missing Begin/End markers");
  }

  const hunks: PatchHunk[] = [];
  let index = beginIdx + 1;
  while (index < endIdx) {
    const header = parsePatchHeader(lines, index);
    if (!header) {
      index++;
      continue;
    }

    if (lines[index].startsWith("*** Add File:")) {
      const { content, nextIdx } = parseAddFileContent(lines, header.nextIdx);
      hunks.push({ type: "add", path: header.filePath, contents: content });
      index = nextIdx;
      continue;
    }

    if (lines[index].startsWith("*** Delete File:")) {
      hunks.push({ type: "delete", path: header.filePath });
      index = header.nextIdx;
      continue;
    }

    const { chunks, nextIdx } = parseUpdateFileChunks(lines, header.nextIdx);
    hunks.push({ type: "update", path: header.filePath, move_path: header.movePath, chunks });
    index = nextIdx;
  }

  return hunks;
}

export function deriveNewContentsFromChunks(sourceText: string, filePath: string, chunks: UpdateFileChunk[]): string {
  let originalLines = sourceText.split("\n");
  if (originalLines.length > 0 && originalLines[originalLines.length - 1] === "") {
    originalLines = originalLines.slice(0, -1);
  }

  const replacements = computeReplacements(originalLines, filePath, chunks);
  const newLines = applyReplacements(originalLines, replacements);
  if (newLines.length === 0 || newLines[newLines.length - 1] !== "") {
    newLines.push("");
  }
  return newLines.join("\n");
}

function stripHeredoc(input: string): string {
  const heredocMatch = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
  if (heredocMatch) {
    return heredocMatch[2];
  }
  return input;
}

function parsePatchHeader(
  lines: string[],
  startIdx: number,
): { filePath: string; movePath?: string; nextIdx: number } | undefined {
  const line = lines[startIdx];
  if (line.startsWith("*** Add File:")) {
    const filePath = line.slice("*** Add File:".length).trim();
    if (filePath) {
      return { filePath, nextIdx: startIdx + 1 };
    }
  }
  if (line.startsWith("*** Delete File:")) {
    const filePath = line.slice("*** Delete File:".length).trim();
    if (filePath) {
      return { filePath, nextIdx: startIdx + 1 };
    }
  }
  if (line.startsWith("*** Update File:")) {
    const filePath = line.slice("*** Update File:".length).trim();
    let movePath: string | undefined;
    let nextIdx = startIdx + 1;
    if (nextIdx < lines.length && lines[nextIdx].startsWith("*** Move to:")) {
      movePath = lines[nextIdx].slice("*** Move to:".length).trim();
      nextIdx++;
    }
    if (filePath) {
      return { filePath, movePath, nextIdx };
    }
  }
}

function parseUpdateFileChunks(lines: string[], startIdx: number): { chunks: UpdateFileChunk[]; nextIdx: number } {
  const chunks: UpdateFileChunk[] = [];
  let index = startIdx;

  while (index < lines.length && !lines[index].startsWith("***")) {
    if (!lines[index].startsWith("@@")) {
      index++;
      continue;
    }

    const contextLine = lines[index].slice(2).trim();
    index++;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let isEndOfFile = false;

    while (index < lines.length && !lines[index].startsWith("@@") && isUpdateChunkLine(lines[index])) {
      const line = lines[index];
      if (line === "*** End of File") {
        isEndOfFile = true;
        index++;
        break;
      }

      if (line.startsWith(" ")) {
        const content = line.slice(1);
        oldLines.push(content);
        newLines.push(content);
      } else if (line.startsWith("-")) {
        oldLines.push(line.slice(1));
      } else if (line.startsWith("+")) {
        newLines.push(line.slice(1));
      }
      index++;
    }

    chunks.push({
      old_lines: oldLines,
      new_lines: newLines,
      change_context: contextLine || undefined,
      is_end_of_file: isEndOfFile || undefined,
    });
  }

  return { chunks, nextIdx: index };
}

function isUpdateChunkLine(line: string) {
  return !line.startsWith("***") || line === "*** End of File";
}

function parseAddFileContent(lines: string[], startIdx: number): { content: string; nextIdx: number } {
  let content = "";
  let index = startIdx;
  while (index < lines.length && !lines[index].startsWith("***")) {
    if (lines[index].startsWith("+")) {
      content += lines[index].slice(1) + "\n";
    }
    index++;
  }
  if (content.endsWith("\n")) {
    content = content.slice(0, -1);
  }
  return { content, nextIdx: index };
}

function computeReplacements(
  originalLines: string[],
  filePath: string,
  chunks: UpdateFileChunk[],
): Array<[number, number, string[]]> {
  const replacements: Array<[number, number, string[]]> = [];
  let lineIndex = 0;
  let previousInsertionContext: { changeContext: string; contextIndex: number } | undefined;

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    const hunkIndex = chunkIndex + 1;
    const hasChangeContext = !!chunk.change_context;
    let contextIndex: number | undefined;
    if (chunk.change_context) {
      contextIndex = seekSequence(originalLines, [chunk.change_context], lineIndex);
      if (
        contextIndex === -1
        && chunk.old_lines.length === 0
        && previousInsertionContext?.changeContext === chunk.change_context
      ) {
        contextIndex = previousInsertionContext.contextIndex;
      }
      if (contextIndex === -1) {
        throw new PatchApplicationError(filePath, hunkIndex, `context line was not found: ${chunk.change_context}`);
      }
      lineIndex = contextIndex + 1;
    }

    if (chunk.old_lines.length === 0) {
      const insertionIdx = hasChangeContext && !chunk.is_end_of_file
        ? (contextIndex ?? lineIndex) + 1
        : originalLines.length > 0 && originalLines[originalLines.length - 1] === "" ? originalLines.length - 1 : originalLines.length;
      assertReplacementDoesNotOverlap(replacements, insertionIdx, 0, filePath, hunkIndex);
      replacements.push([insertionIdx, 0, chunk.new_lines]);
      previousInsertionContext = chunk.change_context && contextIndex !== undefined
        ? { changeContext: chunk.change_context, contextIndex }
        : undefined;
      continue;
    }

    previousInsertionContext = undefined;

    let pattern = chunk.old_lines;
    let replacement = chunk.new_lines;
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.is_end_of_file);

    if (found === -1 && pattern.length > 0 && pattern[pattern.length - 1] === "") {
      pattern = pattern.slice(0, -1);
      if (replacement.length > 0 && replacement[replacement.length - 1] === "") {
        replacement = replacement.slice(0, -1);
      }
      found = seekSequence(originalLines, pattern, lineIndex, chunk.is_end_of_file);
    }

    if (found === -1) {
      found = findFallbackReplacement(originalLines, pattern, replacements, chunk.is_end_of_file);
    }

    if (found === -1) {
      throw new PatchApplicationError(filePath, hunkIndex, `expected lines were not found:\n${chunk.old_lines.join("\n")}`);
    }

    assertReplacementDoesNotOverlap(replacements, found, pattern.length, filePath, hunkIndex);
    replacements.push([found, pattern.length, replacement]);
    lineIndex = found + pattern.length;
  }

  replacements.sort((left, right) => left[0] - right[0]);
  return replacements;
}

function findFallbackReplacement(
  lines: string[],
  pattern: string[],
  replacements: Array<[number, number, string[]]>,
  endOfFile = false,
) {
  const candidates = seekAllSequences(lines, pattern, 0, endOfFile).filter((candidate) => {
    return !overlapsAnyReplacement(candidate, pattern.length, replacements);
  });

  return candidates.length === 1 ? candidates[0] : -1;
}

function assertReplacementDoesNotOverlap(
  replacements: Array<[number, number, string[]]>,
  start: number,
  removeCount: number,
  filePath: string,
  hunkIndex: number,
) {
  if (overlapsAnyReplacement(start, removeCount, replacements)) {
    throw new PatchApplicationError(filePath, hunkIndex, "replacement overlaps with another patch hunk");
  }
}

function overlapsAnyReplacement(start: number, removeCount: number, replacements: Array<[number, number, string[]]>) {
  const end = start + Math.max(removeCount, 1);
  return replacements.some(([existingStart, existingRemoveCount]) => {
    if (removeCount === 0 && existingRemoveCount === 0) {
      return false;
    }
    const existingEnd = existingStart + Math.max(existingRemoveCount, 1);
    return start < existingEnd && existingStart < end;
  });
}

function applyReplacements(lines: string[], replacements: Array<[number, number, string[]]>): string[] {
  const result = [...lines];
  for (let index = replacements.length - 1; index >= 0; index--) {
    const [start, removeCount, nextLines] = replacements[index];
    result.splice(start, removeCount, ...nextLines);
  }
  return result;
}

function normalizeUnicode(value: string): string {
  return value
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ");
}

function seekSequence(lines: string[], pattern: string[], startIndex: number, endOfFile = false) {
  return seekAllSequences(lines, pattern, startIndex, endOfFile)[0] ?? -1;
}

function seekAllSequences(lines: string[], pattern: string[], startIndex: number, endOfFile = false) {
  if (pattern.length === 0) {
    return [];
  }

  const comparers: Array<(left: string, right: string) => boolean> = [
    (left, right) => left === right,
    (left, right) => left.trimEnd() === right.trimEnd(),
    (left, right) => left.trim() === right.trim(),
    (left, right) => normalizeUnicode(left.trim()) === normalizeUnicode(right.trim()),
  ];

  for (const compare of comparers) {
    const matches = collectMatches(lines, pattern, startIndex, compare, endOfFile);
    if (matches.length > 0) {
      return matches;
    }
  }

  return [];
}

function collectMatches(
  lines: string[],
  pattern: string[],
  startIndex: number,
  compare: (left: string, right: string) => boolean,
  endOfFile: boolean,
) {
  const matches: number[] = [];
  if (endOfFile) {
    const fromEnd = lines.length - pattern.length;
    if (fromEnd >= startIndex && sequenceMatches(lines, pattern, fromEnd, compare)) {
      matches.push(fromEnd);
    }
    return matches;
  }

  for (let index = startIndex; index <= lines.length - pattern.length; index++) {
    if (sequenceMatches(lines, pattern, index, compare)) {
      matches.push(index);
    }
  }

  return matches;
}

function sequenceMatches(
  lines: string[],
  pattern: string[],
  startIndex: number,
  compare: (left: string, right: string) => boolean,
) {
  for (let offset = 0; offset < pattern.length; offset++) {
    if (!compare(lines[startIndex + offset], pattern[offset])) {
      return false;
    }
  }
  return true;
}
