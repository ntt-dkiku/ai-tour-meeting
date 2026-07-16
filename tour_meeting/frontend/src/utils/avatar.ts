import type { Avatar, AvatarShape, GeneratedAvatar } from "../types";

// Color palettes for generated avatars. The first three mirror the home-screen
// characters (blue sphere, green box, pink cone); the rest add variety.
// `body` fills the shape; `dark` is the pixel outline / accent.
export const AVATAR_PALETTES: { body: string; dark: string }[] = [
  { body: "#7FB2F0", dark: "#3F6DBF" }, // blue
  { body: "#7FD99B", dark: "#3E9E63" }, // green
  { body: "#F2A5D0", dark: "#C25E9C" }, // pink
  { body: "#B79BF0", dark: "#7E5FBF" }, // purple
  { body: "#F5C97A", dark: "#C2903E" }, // amber
  { body: "#7FD5D9", dark: "#3E9EA3" }, // teal
];

export const AVATAR_SHAPES: AvatarShape[] = ["circle", "square", "triangle"];

// Number of distinct face (eye) styles rendered by CharacterAvatar.
export const AVATAR_FACE_COUNT = 6;

// Fast, stable string hash (FNV-1a) → used to derive a deterministic avatar
// from a participant's name when no explicit avatar is set.
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic avatar derived from a name — the same name always maps to the
 *  same character, so legacy participants (no stored avatar) look stable. */
export function avatarForName(name: string): GeneratedAvatar {
  const h = hashString(name || "?");
  return {
    kind: "generated",
    shape: AVATAR_SHAPES[h % AVATAR_SHAPES.length],
    palette: (h >>> 4) % AVATAR_PALETTES.length,
    face: (h >>> 9) % AVATAR_FACE_COUNT,
  };
}

/** A fresh, fully random generated avatar (used when adding a participant). */
export function randomAvatar(): GeneratedAvatar {
  return {
    kind: "generated",
    shape: AVATAR_SHAPES[Math.floor(Math.random() * AVATAR_SHAPES.length)],
    palette: Math.floor(Math.random() * AVATAR_PALETTES.length),
    face: Math.floor(Math.random() * AVATAR_FACE_COUNT),
  };
}

/** Normalize any (possibly missing or malformed) avatar value into something
 *  renderable, falling back to a deterministic character derived from the name. */
export function resolveAvatar(avatar: Avatar | null | undefined, name: string): Avatar {
  if (avatar && typeof avatar === "object") {
    if (avatar.kind === "image" && typeof avatar.src === "string" && avatar.src) {
      return avatar;
    }
    if (avatar.kind === "generated") {
      const shape = AVATAR_SHAPES.includes(avatar.shape) ? avatar.shape : "circle";
      const palette =
        Number.isInteger(avatar.palette) &&
        avatar.palette >= 0 &&
        avatar.palette < AVATAR_PALETTES.length
          ? avatar.palette
          : 0;
      const face =
        Number.isInteger(avatar.face) && avatar.face >= 0 && avatar.face < AVATAR_FACE_COUNT
          ? avatar.face
          : 0;
      const color =
        typeof avatar.color === "string" && /^#[0-9a-fA-F]{6}$/.test(avatar.color)
          ? avatar.color
          : undefined;
      return { kind: "generated", shape, palette, face, color };
    }
  }
  return avatarForName(name);
}

/** Whether an avatar is just the default character derived from `name` (i.e.
 *  it was never customized via upload / shuffle / custom). Used to decide if a
 *  stored avatar should keep tracking the name when it's edited. */
export function isNameDerivedAvatar(
  avatar: Avatar | null | undefined,
  name: string
): boolean {
  if (!avatar || avatar.kind !== "generated") return false;
  const derived = avatarForName(name);
  return (
    avatar.shape === derived.shape &&
    avatar.palette === derived.palette &&
    avatar.face === derived.face &&
    (avatar.color ?? undefined) === (derived.color ?? undefined)
  );
}

/** Shade a #rrggbb hex colour. `amt` in [-1, 1]: negative darkens, positive lightens. */
export function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const f = (c: number) =>
    Math.max(0, Math.min(255, Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt))));
  return `#${((f(r) << 16) | (f(g) << 8) | f(b)).toString(16).padStart(6, "0")}`;
}

/** Read an image File, downscale it to a small square thumbnail, and return a
 *  compact data URL suitable for inlining in the participant config. */
export function fileToAvatarImage(file: File, size = 96): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Failed to load image"));
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Canvas not supported"));
          return;
        }
        // Cover-crop the image into the square.
        const scale = Math.max(size / img.width, size / img.height);
        const dw = img.width * scale;
        const dh = img.height * scale;
        ctx.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
        // PNG preserves transparency; JPEG is smaller for photos. Prefer JPEG
        // unless the source is a PNG (which may rely on transparency).
        const mime = file.type === "image/png" ? "image/png" : "image/jpeg";
        resolve(canvas.toDataURL(mime, 0.85));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}
