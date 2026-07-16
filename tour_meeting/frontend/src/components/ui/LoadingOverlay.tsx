import React from "react";
import { useTheme } from "../../context/ThemeContext";

interface LoadingOverlayProps {
  title: string;
  subtitle?: string;
}

const LoadingOverlay: React.FC<LoadingOverlayProps> = ({
  title,
  subtitle
}) => {
  const { theme } = useTheme();
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-4 z-20"
      style={{
        backgroundColor: theme === "dark" ? 'rgba(17, 24, 39, 0.95)' : 'rgba(255, 255, 255, 0.95)',
      }}
    >
      <div className="flex flex-col items-center gap-3">
        <div className="relative w-12 h-12">
          <div
            className="absolute inset-0 rounded-full border-4 border-outline border-t-accent"
          />
          <div
            className="absolute inset-0 rounded-full border-4 border-transparent border-t-accent animate-spin"
            style={{ animationDuration: '0.8s' }}
          />
        </div>
        <div className="text-center">
          <p className="text-lg font-semibold text-on-surface">{title}</p>
          {subtitle && (
            <p className="text-sm text-on-surface-tertiary mt-1">{subtitle}</p>
          )}
        </div>
      </div>
    </div>
  );
};

export default LoadingOverlay;
