import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLocalStorage } from "../../hooks/useLocalStorage";

describe("useLocalStorage", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("should return initial value when localStorage is empty", () => {
    const { result } = renderHook(() =>
      useLocalStorage("test-key", { count: 0 })
    );
    expect(result.current[0]).toEqual({ count: 0 });
  });

  it("should load existing value from localStorage", () => {
    localStorage.setItem("test-key", JSON.stringify({ count: 5 }));

    const { result } = renderHook(() =>
      useLocalStorage("test-key", { count: 0 })
    );
    expect(result.current[0]).toEqual({ count: 5 });
  });

  it("should update localStorage when value changes", async () => {
    const { result } = renderHook(() =>
      useLocalStorage("test-key", { count: 0 })
    );

    act(() => {
      result.current[1]({ count: 10 });
    });

    // Wait for effect to run
    await vi.waitFor(() => {
      expect(localStorage.setItem).toHaveBeenCalledWith(
        "test-key",
        JSON.stringify({ count: 10 })
      );
    });
  });

  it("should handle functional updates", () => {
    const { result } = renderHook(() =>
      useLocalStorage("test-key", { count: 5 })
    );

    act(() => {
      result.current[1]((prev) => ({ count: prev.count + 1 }));
    });

    expect(result.current[0]).toEqual({ count: 6 });
  });

  it("should handle different data types", () => {
    // String
    const { result: stringResult } = renderHook(() =>
      useLocalStorage("string-key", "hello")
    );
    expect(stringResult.current[0]).toBe("hello");

    // Array
    const { result: arrayResult } = renderHook(() =>
      useLocalStorage("array-key", [1, 2, 3])
    );
    expect(arrayResult.current[0]).toEqual([1, 2, 3]);

    // Number
    const { result: numberResult } = renderHook(() =>
      useLocalStorage("number-key", 42)
    );
    expect(numberResult.current[0]).toBe(42);
  });

  it("should handle invalid JSON in localStorage gracefully", () => {
    localStorage.setItem("test-key", "invalid-json{");

    const { result } = renderHook(() =>
      useLocalStorage("test-key", { default: true })
    );
    expect(result.current[0]).toEqual({ default: true });
  });

  it("should use different keys independently", () => {
    localStorage.setItem("key-a", JSON.stringify({ value: "A" }));
    localStorage.setItem("key-b", JSON.stringify({ value: "B" }));

    const { result: resultA } = renderHook(() =>
      useLocalStorage("key-a", { value: "default" })
    );
    const { result: resultB } = renderHook(() =>
      useLocalStorage("key-b", { value: "default" })
    );

    expect(resultA.current[0]).toEqual({ value: "A" });
    expect(resultB.current[0]).toEqual({ value: "B" });
  });

  it("should not save on initial render", () => {
    renderHook(() => useLocalStorage("test-key", { initial: true }));

    // localStorage.setItem should not be called on initial render
    // because we just loaded or used initial value
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });
});
