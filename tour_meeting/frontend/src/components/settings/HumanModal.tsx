import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, ImagePlus, Palette, RotateCcw, Shuffle } from "lucide-react";
import CharacterAvatar from "../CharacterAvatar";
import type { Avatar, AvatarShape } from "../../types";
import {
  AVATAR_FACE_COUNT,
  AVATAR_PALETTES,
  AVATAR_SHAPES,
  avatarForName,
  fileToAvatarImage,
  isNameDerivedAvatar,
  randomAvatar,
} from "../../utils/avatar";

interface HumanModalProps {
  show: boolean;
  initialName: string;
  initialAvatar: Avatar | null;
  initialRole: string;
  /** Persist the profile; resolves to an error message or null on success. */
  onSave: (name: string, avatar: Avatar | null, role: string) => Promise<string | null>;
  onClose: () => void;
}

/** Modal for the human participant's display name and icon, opened from the
 *  "Add You" toggle (and by clicking the You card). */
const HumanModal: React.FC<HumanModalProps> = ({
  show,
  initialName,
  initialAvatar,
  initialRole,
  onSave,
  onClose,
}) => {
  const [name, setName] = useState(initialName);
  const [avatar, setAvatar] = useState<Avatar | null>(initialAvatar);
  const [role, setRole] = useState(initialRole || "attendee");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  // Whether the avatar was set explicitly (upload / shuffle / custom). While
  // false, the avatar tracks the name (same name → same character).
  const [avatarManual, setAvatarManual] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (show) {
      setName(initialName);
      setRole(initialRole || "attendee");
      const seeded = initialAvatar ?? avatarForName(initialName);
      setAvatar(seeded);
      setAvatarManual(!!initialAvatar && !isNameDerivedAvatar(initialAvatar, initialName));
      setError("");
      setSaving(false);
      setShowCustom(false);
    }
  }, [show]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!show) return null;

  const genBase =
    avatar && avatar.kind === "generated" ? avatar : avatarForName(name);
  const currentBody =
    genBase.color ?? AVATAR_PALETTES[genBase.palette]?.body ?? "#7FB2F0";
  const btnClass =
    "inline-flex items-center justify-center gap-1.5 rounded-md bg-surface-secondary px-3 text-xs text-on-surface-secondary transition-all duration-150 hover:text-on-surface hover:-translate-y-0.5 hover:shadow active:translate-y-0 active:shadow-none";
  const inputClass =
    "w-full rounded-md bg-surface-secondary border-0 px-3 py-2.5 text-sm text-on-surface placeholder:text-on-surface-tertiary/60 focus:outline-none focus:ring-2 focus:ring-zinc-400/40 transition-shadow";

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Please choose an image file.");
      return;
    }
    try {
      const src = await fileToAvatarImage(file);
      setAvatar({ kind: "image", src });
      setAvatarManual(true);
      setShowCustom(false);
      setError("");
    } catch {
      setError("Could not load that image.");
    }
  };

  const setGen = (partial: {
    shape?: AvatarShape;
    palette?: number;
    face?: number;
    color?: string;
  }) => {
    setAvatar({
      kind: "generated",
      shape: partial.shape ?? genBase.shape,
      palette: partial.palette ?? genBase.palette,
      face: partial.face ?? genBase.face,
      color:
        partial.palette !== undefined ? undefined : partial.color ?? genBase.color,
    });
    setAvatarManual(true);
  };

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Please enter a name.");
      return;
    }
    setSaving(true);
    const saveError = await onSave(trimmed, avatar, role);
    setSaving(false);
    if (saveError) {
      setError(saveError);
      return;
    }
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-surface w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl shadow-xl p-6 space-y-5">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-on-surface">You</h3>
          <button
            onClick={onClose}
            className="w-9 h-9 flex items-center justify-center rounded-lg border border-outline text-on-surface-tertiary hover:text-on-surface-secondary hover:border-outline-secondary transition-colors"
            aria-label="Close"
          >
            <span className="text-xl leading-none">&times;</span>
          </button>
        </div>

        <div className="space-y-3">
          <div className="space-y-2">
            <div className="flex items-start gap-4">
              <CharacterAvatar
                avatar={avatar}
                name={name}
                size={64}
                className="flex-shrink-0"
              />
              <div className="grid h-16 w-64 grid-cols-2 grid-rows-2 gap-2">
                <button type="button" onClick={() => fileInputRef.current?.click()} className={btnClass}>
                  <ImagePlus className="w-3.5 h-3.5" /> Upload
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAvatar(avatarForName(name));
                    setAvatarManual(false);
                    setShowCustom(false);
                  }}
                  className={btnClass}
                >
                  <RotateCcw className="w-3.5 h-3.5" /> Reset
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAvatar(randomAvatar());
                    setAvatarManual(true);
                    setShowCustom(false);
                  }}
                  className={btnClass}
                >
                  <Shuffle className="w-3.5 h-3.5" /> Shuffle
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!avatar || avatar.kind !== "generated") {
                      setAvatar(avatarForName(name));
                    }
                    setAvatarManual(true);
                    setShowCustom((v) => !v);
                  }}
                  className={`${btnClass} ${showCustom ? "ring-1 ring-zinc-400/50 text-on-surface" : ""}`}
                >
                  <Palette className="w-3.5 h-3.5" /> Custom
                </button>
              </div>
            </div>
            {showCustom && (
              <div className="space-y-2 rounded-md bg-surface-secondary/60 p-2">
                <div className="flex items-center gap-2">
                  <span className="w-11 text-xs text-on-surface-tertiary">Shape</span>
                  {AVATAR_SHAPES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setGen({ shape: s })}
                      className={`rounded-md p-0.5 transition-colors ${
                        genBase.shape === s
                          ? "ring-2 ring-zinc-500/60"
                          : "hover:bg-surface-tertiary"
                      }`}
                      aria-label={s}
                    >
                      <CharacterAvatar
                        avatar={{ kind: "generated", shape: s, palette: genBase.palette, face: genBase.face, color: genBase.color }}
                        size={26}
                      />
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-11 text-xs text-on-surface-tertiary">Color</span>
                  {AVATAR_PALETTES.map((p, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setGen({ palette: i })}
                      style={{ backgroundColor: p.body }}
                      className={`h-5 w-5 rounded-full transition-transform ${
                        !genBase.color && genBase.palette === i
                          ? "ring-2 ring-offset-1 ring-zinc-500/70 ring-offset-surface"
                          : "hover:scale-110"
                      }`}
                      aria-label={`color ${i + 1}`}
                    />
                  ))}
                  <label
                    title="Custom colour"
                    className={`relative h-5 w-5 cursor-pointer overflow-hidden rounded-full transition-transform ${
                      genBase.color
                        ? "ring-2 ring-offset-1 ring-zinc-500/70 ring-offset-surface"
                        : "hover:scale-110"
                    }`}
                    style={
                      genBase.color
                        ? { backgroundColor: genBase.color }
                        : {
                            background:
                              "conic-gradient(from 0deg, #f87171, #fbbf24, #34d399, #60a5fa, #a78bfa, #f472b6, #f87171)",
                          }
                    }
                  >
                    <input
                      type="color"
                      value={currentBody}
                      onChange={(e) => setGen({ color: e.target.value })}
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    />
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-11 text-xs text-on-surface-tertiary">Face</span>
                  {Array.from({ length: AVATAR_FACE_COUNT }).map((_, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setGen({ face: i })}
                      className={`rounded-md p-0.5 transition-colors ${
                        genBase.face === i
                          ? "ring-2 ring-zinc-500/60"
                          : "hover:bg-surface-tertiary"
                      }`}
                      aria-label={`face ${i + 1}`}
                    >
                      <CharacterAvatar
                        avatar={{ kind: "generated", shape: genBase.shape, palette: genBase.palette, face: i, color: genBase.color }}
                        size={26}
                      />
                    </button>
                  ))}
                </div>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-on-surface mb-1">Name</label>
            <input
              className={inputClass}
              placeholder="Enter your name"
              value={name}
              aria-label="Your name"
              onChange={(e) => {
                const next = e.target.value;
                setName(next);
                if (!avatarManual) setAvatar(avatarForName(next));
              }}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-on-surface mb-1">Role</label>
            <div className="relative">
              <select
                className="w-full appearance-none rounded-md bg-surface-secondary border-0 px-3 py-2.5 pr-8 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-zinc-400/40 transition-shadow"
                value={role}
                aria-label="Your role"
                onChange={(e) => setRole(e.target.value)}
              >
                <option value="attendee">Attendee</option>
                <option value="facilitator">Facilitator</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-on-surface-tertiary" />
            </div>
          </div>

          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium text-on-surface-secondary hover:bg-surface-secondary transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !name.trim()}
            className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
              saving || !name.trim()
                ? "bg-accent-soft text-white cursor-not-allowed"
                : "bg-accent text-white hover:bg-accent-hover"
            }`}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
};

export default HumanModal;
