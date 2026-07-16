import React, { useId } from "react";
import type { Avatar, AvatarShape } from "../types";
import { AVATAR_PALETTES, resolveAvatar, shade } from "../utils/avatar";

interface CharacterAvatarProps {
  /** Explicit avatar. If absent/invalid, one is derived from `name`. */
  avatar?: Avatar | null;
  /** Used to derive a deterministic avatar when none is provided. */
  name?: string;
  /** Rendered pixel size (square). Default 40. */
  size?: number;
  className?: string;
  title?: string;
}

const G = 24; // sprite grid (24×24 cells)
const BLUSH = "#FF9EB5";
const WHITE = "#FFFFFF";
const PUPIL = "#2A2F3A";
const POLE = "#9AA3B2";

// ---- silhouette tests (which grid cells belong to the body) ----
function inCircle(x: number, y: number) {
  const dx = (x + 0.5 - 12) / 9;
  const dy = (y + 0.5 - 15) / 7;
  return dx * dx + dy * dy <= 1;
}
function inSquare(x: number, y: number) {
  if (x < 4 || x > 19 || y < 8 || y > 21) return false;
  const corner = (x < 7 || x > 16) && (y < 11 || y > 18);
  if (corner) {
    const rx = x < 11.5 ? 6 : 17;
    const ry = y < 15.5 ? 10 : 19;
    if ((x - rx) * (x - rx) + (y - ry) * (y - ry) > 9) return false;
  }
  return true;
}
function inTriangle(x: number, y: number) {
  if (y < 8 || y > 21) return false;
  const t = (y - 8) / (21 - 8);
  const hw = 1.2 + t * 9.5;
  return Math.abs(x + 0.5 - 12) <= hw;
}
function silhouetteFn(shape: AvatarShape) {
  return shape === "circle" ? inCircle : shape === "square" ? inSquare : inTriangle;
}

type Grid = (string | null)[][];

function paintFace(px: Grid, shape: AvatarShape, face: number) {
  const ey = shape === "triangle" ? 17 : 14;
  const dx = shape === "triangle" ? 2 : 3;
  const exs = [12 - dx, 12 + dx];
  const set = (x: number, y: number, c: string) => {
    if (x >= 0 && x < G && y >= 0 && y < G) px[y][x] = c;
  };
  const roundEye = (cx: number, dir: number) => {
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 2; oy++) set(cx + ox, ey + oy, WHITE);
    set(cx + dir, ey, PUPIL);
    set(cx + dir, ey + 1, PUPIL);
  };
  const bigDot = (cx: number) => {
    for (let ox = 0; ox <= 1; ox++) for (let oy = 0; oy <= 1; oy++) set(cx + ox, ey + oy, PUPIL);
  };
  const caret = (cx: number) => {
    set(cx - 1, ey + 1, PUPIL);
    set(cx, ey, PUPIL);
    set(cx + 1, ey + 1, PUPIL);
  };
  const line = (cx: number) => {
    for (let ox = -1; ox <= 1; ox++) set(cx + ox, ey, PUPIL);
  };
  const blush = (cx: number, side: number) => {
    set(cx + side * 2, ey + 2, BLUSH);
    set(cx + side * 2 + (side > 0 ? 1 : -1), ey + 2, BLUSH);
    set(cx + side * 2, ey + 3, BLUSH);
  };

  switch (face) {
    case 0:
      roundEye(exs[0], 1);
      roundEye(exs[1], -1);
      break;
    case 1:
      bigDot(exs[0] - 1);
      bigDot(exs[1]);
      break;
    case 2:
      caret(exs[0]);
      caret(exs[1]);
      blush(exs[0], -1);
      blush(exs[1], 1);
      break;
    case 3:
      bigDot(exs[0] - 1);
      bigDot(exs[1]);
      blush(exs[0], -1);
      blush(exs[1], 1);
      break;
    case 4:
      roundEye(exs[0], 1);
      caret(exs[1]);
      break;
    default:
      line(exs[0]);
      line(exs[1]);
      blush(exs[0], -1);
      blush(exs[1], 1);
  }
}

