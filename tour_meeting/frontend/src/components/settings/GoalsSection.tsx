import React from "react";

interface GoalsSectionProps {
  globalGoals: string;
  setGlobalGoals: (goals: string) => void;
  settingsLocked: boolean;
}

const GoalsSection: React.FC<GoalsSectionProps> = ({
  globalGoals,
  setGlobalGoals,
  settingsLocked,
}) => {
  return (
    <div className="mb-6">
      <h3 className="text-sm font-semibold text-on-surface-secondary mb-3">Global goal</h3>
      <textarea
        className={`w-full rounded-lg border p-3 text-on-surface focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent resize-none ${
          settingsLocked
            ? "bg-surface-tertiary text-on-surface-tertiary cursor-not-allowed border-outline focus:ring-0"
            : "bg-surface border-outline"
        }`}
        rows={4}
        value={globalGoals}
        onChange={(e) => setGlobalGoals(e.target.value)}
        placeholder="Describe the meeting goal..."
        disabled={settingsLocked}
        readOnly={settingsLocked}
      />
    </div>
  );
};

export default GoalsSection;
