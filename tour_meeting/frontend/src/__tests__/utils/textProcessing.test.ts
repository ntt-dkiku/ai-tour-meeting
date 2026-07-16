import { describe, it, expect } from "vitest";
import {
  collapseDuplicateSearchResults,
  removeResponseOutputTextBlocks,
  normalizeStepsLogForDisplay,
} from "../../utils/textProcessing";

describe("collapseDuplicateSearchResults", () => {
  it("should return empty string for empty input", () => {
    expect(collapseDuplicateSearchResults("")).toBe("");
  });

  it("should return null/undefined as-is", () => {
    expect(collapseDuplicateSearchResults(null as unknown as string)).toBe(null);
    expect(collapseDuplicateSearchResults(undefined as unknown as string)).toBe(undefined);
  });

  it("should return text unchanged when no search results present", () => {
    const text = "Some regular text without search results.";
    expect(collapseDuplicateSearchResults(text)).toBe(text);
  });

  it("should return text unchanged when only one search result exists", () => {
    const text = "gpt-5 search results for 'tokyo restaurants':\n- Result 1\n- Result 2";
    expect(collapseDuplicateSearchResults(text)).toBe(text);
  });

  it("should collapse duplicate search results for same query", () => {
    // Note: The function removes content between duplicate search results,
    // keeping only text before the first occurrence and the last occurrence's content
    const text = `Some text
gpt-5 search results for 'tokyo':
- First result

More text
gpt-5 search results for 'tokyo':
- Updated result`;

    const result = collapseDuplicateSearchResults(text);
    expect(result).not.toContain("- First result");
    expect(result).toContain("- Updated result");
    expect(result).toContain("Some text");
    // "More text" is intentionally removed as it's between duplicate search results
    expect(result).not.toContain("More text");
  });

  it("should preserve different queries", () => {
    const text = `gpt-5 search results for 'tokyo':
- Tokyo result

gpt-5 search results for 'osaka':
- Osaka result`;

    const result = collapseDuplicateSearchResults(text);
    expect(result).toContain("Tokyo result");
    expect(result).toContain("Osaka result");
  });

  it("should handle 'Result' prefix before search results", () => {
    const text = `Result
gpt-5 search results for 'query':
- Old data

Result
gpt-5 search results for 'query':
- New data`;

    const result = collapseDuplicateSearchResults(text);
    expect(result).toContain("- New data");
  });
});

describe("removeResponseOutputTextBlocks", () => {
  it("should return text unchanged when no ResponseOutputText blocks", () => {
    const text = "Regular text without any blocks.";
    expect(removeResponseOutputTextBlocks(text)).toBe(text);
  });

  it("should remove simple ResponseOutputText block", () => {
    const text = "Before ResponseOutputText(some content) After";
    expect(removeResponseOutputTextBlocks(text)).toBe("Before  After");
  });

  it("should handle nested parentheses", () => {
    const text = "Start ResponseOutputText(outer(inner(deep))) End";
    expect(removeResponseOutputTextBlocks(text)).toBe("Start  End");
  });

  it("should remove multiple ResponseOutputText blocks", () => {
    const text = "A ResponseOutputText(first) B ResponseOutputText(second) C";
    expect(removeResponseOutputTextBlocks(text)).toBe("A  B  C");
  });

  it("should skip newlines after removed blocks", () => {
    const text = "Before\nResponseOutputText(block)\n\nAfter";
    const result = removeResponseOutputTextBlocks(text);
    expect(result).toBe("Before\nAfter");
  });

  it("should handle empty input", () => {
    expect(removeResponseOutputTextBlocks("")).toBe("");
  });

  it("should handle block at start of text", () => {
    const text = "ResponseOutputText(content) After";
    expect(removeResponseOutputTextBlocks(text)).toBe(" After");
  });

  it("should handle block at end of text", () => {
    const text = "Before ResponseOutputText(content)";
    expect(removeResponseOutputTextBlocks(text)).toBe("Before ");
  });

  it("should handle deeply nested parentheses", () => {
    const text = "ResponseOutputText(a(b(c(d)e)f)g)";
    expect(removeResponseOutputTextBlocks(text)).toBe("");
  });
});

describe("normalizeStepsLogForDisplay", () => {
  it("should apply both transformations", () => {
    const text = `ResponseOutputText(remove this)
gpt-5 search results for 'test':
- Old result

gpt-5 search results for 'test':
- New result`;

    const result = normalizeStepsLogForDisplay(text);
    expect(result).not.toContain("ResponseOutputText");
    expect(result).not.toContain("Old result");
    expect(result).toContain("New result");
  });

  it("should handle text that needs no transformation", () => {
    const text = "Clean text with no special blocks.";
    expect(normalizeStepsLogForDisplay(text)).toBe(text);
  });

  it("should handle empty string", () => {
    expect(normalizeStepsLogForDisplay("")).toBe("");
  });
});
