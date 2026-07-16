import React from "react";
import { Send } from "lucide-react";

// ── Auto-growing chat composer with an embedded send icon ──
export interface ChatComposerProps {
  value: string;
  disabled: boolean;
  placeholder: string;
  hideSend?: boolean;
  /** Icon inside the send button (defaults to the paper-plane Send). */
  sendIcon?: React.ReactNode;
  /** Override the send-enabled state (defaults to "there is non-empty text"). */
  sendEnabled?: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** Optional controls pinned to the composer's bottom-left (e.g. the speaking
   *  action tabs). When present the composer switches to a taller layout with
   *  a footer row so these controls stay put while the header above changes. */
  footerLeft?: React.ReactNode;
  /** Optional control pinned to the composer's bottom-right, immediately left
   *  of the send button (e.g. a model picker). Also switches to the taller
   *  layout when present. */
  footerRight?: React.ReactNode;
  /** Force the taller stacked layout even without footerLeft (e.g. answering
   *  an ask), so its height matches the vote / own-turn composer. */
  tall?: boolean;
}

const ChatComposer: React.FC<ChatComposerProps> = ({
  value,
  disabled,
  placeholder,
  hideSend = false,
  sendIcon,
  sendEnabled,
  onChange,
  onSubmit,
  footerLeft,
  footerRight,
  tall = false,
}) => {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const hasFooterLeft = footerLeft !== undefined && footerLeft !== null;
  const useTall = tall || hasFooterLeft || (footerRight !== undefined && footerRight !== null);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  React.useEffect(() => {
    if (!disabled) ref.current?.focus();
  }, [disabled]);

  const canSend =
    sendEnabled !== undefined
      ? sendEnabled && !disabled && !hideSend
      : !disabled && !hideSend && value.trim().length > 0;
  const isVote = sendIcon !== undefined && sendIcon !== null;
  const sendLabel = isVote ? "Submit vote" : "Send";

  const renderSend = (extra: string) =>
    hideSend ? null : (
      <button
        type="button"
        onClick={onSubmit}
        disabled={!canSend}
        aria-label={sendLabel}
        title={sendLabel}
        className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border transition-colors ${extra} ${
          canSend
            ? "border-accent bg-accent text-white hover:bg-accent-hover"
            : "border-outline bg-transparent text-on-surface-tertiary cursor-not-allowed"
        }`}
      >
        {sendIcon ?? <Send className="w-4 h-4" />}
      </button>
    );

  const textarea = (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey && !hideSend) {
          e.preventDefault();
          onSubmit();
        }
      }}
      placeholder={placeholder}
      className={
        useTall
          ? "w-full resize-none bg-transparent px-3 pt-3 pb-1 min-h-[3.5rem] text-on-surface leading-relaxed focus:outline-none disabled:opacity-60 disabled:cursor-not-allowed"
          : `min-w-0 flex-1 resize-none bg-transparent py-3 pl-3 ${
              hideSend ? "pr-3" : "pr-2"
            } text-on-surface leading-relaxed focus:outline-none disabled:opacity-60 disabled:cursor-not-allowed`
      }
    />
  );

  // Taller stacked layout: textarea on top, then a footer row with any
  // controls bottom-left and the send button bottom-right. Used for the
  // speaking/voting turns (with tabs) and when answering an ask (no tabs), so
  // the composer height is consistent across them.
  if (useTall) {
    return (
      <div className="relative flex flex-col rounded-lg border border-outline bg-surface transition-colors hover:border-accent focus-within:ring-2 focus-within:ring-accent">
        {textarea}
        <div className="flex items-end justify-between gap-2 px-2 pb-2">
          <div className="min-w-0 overflow-x-auto">{footerLeft}</div>
          <div className="flex items-end gap-2">
            {footerRight}
            {renderSend("")}
          </div>
        </div>
      </div>
    );
  }

  // Compact single-row layout: placeholder line and send button share the
  // vertical centre (border/bg/focus-ring on the container; textarea is
  // transparent and borderless).
  return (
    <div className="relative flex items-center rounded-lg border border-outline bg-surface transition-colors hover:border-accent focus-within:ring-2 focus-within:ring-accent">
      {textarea}
      {renderSend("mr-2")}
    </div>
  );
};

export default ChatComposer;
