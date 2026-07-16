import { useState, useEffect, useRef, useCallback } from "react";

interface UseLocalStorageOptions {
  debounceMs?: number;
}

/**
 * A hook that syncs state with localStorage.
 * - Loads initial value from localStorage on mount
 * - Auto-saves to localStorage when value changes (with optional debounce)
 * - SSR-safe
 */
export function useLocalStorage<T>(
  key: string,
  initialValue: T,
  options?: UseLocalStorageOptions
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const { debounceMs = 0 } = options ?? {};

  // Use lazy initialization to read from localStorage only once
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") {
      return initialValue;
    }
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          return parsed as T;
        }
      }
    } catch (e) {
      console.error(`[localStorage] Failed to load ${key}:`, e);
    }
    return initialValue;
  });

  // Track if this is the first render (to skip initial save)
  const isFirstRender = useRef(true);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Save to localStorage when value changes
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    // Skip saving on first render (we just loaded)
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    const save = () => {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        console.error(`[localStorage] Failed to save ${key}:`, e);
      }
    };

    if (debounceMs > 0) {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(save, debounceMs);
    } else {
      save();
    }

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [key, value, debounceMs]);

  return [value, setValue];
}
