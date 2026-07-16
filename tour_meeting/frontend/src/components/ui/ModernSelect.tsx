import React from "react";
import { ChevronDown } from "lucide-react";

export const selectClass = (disabled: boolean): string =>
  [
    "w-full appearance-none rounded-xl border px-4 py-3 pr-10 text-left text-on-surface shadow-sm focus:outline-none transition-colors duration-150",
    disabled
      ? "bg-surface-tertiary text-on-surface-tertiary border-outline cursor-not-allowed focus:ring-0 focus:border-outline"
      : "bg-surface border-outline hover:border-accent focus:border-accent focus:ring-2 focus:ring-accent",
  ].join(" ");

export const numericInputClass = (disabled: boolean): string =>
  [
    "w-full rounded-xl border px-4 py-3 text-on-surface shadow-sm focus:outline-none transition-colors duration-150",
    disabled
      ? "bg-surface-tertiary text-on-surface-tertiary border-outline cursor-not-allowed focus:ring-0 focus:border-outline"
      : "bg-surface border-outline hover:border-accent focus:border-accent focus:ring-2 focus:ring-accent",
  ].join(" ");

type ModernSelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

const ModernSelect: React.FC<ModernSelectProps> = ({ children, disabled, className: _className, ...props }) => (
  <div className="relative">
    <select {...props} disabled={disabled} className={selectClass(Boolean(disabled))}>
      {children}
    </select>
    <ChevronDown
      className={`pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 ${
        disabled ? "text-on-surface-tertiary" : "text-accent"
      }`}
    />
  </div>
);

export default ModernSelect;