function paintFlag(px: Grid, body: string, dark: string) {
  // A thin pole rising from the head's centre top, with a right-pointing ▶
  // pennant (vertical hoist on the pole, tip pointing right).
  const poleX = 11;
  for (let y = 1; y <= 7; y++) px[y][poleX] = POLE;
  const penn: [number, number, number][] = [
    [12, 2, 1],
    [12, 3, 2],
    [12, 4, 3],
    [12, 5, 2],
    [12, 6, 1],
  ];
  for (const [xs, y, len] of penn) for (let i = 0; i < len; i++) px[y][xs + i] = body;
  // dark outline: the top vertex and the hypotenuse down to the tip
  px[1][12] = dark;
  px[2][13] = dark;
  px[3][14] = dark;
  px[4][15] = dark;
  px[5][14] = dark;
  px[6][13] = dark;
}

// Run-length-encode the grid into horizontal rects (few nodes, crisp scaling).
// Cached per shape/face/colour — the geometry is size-independent (viewBox).
type Run = { x: number; y: number; w: number; c: string };
const spriteCache = new Map<string, Run[]>();

function buildSprite(shape: AvatarShape, face: number, body: string, dark: string): Run[] {
  const key = `${shape}-${face}-${body}-${dark}`;
  const cached = spriteCache.get(key);
  if (cached) return cached;

  const inside = silhouetteFn(shape);
  const fill: boolean[][] = [];
  const px: Grid = [];
  for (let y = 0; y < G; y++) {
    fill.push([]);
    px.push([]);
    for (let x = 0; x < G; x++) {
      fill[y][x] = inside(x, y);
      px[y][x] = null;
    }
  }
  // body
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) if (fill[y][x]) px[y][x] = body;
  // 1px outline around the silhouette
  for (let y = 0; y < G; y++)
    for (let x = 0; x < G; x++) {
      if (fill[y][x]) continue;
      let adj = false;
      for (const [ax, ay] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + ax;
        const ny = y + ay;
        if (nx >= 0 && nx < G && ny >= 0 && ny < G && fill[ny][nx]) adj = true;
      }
      if (adj) px[y][x] = dark;
    }
  paintFace(px, shape, face);
  paintFlag(px, body, dark);

  const runs: Run[] = [];
  for (let y = 0; y < G; y++) {
    let x = 0;
    while (x < G) {
      const c = px[y][x];
      if (c === null) {
        x++;
        continue;
      }
      let w = 1;
      while (x + w < G && px[y][x + w] === c) w++;
      runs.push({ x, y, w, c });
      x += w;
    }
  }
  spriteCache.set(key, runs);
  return runs;
}

// ---- the System bot: a special grey variant of the dot characters ----
// Square body with rectangular ears on both sides and an antenna (rod +
// ball) on the head instead of the flag. Same pixel style and face as the
// participants' sprites, so it reads as one of them — just clearly a robot.
const BOT_BODY = "#9CA3AF";

