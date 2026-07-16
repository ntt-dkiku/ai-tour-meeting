import React, { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo } from "react";
import { DEFAULT_GLOBAL_GOAL } from "../constants";

// Types
export interface MeetingSettings {
  globalGoals: string;
  maxTurns: number;
  timeLimit: string;
  travelDate: string;
  timeWindowStart: string;
  timeWindowEnd: string;
  budget: string;
  turnRule: string;
  draftVotingRule: string;
  volunteerMode: boolean;
  balancedTurns: boolean;
  voteTurnRule: string;
  voteSettingsLinked: boolean;
  /** Participant id (or "__YOU__") who decides under the single_decider rule; "" = unset. */
  singleDecider: string;
}

// Cache type - matches the structure used in App.tsx for per-meeting storage
export interface MeetingSettingsCache {
  maxTurns: number;
  timeLimit: string;
  travelDate: string;
  timeWindowStart: string;
  timeWindowEnd: string;
  budget: string;
  turnRule: string;
  votingRule: string; // Maps to draftVotingRule in MeetingSettings
  volunteerMode: boolean;
  balancedTurns: boolean;
  voteTurnRule: string;
  voteSettingsLinked: boolean;
  singleDecider?: string;
  globalGoals?: string; // Optional, stored separately in some places
}

const DEFAULT_SETTINGS: MeetingSettings = {
  globalGoals: DEFAULT_GLOBAL_GOAL,
  maxTurns: 100,
  timeLimit: "",
  travelDate: "",
  timeWindowStart: "",
  timeWindowEnd: "",
  budget: "",
  turnRule: "round_robin",
  draftVotingRule: "majority",
  volunteerMode: false,
  balancedTurns: true,
  voteTurnRule: "round_robin",
  voteSettingsLinked: true,
  singleDecider: "",
};

const DEFAULT_CACHE: MeetingSettingsCache = {
  maxTurns: 100,
  timeLimit: "",
  travelDate: "",
  timeWindowStart: "",
  timeWindowEnd: "",
  budget: "",
  turnRule: "round_robin",
  votingRule: "majority",
  volunteerMode: false,
  balancedTurns: true,
  voteTurnRule: "round_robin",
  voteSettingsLinked: true,
  singleDecider: "",
};

interface MeetingContextValue {
  // Current meeting
  currentMeetingId: string | null;
  setCurrentMeetingId: (id: string | null) => void;

  // Settings state (current UI values)
  settings: MeetingSettings;
  updateSetting: <K extends keyof MeetingSettings>(key: K, value: MeetingSettings[K]) => void;
  updateSettings: (updates: Partial<MeetingSettings>) => void;
  resetSettings: () => void;

  // Settings cache (per-meeting storage)
  getSettingsCache: (meetingId: string) => MeetingSettingsCache;
  updateSettingsCache: (meetingId: string, updates: Partial<MeetingSettingsCache>) => void;
  deleteSettingsCache: (meetingId: string) => void;
  clearAllSettingsCache: () => void;

  // Sync helpers
  loadSettingsFromCache: (meetingId: string) => void;
  saveSettingsToCache: (meetingId: string) => void;

  // Direct access to cache ref for legacy code
  settingsCacheRef: React.MutableRefObject<Record<string, MeetingSettingsCache>>;
}

const MeetingContext = createContext<MeetingContextValue | null>(null);

