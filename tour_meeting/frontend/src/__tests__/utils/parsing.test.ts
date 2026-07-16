import { describe, it, expect } from "vitest";
import {
  parsePositiveInt,
  parseNumeric,
  toNumber,
  clamp01,
  isActiveStatus,
} from "../../utils/parsing";

describe("parsing utilities", () => {
  describe("parsePositiveInt", () => {
    it("should parse valid positive integers", () => {
      expect(parsePositiveInt("42")).toBe(42);
      expect(parsePositiveInt("1")).toBe(1);
      expect(parsePositiveInt("100")).toBe(100);
    });

    it("should handle strings with whitespace", () => {
      expect(parsePositiveInt("  42  ")).toBe(42);
      expect(parsePositiveInt("\t10\n")).toBe(10);
    });

    it("should floor decimal values", () => {
      expect(parsePositiveInt("3.7")).toBe(3);
      expect(parsePositiveInt("9.99")).toBe(9);
    });

    it("should return null for empty strings", () => {
      expect(parsePositiveInt("")).toBeNull();
      expect(parsePositiveInt("   ")).toBeNull();
    });

    it("should return null for zero and negative numbers", () => {
      expect(parsePositiveInt("0")).toBeNull();
      expect(parsePositiveInt("-5")).toBeNull();
      expect(parsePositiveInt("-1")).toBeNull();
    });

    it("should return null for invalid inputs", () => {
      expect(parsePositiveInt("abc")).toBeNull();
      expect(parsePositiveInt("NaN")).toBeNull();
      expect(parsePositiveInt("Infinity")).toBeNull();
    });
  });

  describe("parseNumeric", () => {
    it("should parse valid numbers", () => {
      expect(parseNumeric("42")).toBe(42);
      expect(parseNumeric("-5")).toBe(-5);
      expect(parseNumeric("3.14")).toBe(3.14);
      expect(parseNumeric("0")).toBe(0);
    });

    it("should handle strings with whitespace", () => {
      expect(parseNumeric("  42  ")).toBe(42);
      expect(parseNumeric("\t-3.5\n")).toBe(-3.5);
    });

    it("should return null for empty strings", () => {
      expect(parseNumeric("")).toBeNull();
      expect(parseNumeric("   ")).toBeNull();
    });

    it("should return null for invalid inputs", () => {
      expect(parseNumeric("abc")).toBeNull();
      expect(parseNumeric("NaN")).toBeNull();
      expect(parseNumeric("Infinity")).toBeNull();
    });
  });

  describe("toNumber", () => {
    it("should convert valid numbers", () => {
      expect(toNumber(42, 0)).toBe(42);
      expect(toNumber("3.14", 0)).toBe(3.14);
      expect(toNumber(-5, 0)).toBe(-5);
    });

    it("should return fallback for invalid inputs", () => {
      expect(toNumber("abc", 10)).toBe(10);
      expect(toNumber(undefined, 7)).toBe(7);
      expect(toNumber(NaN, 3)).toBe(3);
    });

    it("should convert null to 0 (Number(null) is 0)", () => {
      // Note: Number(null) === 0, which is finite, so fallback is not used
      expect(toNumber(null, 5)).toBe(0);
    });

    it("should handle edge cases", () => {
      expect(toNumber(Infinity, 0)).toBe(0);
      expect(toNumber(-Infinity, 0)).toBe(0);
    });
  });

  describe("clamp01", () => {
    it("should clamp values between 0 and 1", () => {
      expect(clamp01(0.5)).toBe(0.5);
      expect(clamp01(0)).toBe(0);
      expect(clamp01(1)).toBe(1);
    });

    it("should clamp values above 1", () => {
      expect(clamp01(1.5)).toBe(1);
      expect(clamp01(100)).toBe(1);
    });

    it("should clamp values below 0", () => {
      expect(clamp01(-0.5)).toBe(0);
      expect(clamp01(-100)).toBe(0);
    });
  });

  describe("isActiveStatus", () => {
    it("should return true for running status", () => {
      expect(isActiveStatus("running")).toBe(true);
    });

    it("should return true for stopping status", () => {
      expect(isActiveStatus("stopping")).toBe(true);
    });

    it("should return false for other statuses", () => {
      expect(isActiveStatus("idle")).toBe(false);
      expect(isActiveStatus("stopped")).toBe(false);
      expect(isActiveStatus("error")).toBe(false);
      expect(isActiveStatus("")).toBe(false);
    });
  });
});