function buildBotSprite(): Run[] {
  const key = "system-bot";
  const cached = spriteCache.get(key);
  if (cached) return cached;

  const dark = shade(BOT_BODY, -0.4);
  const inBot = (x: number, y: number) =>
    inSquare(x, y) || (y >= 12 && y <= 17 && ((x >= 1 && x <= 3) || (x >= 20 && x <= 22)));

  const fill: boolean[][] = [];
  const px: Grid = [];
  for (let y = 0; y < G; y++) {
    fill.push([]);
    px.push([]);
    for (let x = 0; x < G; x++) {
      fill[y][x] = inBot(x, y);
      px[y][x] = null;
    }
  }
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) if (fill[y][x]) px[y][x] = BOT_BODY;
  for (let y = 0; y < G; y++)
    for (let x = 0; x < G; x++) {
      if (fill[y][x]) continue;
      let adj = false;
      for (const [ax, ay] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + ax;
        const ny = y + ay;
        if (nx >= 0 && nx < G && ny >= 0 && ny < G && fill[ny][nx]) adj = true;
      }
      if (adj) px[y][x] = dark;
    }
  paintFace(px, "square", 0);
  // Seam between each ear and the body: drawn in the same column as the
  // body's vertical outline (x3/x20), so the outline runs straight through
  // the ear rows without a jog.
  for (let y = 12; y <= 17; y++) {
    px[y][3] = dark;
    px[y][20] = dark;
  }
  // Antenna: a rod rising from the head into a little ball.
  for (let y = 4; y <= 6; y++) px[y][11] = dark;
  for (const [x, y] of [
    [11, 0],
    [12, 0],
    [10, 1],
    [13, 1],
    [10, 2],
    [13, 2],
    [11, 3],
    [12, 3],
  ])
    px[y][x] = dark;
  for (const [x, y] of [
    [11, 1],
    [12, 1],
    [11, 2],
    [12, 2],
  ])
    px[y][x] = BOT_BODY;

  const runs: Run[] = [];
  for (let y = 0; y < G; y++) {
    let x = 0;
    while (x < G) {
      const c = px[y][x];
      if (c === null) {
        x++;
        continue;
      }
      let w = 1;
      while (x + w < G && px[y][x + w] === c) w++;
      runs.push({ x, y, w, c });
      x += w;
    }
  }
  spriteCache.set(key, runs);
  return runs;
}

/** The System bot avatar: the grey robot variant of the dot characters. */
export const SystemBotAvatar: React.FC<{
  size?: number;
  className?: string;
  title?: string;
}> = ({ size = 40, className, title }) => {
  const runs = buildBotSprite();
  return (
    // The bot sprite fills the 24-cell grid edge to edge (the ears' outer
    // outline sits on columns 0 and 23), so the viewBox pads one cell all
    // around — at fractional cell sizes, crispEdges rounding otherwise
    // swallows the column touching the viewport edge (a clipped right ear).
    <svg
      width={size}
      height={size}
      viewBox="-1 -1 26 26"
      className={className}
      role="img"
      aria-label={title ?? "System avatar"}
      shapeRendering="crispEdges"
    >
      {title ? <title>{title}</title> : null}
      {runs.map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={r.w} height={1} fill={r.c} />
      ))}
    </svg>
  );
};

/**
 * A small procedurally generated pixel-art character avatar (or an uploaded
 * image). Flat colors, cute game-sprite face, and a little flag — echoing the
 * home-screen characters. Rendered as inline SVG so it scales crisply.
 */
const CharacterAvatar: React.FC<CharacterAvatarProps> = ({
  avatar,
  name = "",
  size = 40,
  className,
  title,
}) => {
  const uid = useId().replace(/:/g, "");
  const resolved = resolveAvatar(avatar, name);
  const label = title ?? (name ? `${name} avatar` : "avatar");

  if (resolved.kind === "image") {
    const clip = `clip-${uid}`;
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={className} role="img" aria-label={label}>
        {title ? <title>{title}</title> : null}
        <defs>
          <clipPath id={clip}>
            <circle cx={12} cy={12} r={12} />
          </clipPath>
        </defs>
        <image
          href={resolved.src}
          x={0}
          y={0}
          width={24}
          height={24}
          clipPath={`url(#${clip})`}
          preserveAspectRatio="xMidYMid slice"
        />
      </svg>
    );
  }

  const pal = AVATAR_PALETTES[resolved.palette] ?? AVATAR_PALETTES[0];
  const body = resolved.color ?? pal.body;
  const dark = resolved.color ? shade(resolved.color, -0.4) : pal.dark;
  const runs = buildSprite(resolved.shape, resolved.face, body, dark);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      {title ? <title>{title}</title> : null}
      {runs.map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={r.w} height={1} fill={r.c} />
      ))}
    </svg>
  );
};

export default CharacterAvatar;