export function MeetingProvider({ children }: { children: React.ReactNode }) {
  const [currentMeetingId, setCurrentMeetingId] = useState<string | null>(null);

  // Settings state (current UI values)
  const [settings, setSettings] = useState<MeetingSettings>(DEFAULT_SETTINGS);

  // Settings cache (per-meeting storage)
  const settingsCacheRef = useRef<Record<string, MeetingSettingsCache>>({});

  // Update a single setting
  const updateSetting = useCallback(<K extends keyof MeetingSettings>(
    key: K,
    value: MeetingSettings[K]
  ) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  }, []);

  // Update multiple settings at once
  const updateSettings = useCallback((updates: Partial<MeetingSettings>) => {
    setSettings(prev => ({ ...prev, ...updates }));
  }, []);

  // Reset settings to defaults
  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_SETTINGS);
  }, []);

  // Get settings cache for a meeting (creates if not exists)
  const getSettingsCache = useCallback((meetingId: string): MeetingSettingsCache => {
    if (!settingsCacheRef.current[meetingId]) {
      settingsCacheRef.current[meetingId] = { ...DEFAULT_CACHE };
    }
    return settingsCacheRef.current[meetingId];
  }, []);

  // Update settings cache for a meeting
  const updateSettingsCache = useCallback((
    meetingId: string,
    updates: Partial<MeetingSettingsCache>
  ) => {
    const existing = settingsCacheRef.current[meetingId] || { ...DEFAULT_CACHE };
    settingsCacheRef.current[meetingId] = { ...existing, ...updates };
  }, []);

  // Delete settings cache for a meeting
  const deleteSettingsCache = useCallback((meetingId: string) => {
    delete settingsCacheRef.current[meetingId];
  }, []);

  // Clear all settings cache
  const clearAllSettingsCache = useCallback(() => {
    settingsCacheRef.current = {};
  }, []);

  // Load settings from cache into current state
  const loadSettingsFromCache = useCallback((meetingId: string) => {
    const cached = getSettingsCache(meetingId);
    setSettings({
      globalGoals: cached.globalGoals ?? DEFAULT_SETTINGS.globalGoals,
      maxTurns: cached.maxTurns ?? DEFAULT_SETTINGS.maxTurns,
      timeLimit: cached.timeLimit ?? DEFAULT_SETTINGS.timeLimit,
      travelDate: cached.travelDate ?? DEFAULT_SETTINGS.travelDate,
      timeWindowStart: cached.timeWindowStart ?? DEFAULT_SETTINGS.timeWindowStart,
      timeWindowEnd: cached.timeWindowEnd ?? DEFAULT_SETTINGS.timeWindowEnd,
      budget: cached.budget ?? DEFAULT_SETTINGS.budget,
      turnRule: cached.turnRule ?? DEFAULT_SETTINGS.turnRule,
      draftVotingRule: cached.votingRule ?? DEFAULT_SETTINGS.draftVotingRule,
      volunteerMode: cached.volunteerMode ?? DEFAULT_SETTINGS.volunteerMode,
      balancedTurns: cached.balancedTurns ?? DEFAULT_SETTINGS.balancedTurns,
      voteTurnRule: cached.voteTurnRule ?? DEFAULT_SETTINGS.voteTurnRule,
      voteSettingsLinked: cached.voteSettingsLinked ?? DEFAULT_SETTINGS.voteSettingsLinked,
      singleDecider: cached.singleDecider ?? DEFAULT_SETTINGS.singleDecider,
    });
  }, [getSettingsCache]);

  // Save current settings to cache
  const saveSettingsToCache = useCallback((meetingId: string) => {
    settingsCacheRef.current[meetingId] = {
      maxTurns: settings.maxTurns,
      timeLimit: settings.timeLimit,
      travelDate: settings.travelDate,
      timeWindowStart: settings.timeWindowStart,
      timeWindowEnd: settings.timeWindowEnd,
      budget: settings.budget,
      turnRule: settings.turnRule,
      votingRule: settings.draftVotingRule,
      volunteerMode: settings.volunteerMode,
      balancedTurns: settings.balancedTurns,
      voteTurnRule: settings.voteTurnRule,
      voteSettingsLinked: settings.voteSettingsLinked,
      singleDecider: settings.singleDecider,
      globalGoals: settings.globalGoals,
    };
  }, [settings]);

  const value = useMemo<MeetingContextValue>(() => ({
    currentMeetingId,
    setCurrentMeetingId,
    settings,
    updateSetting,
    updateSettings,
    resetSettings,
    getSettingsCache,
    updateSettingsCache,
    deleteSettingsCache,
    clearAllSettingsCache,
    loadSettingsFromCache,
    saveSettingsToCache,
    settingsCacheRef,
  }), [
    currentMeetingId,
    settings,
    updateSetting,
    updateSettings,
    resetSettings,
    getSettingsCache,
    updateSettingsCache,
    deleteSettingsCache,
    clearAllSettingsCache,
    loadSettingsFromCache,
    saveSettingsToCache,
  ]);

  return (
    <MeetingContext.Provider value={value}>
      {children}
    </MeetingContext.Provider>
  );
}

export function useMeetingContext() {
  const context = useContext(MeetingContext);
  if (!context) {
    throw new Error("useMeetingContext must be used within a MeetingProvider");
  }
  return context;
}

// Convenience hooks for specific parts of the context
export function useMeetingSettings() {
  const { settings, updateSetting, updateSettings, resetSettings } = useMeetingContext();
  return { ...settings, updateSetting, updateSettings, resetSettings };
}

export function useCurrentMeeting() {
  const { currentMeetingId, setCurrentMeetingId } = useMeetingContext();
  return { currentMeetingId, setCurrentMeetingId };
}

export function useSettingsCache() {
  const {
    getSettingsCache,
    updateSettingsCache,
    deleteSettingsCache,
    clearAllSettingsCache,
    loadSettingsFromCache,
    saveSettingsToCache,
    settingsCacheRef,
  } = useMeetingContext();
  return {
    getSettingsCache,
    updateSettingsCache,
    deleteSettingsCache,
    clearAllSettingsCache,
    loadSettingsFromCache,
    saveSettingsToCache,
    settingsCacheRef,
  };
}
