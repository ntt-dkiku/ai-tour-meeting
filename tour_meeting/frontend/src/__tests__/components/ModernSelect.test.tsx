import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ModernSelect, { selectClass, numericInputClass } from "../../components/ui/ModernSelect";

describe("selectClass", () => {
  it("should return correct classes for enabled state", () => {
    const classes = selectClass(false);
    expect(classes).toContain("hover:border-accent");
    expect(classes).toContain("focus:border-accent");
    expect(classes).toContain("bg-surface");
    expect(classes).not.toContain("cursor-not-allowed");
  });

  it("should return correct classes for disabled state", () => {
    const classes = selectClass(true);
    expect(classes).toContain("bg-surface-tertiary");
    expect(classes).toContain("cursor-not-allowed");
    expect(classes).toContain("text-on-surface-tertiary");
    expect(classes).not.toContain("hover:border-accent");
  });
});

describe("numericInputClass", () => {
  it("should return correct classes for enabled state", () => {
    const classes = numericInputClass(false);
    expect(classes).toContain("hover:border-accent");
    expect(classes).toContain("focus:border-accent");
    expect(classes).toContain("bg-surface");
    expect(classes).not.toContain("cursor-not-allowed");
  });

  it("should return correct classes for disabled state", () => {
    const classes = numericInputClass(true);
    expect(classes).toContain("bg-surface-tertiary");
    expect(classes).toContain("cursor-not-allowed");
    expect(classes).toContain("text-on-surface-tertiary");
    expect(classes).not.toContain("hover:border-accent");
  });
});

describe("ModernSelect", () => {
  it("should render select with children", () => {
    render(
      <ModernSelect data-testid="select">
        <option value="1">Option 1</option>
        <option value="2">Option 2</option>
      </ModernSelect>
    );

    const select = screen.getByTestId("select");
    expect(select).toBeInTheDocument();
    expect(select.tagName).toBe("SELECT");
  });

  it("should render with disabled state", () => {
    render(
      <ModernSelect data-testid="select" disabled>
        <option value="1">Option 1</option>
      </ModernSelect>
    );

    const select = screen.getByTestId("select");
    expect(select).toBeDisabled();
  });

  it("should pass through additional props", () => {
    const handleChange = vi.fn();
    render(
      <ModernSelect data-testid="select" onChange={handleChange} value="2">
        <option value="1">Option 1</option>
        <option value="2">Option 2</option>
      </ModernSelect>
    );

    const select = screen.getByTestId("select");
    expect(select).toHaveValue("2");

    fireEvent.change(select, { target: { value: "1" } });
    expect(handleChange).toHaveBeenCalled();
  });

  it("should render chevron icon", () => {
    const { container } = render(
      <ModernSelect>
        <option value="1">Option 1</option>
      </ModernSelect>
    );

    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("should have different icon color based on disabled state", () => {
    const { container, rerender } = render(
      <ModernSelect disabled={false}>
        <option value="1">Option 1</option>
      </ModernSelect>
    );

    let svg = container.querySelector("svg");
    expect(svg?.classList.contains("text-accent")).toBe(true);

    rerender(
      <ModernSelect disabled={true}>
        <option value="1">Option 1</option>
      </ModernSelect>
    );

    svg = container.querySelector("svg");
    expect(svg?.classList.contains("text-on-surface-tertiary")).toBe(true);
  });
});
