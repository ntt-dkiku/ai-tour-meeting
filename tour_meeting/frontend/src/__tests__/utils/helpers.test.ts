import { describe, it, expect } from "vitest";
import {
  normalizeNameForKey,
  buildInternalKey,
  buildExpandedStorageKey,
  isMessageEntry,
  findLastMessageEntry,
  countMessagesWithTurn,
} from "../../utils/helpers";
import type { LogEntry, MessageOut, PhaseLogEntry } from "../../types";

describe("helpers utilities", () => {
  describe("normalizeNameForKey", () => {
    it("should replace whitespace with underscores", () => {
      expect(normalizeNameForKey("John Doe")).toBe("John_Doe");
      expect(normalizeNameForKey("A B C")).toBe("A_B_C");
    });

    it("should handle special characters", () => {
      expect(normalizeNameForKey("test<name>")).toBe("test_name");
      expect(normalizeNameForKey("name|with|pipes")).toBe("name_with_pipes");
      expect(normalizeNameForKey("path\\to/file")).toBe("path_to_file");
    });

    it("should trim leading and trailing underscores", () => {
      expect(normalizeNameForKey(" trimmed ")).toBe("trimmed");
      expect(normalizeNameForKey("__test__")).toBe("test");
    });

    it("should return 'anon' for empty or null input", () => {
      expect(normalizeNameForKey("")).toBe("anon");
      expect(normalizeNameForKey(null)).toBe("anon");
      expect(normalizeNameForKey(undefined)).toBe("anon");
    });

    it("should truncate names longer than 64 characters", () => {
      const longName = "a".repeat(100);
      expect(normalizeNameForKey(longName).length).toBe(64);
    });

    it("should handle Japanese full-width spaces", () => {
      expect(normalizeNameForKey("山田　太郎")).toBe("山田_太郎");
    });
  });

  describe("buildInternalKey", () => {
    it("should build key from turn and speaker", () => {
      expect(buildInternalKey(1, "Alice")).toBe("1-Alice");
      expect(buildInternalKey(5, "Bob")).toBe("5-Bob");
    });

    it("should handle undefined turn", () => {
      expect(buildInternalKey(undefined, "Alice")).toBe("0-Alice");
    });

    it("should normalize speaker name", () => {
      expect(buildInternalKey(1, "John Doe")).toBe("1-John_Doe");
    });
  });

  describe("buildExpandedStorageKey", () => {
    it("should return meeting ID if provided", () => {
      expect(buildExpandedStorageKey("meeting-123")).toBe("meeting-123");
    });

    it("should return __global__ for null/undefined", () => {
      expect(buildExpandedStorageKey(null)).toBe("__global__");
      expect(buildExpandedStorageKey(undefined)).toBe("__global__");
    });
  });

  describe("isMessageEntry", () => {
    it("should return true for message entries", () => {
      const message: MessageOut = {
        kind: "message",
        name: "Alice",
        content: "Hello",
        turn: 1,
      };
      expect(isMessageEntry(message)).toBe(true);
    });

    it("should return false for phase entries", () => {
      const phase: PhaseLogEntry = {
        kind: "phase",
        title: "Discussion",
      };
      expect(isMessageEntry(phase)).toBe(false);
    });
  });

  describe("findLastMessageEntry", () => {
    it("should find the last message entry", () => {
      const entries: LogEntry[] = [
        { kind: "message", name: "Alice", content: "First", turn: 1 },
        { kind: "phase", title: "Phase 1" },
        { kind: "message", name: "Bob", content: "Second", turn: 2 },
      ];
      const result = findLastMessageEntry(entries);
      expect(result?.name).toBe("Bob");
      expect(result?.turn).toBe(2);
    });

    it("should return null for empty array", () => {
      expect(findLastMessageEntry([])).toBeNull();
    });

    it("should return null if no message entries exist", () => {
      const entries: LogEntry[] = [
        { kind: "phase", title: "Phase 1" },
        { kind: "phase", title: "Phase 2" },
      ];
      expect(findLastMessageEntry(entries)).toBeNull();
    });
  });

  describe("countMessagesWithTurn", () => {
    it("should count messages with specific turn", () => {
      const entries: LogEntry[] = [
        { kind: "message", name: "Alice", content: "A1", turn: 1 },
        { kind: "message", name: "Bob", content: "B1", turn: 1 },
        { kind: "phase", title: "Phase" },
        { kind: "message", name: "Alice", content: "A2", turn: 2 },
        { kind: "message", name: "Charlie", content: "C1", turn: 1 },
      ];
      expect(countMessagesWithTurn(entries, 1)).toBe(3);
      expect(countMessagesWithTurn(entries, 2)).toBe(1);
      expect(countMessagesWithTurn(entries, 3)).toBe(0);
    });

    it("should return 0 for empty array", () => {
      expect(countMessagesWithTurn([], 1)).toBe(0);
    });
  });
});
