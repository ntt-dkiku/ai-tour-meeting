import React from "react";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}

const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  subtitle,
  children,
}) => {
  return (
    <div className="relative bg-surface overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-b from-surface via-surface/75 to-transparent"
      />
      <div className="relative max-w-5xl mx-auto w-full px-6 py-4 flex items-center justify-between text-on-surface-secondary">
        <div className="flex items-center gap-3">
          <div>
            <h2 className="text-lg font-semibold text-on-surface-secondary">
              {title}
            </h2>
            {subtitle && (
              <p className="text-sm text-on-surface-tertiary">
                {subtitle}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {children}
        </div>
      </div>
    </div>
  );
};

export default PageHeader;
