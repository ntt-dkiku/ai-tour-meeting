import React from "react";
import ModernSelect from "../ui/ModernSelect";
import { TIME_OPTIONS } from "../../constants";

interface ConstraintsSectionProps {
  travelDate: string;
  setTravelDate: (date: string) => void;
  budget: string;
  setBudget: (budget: string) => void;
  timeWindowStart: string;
  setTimeWindowStart: (time: string) => void;
  timeWindowEnd: string;
  setTimeWindowEnd: (time: string) => void;
  maxTurns: number;
  setMaxTurns: (turns: number) => void;
  timeLimit: string;
  setTimeLimit: (limit: string) => void;
  settingsLocked: boolean;
}

const inputClass = (locked: boolean) =>
  `w-full rounded-lg border p-3 text-on-surface focus:outline-none focus:ring-2 focus:ring-accent ${
    locked
      ? "bg-surface-tertiary text-on-surface-tertiary cursor-not-allowed border-outline focus:ring-0"
      : "bg-surface border-outline"
  }`;

const ConstraintsSection: React.FC<ConstraintsSectionProps> = ({
  travelDate,
  setTravelDate,
  budget,
  setBudget,
  timeWindowStart,
  setTimeWindowStart,
  timeWindowEnd,
  setTimeWindowEnd,
  maxTurns,
  setMaxTurns,
  timeLimit,
  setTimeLimit,
  settingsLocked,
}) => {
  return (
    <div className="mb-6 p-4 bg-surface rounded-lg border border-outline">
      <h3 className="text-sm font-semibold text-on-surface-secondary mb-3">Constraints</h3>
      <div className="grid grid-cols-1 gap-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-on-surface-secondary mb-2">
              Travel date
            </label>
            <input
              type="date"
              className={inputClass(settingsLocked)}
              value={travelDate}
              onChange={(e) => setTravelDate(e.target.value)}
              disabled={settingsLocked}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-on-surface-secondary mb-2">
              Budget / Participant
            </label>
            <input
              type="text"
              className={inputClass(settingsLocked)}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder="e.g., $1000"
              disabled={settingsLocked}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-on-surface-secondary mb-2">
              Start time
            </label>
            <ModernSelect
              value={timeWindowStart}
              onChange={(e) => setTimeWindowStart(e.target.value)}
              disabled={settingsLocked}
            >
              <option value="">Select time</option>
              {TIME_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </ModernSelect>
          </div>
          <div>
            <label className="block text-sm font-medium text-on-surface-secondary mb-2">
              End time
            </label>
            <ModernSelect
              value={timeWindowEnd}
              onChange={(e) => setTimeWindowEnd(e.target.value)}
              disabled={settingsLocked}
            >
              <option value="">Select time</option>
              {TIME_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </ModernSelect>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-on-surface-secondary mb-2">
              Max turns
            </label>
            <input
              type="number"
              min={1}
              className={inputClass(settingsLocked)}
              value={maxTurns}
              onChange={(e) => setMaxTurns(parseInt(e.target.value || "1"))}
              disabled={settingsLocked}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-on-surface-secondary mb-2">
              Time limit (sec)
            </label>
            <input
              type="number"
              min={1}
              className={inputClass(settingsLocked)}
              value={timeLimit}
              onChange={(e) => setTimeLimit(e.target.value)}
              placeholder="Optional"
              disabled={settingsLocked}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConstraintsSection;
