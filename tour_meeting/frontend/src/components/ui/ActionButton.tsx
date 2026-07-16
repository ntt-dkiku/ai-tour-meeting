import React from "react";

interface ActionButtonProps {
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  children: React.ReactNode;
  className?: string;
}

const ActionButton: React.FC<ActionButtonProps> = ({
  onClick,
  disabled = false,
  title,
  ariaLabel,
  children,
  className = "",
}) => {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-2 h-10 px-3 rounded-lg transition-colors border ${
        disabled
          ? "opacity-50 cursor-not-allowed border-outline bg-surface-tertiary text-on-surface-tertiary"
          : "border-outline-secondary bg-surface-secondary text-on-surface-secondary hover:bg-surface-tertiary cursor-pointer"
      } ${className}`}
      title={title}
      aria-label={ariaLabel || title}
    >
      {children}
    </button>
  );
};

export default ActionButton;
