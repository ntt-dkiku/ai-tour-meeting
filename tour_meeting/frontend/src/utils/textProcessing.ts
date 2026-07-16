// Text processing utilities for normalizing internal log display

const SEARCH_RESULTS_DUPLICATE_REGEX =
  /(?:^|\n)(?:Result\s*\n)?gpt-5 search results for '([^']+)':/g;

export const collapseDuplicateSearchResults = (text: string): string => {
  if (!text) {
    return text;
  }
  const matches = [...text.matchAll(SEARCH_RESULTS_DUPLICATE_REGEX)];
  if (matches.length <= 1) {
    return text;
  }

  type Segment = { start: number; end: number; query: string };
  const segments: Segment[] = matches.map((match) => ({
    start: match.index ?? 0,
    end: 0,
    query: match[1] ?? "",
  }));
  segments.forEach((segment, idx) => {
    segment.end = idx + 1 < segments.length ? segments[idx + 1].start : text.length;
  });

  const lastStartByQuery = new Map<string, number>();
  segments.forEach((segment) => {
    lastStartByQuery.set(segment.query, segment.start);
  });

  let cursor = 0;
  let result = "";
  for (const segment of segments) {
    if (cursor < segment.start) {
      result += text.slice(cursor, segment.start);
    }
    if (segment.start === lastStartByQuery.get(segment.query)) {
      result += text.slice(segment.start, segment.end);
    }
    cursor = segment.end;
  }
  if (cursor < text.length) {
    result += text.slice(cursor);
  }
  return result;
};

export const removeResponseOutputTextBlocks = (text: string): string => {
  const marker = "ResponseOutputText(";
  let cursor = 0;
  let normalized = "";
  while (cursor < text.length) {
    const start = text.indexOf(marker, cursor);
    if (start === -1) {
      normalized += text.slice(cursor);
      break;
    }
    normalized += text.slice(cursor, start);
    let depth = 0;
    let idx = start;
    while (idx < text.length) {
      const char = text[idx];
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          idx += 1;
          break;
        }
      }
      idx += 1;
    }
    cursor = idx;
    while (cursor < text.length && ["\n", "\r"].includes(text[cursor])) {
      cursor += 1;
    }
  }
  return normalized;
};

export const normalizeStepsLogForDisplay = (text: string): string =>
  collapseDuplicateSearchResults(removeResponseOutputTextBlocks(text));
