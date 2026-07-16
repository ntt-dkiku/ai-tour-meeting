import { describe, it, expect } from "vitest";
import {
  formatElapsed,
  getDisplayContent,
  formatStayWindow,
  parseDurationToMinutes,
  parseClockToMinutes,
} from "../../utils/formatting";
import type { MessageOut } from "../../types";

describe("formatStayWindow", () => {
  it("builds a HH:MM - HH:MM window from arrival + minutes", () => {
    expect(formatStayWindow("09:00", "120 min")).toBe("09:00 - 11:00");
    expect(formatStayWindow("08:30", "40 min")).toBe("08:30 - 09:10");
  });

  it("handles hour-based durations", () => {
    expect(formatStayWindow("09:00", "1 hour")).toBe("09:00 - 10:00");
    expect(formatStayWindow("09:00", "1.5 hours")).toBe("09:00 - 10:30");
  });

  it("returns null when inputs are missing, unparseable, or zero", () => {
    expect(formatStayWindow(undefined, "60 min")).toBeNull();
    expect(formatStayWindow("09:00", undefined)).toBeNull();
    expect(formatStayWindow("morning", "60 min")).toBeNull();
    expect(formatStayWindow("09:00", "0 hours")).toBeNull();
  });

  it("parses durations and clocks", () => {
    expect(parseDurationToMinutes("75 min")).toBe(75);
    expect(parseDurationToMinutes("2 hours")).toBe(120);
    expect(parseDurationToMinutes("free")).toBeNull();
    expect(parseClockToMinutes("08:30")).toBe(510);
    expect(parseClockToMinutes("bad")).toBeNull();
  });
});

describe("formatElapsed", () => {
  it("should format seconds only (under 1 minute)", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(5)).toBe("0:05");
    expect(formatElapsed(30)).toBe("0:30");
    expect(formatElapsed(59)).toBe("0:59");
  });

  it("should format minutes and seconds (under 1 hour)", () => {
    expect(formatElapsed(60)).toBe("1:00");
    expect(formatElapsed(65)).toBe("1:05");
    expect(formatElapsed(90)).toBe("1:30");
    expect(formatElapsed(599)).toBe("9:59");
    expect(formatElapsed(3599)).toBe("59:59");
  });

  it("should format hours, minutes, and seconds", () => {
    expect(formatElapsed(3600)).toBe("1:00:00");
    expect(formatElapsed(3661)).toBe("1:01:01");
    expect(formatElapsed(7200)).toBe("2:00:00");
    expect(formatElapsed(36000)).toBe("10:00:00");
  });

  it("should pad minutes and seconds with leading zeros", () => {
    expect(formatElapsed(61)).toBe("1:01");
    expect(formatElapsed(3605)).toBe("1:00:05");
    expect(formatElapsed(3665)).toBe("1:01:05");
  });
});

describe("getDisplayContent", () => {
  const createMessage = (content: string, routePlan?: object): MessageOut => ({
    kind: "message",
    name: "TestSpeaker",
    content,
    turn: 1,
    routePlan: routePlan as MessageOut["routePlan"],
  });

  it("should return full content when no routePlan exists", () => {
    const entry = createMessage("Hello, this is a test message.");
    expect(getDisplayContent(entry)).toBe("Hello, this is a test message.");
  });

  it("should return full content when routePlan exists but no markers found", () => {
    const entry = createMessage("Hello, this is a test message.", { route: ["A", "B"] });
    expect(getDisplayContent(entry)).toBe("Hello, this is a test message.");
  });

  it("should strip content after 'Proposed route:' marker", () => {
    const entry = createMessage(
      "Here is my suggestion.\n\nProposed route:\n- Location A\n- Location B",
      { route: ["A", "B"] }
    );
    expect(getDisplayContent(entry)).toBe("Here is my suggestion.\n\nProposed route:\n- Location A\n- Location B");
  });

  it("should strip content after 'Itinerary:' marker", () => {
    const entry = createMessage(
      "Let me share the plan.\n\nItinerary:\n9:00 - Start\n10:00 - End",
      { route: ["Start", "End"] }
    );
    expect(getDisplayContent(entry)).toBe("Let me share the plan.\n\nItinerary:\n9:00 - Start\n10:00 - End");
  });

  it("should use earliest marker when both exist", () => {
    const entry = createMessage(
      "My thoughts.\n\nProposed route:\nRoute data\n\nItinerary:\nItinerary data",
      { route: ["A"] }
    );
    expect(getDisplayContent(entry)).toBe("My thoughts.\n\nProposed route:\nRoute data\n\nItinerary:\nItinerary data");
  });

  it("should use earliest marker when Itinerary comes first", () => {
    const entry = createMessage(
      "Introduction.\n\nItinerary:\nSchedule\n\nProposed route:\nRoute",
      { route: ["A"] }
    );
    expect(getDisplayContent(entry)).toBe("Introduction.\n\nItinerary:\nSchedule\n\nProposed route:\nRoute");
  });

  it("should handle empty content", () => {
    const entry = createMessage("", { route: ["A"] });
    expect(getDisplayContent(entry)).toBe("");
  });

  it("should handle content with only markers", () => {
    const entry = createMessage("\n\nProposed route:\nA to B", { route: ["A", "B"] });
    expect(getDisplayContent(entry)).toBe("\n\nProposed route:\nA to B");
  });

  it("should trim trailing whitespace from result", () => {
    const entry = createMessage(
      "Some text   \n\nProposed route:\nData",
      { route: ["A"] }
    );
    expect(getDisplayContent(entry)).toBe("Some text   \n\nProposed route:\nData");
  });
});
