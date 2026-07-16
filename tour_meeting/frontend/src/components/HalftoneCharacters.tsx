import { useEffect, useRef } from "react";

interface TableRect {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

interface HalftoneCharactersProps {
  className?: string;
  /**
   * Reports the on-screen position/size of the 3D "table" so a click/a11y
   * target can be overlaid on it. Called with null when WebGL is unavailable
   * (so the caller can fall back to a plain DOM button).
   */
  onTable?: (rect: TableRect | null) => void;
  /** While true (pointer held on the table) the label lifts for press feedback. */
  pressed?: boolean;
}

/**
 * Playful home-screen backdrop: the three logo characters rendered as
 * screen-space halftone dots, each with its own eye personality and a little
 * flag on its head, tumbling in from the back on a loop.
 *
 * - blue sphere:  round eyes, a hint of cross-eye looking down
 * - green box:    sleepy — only the lower half of the eye shows, under an
 *                 iris-colored lid line
 * - pink cone:    upturned almond cat eyes with lashes and a highlight
 *
 * Dotted white eyeballs with an iris-colored frame (readable in light and dark)
 * and a character-colored iris. Eyes/lashes are flat single-sided features laid
 * flush onto the body surface (placed from the surface normal via a raycast),
 * so they roll with the body and vanish naturally when rolled out of view.
 * Blinking dyes each eye top-to-bottom with the body color via a fill shader
 * (no deforming). The flag is planted on the body, so it rolls with the head
 * instead of floating above the centre.
 *
 * Three.js is loaded lazily and the effect bails cleanly where WebGL is not
 * available (e.g. jsdom during tests), so it never breaks rendering.
 */

// Per-character setup. color / eyeColor are RGB in [0,1]. aim = direction from
// the body centre toward each eye; the flag reuses the body color.
const CHARACTERS = [
  {
    shape: "sphere",
    color: [0.52, 0.71, 0.94], // blue — round
    eyeColor: [0.15, 0.35, 0.75], // deep blue iris
    x: -3.4,
    aim: { x: 0.42, y: 0.32, z: 0.9 },
    eyeShape: "full",
    pupilInset: 0.07, // a hint of cross-eye
    pupilLower: 0.07, // looking slightly down
    eyeTilt: 0,
    eyeAspect: { x: 1, y: 1 },
    eyeSquashY: 1,
    pupilScale: { x: 1, y: 1 },
    lashes: 0,
    eyelidArc: false,
    shine: false,
    irisOutline: false,
    headTop: 1.05,
  },
  {
    shape: "box",
    color: [0.45, 0.88, 0.67], // green — rectangle
    eyeColor: [0.1, 0.48, 0.32], // deep green iris
    x: 0.0,
    aim: { x: 0.46, y: 0.22, z: 0.85 },
    eyeShape: "lowerHalf", // sleepy: both eyeball and iris are bottom half-moons
    pupilInset: 0,
    pupilLower: 0,
    eyeTilt: 0,
    eyeAspect: { x: 1, y: 1 },
    eyeSquashY: 1,
    pupilScale: { x: 1, y: 1 },
    lashes: 0,
    eyelidArc: true, // drooping upper-lid line (theme-colored)
    shine: false,
    irisOutline: false,
    headTop: 0.85,
  },
  {
    shape: "cone",
    color: [0.96, 0.65, 0.82], // pink — triangle
    eyeColor: [0.85, 0.28, 0.55], // deep pink iris
    x: 3.4,
    aim: { x: 0.52, y: 0.16, z: 0.72 }, // wider-set eyes
    eyeShape: "full",
    pupilInset: 0.07, // cross-eye, like the blue one
    pupilLower: 0,
    eyeTilt: 30, // gently upturned outer corners — cat eyes
    eyeAspect: { x: 1.2, y: 0.7 }, // smaller almond
    eyeSquashY: 1,
    pupilScale: { x: 1, y: 1 }, // simple, smaller iris
    lashes: 2, // lashes per eye
    eyelidArc: false,
    shine: true, // cute white highlight
    irisOutline: false,
    headTop: 1.0,
  },
] as const;

const POLE_COLOR = [0.5, 0.5, 0.56];
// Three columns. The trio is distributed across the columns as a shuffled
// permutation (never picked independently per character), re-shuffled once per
// round — so a re-entering character may briefly overlap the previous occupant
// before it rolls off the front, but at rest the three columns are always used.
const LANES = CHARACTERS.map((c) => c.x);

const Z_START = -26; // spawn depth (far, small)
const Z_END = 10; // recycle once past the camera
const SPEED = 3.2; // world units / second toward the viewer
const ROLL = 1.9; // body roll, radians / second
const BASE_Y = -0.15; // resting height
const HOP_AMP = 0.35; // bounce height
const HOP_FREQ = 4.2; // bounce speed
const WADDLE = 0.13; // side-to-side tilt, radians
const WADDLE_FREQ = 3.4; // waddle speed
const BLINK_PERIOD = 2.2; // seconds between blinks (lower = more frequent)
const BLINK_DUR = 0.28; // blink length (seconds) (higher = slower blink)
const DOT_SIZE = 7; // halftone dot pitch, in CSS pixels
const GROUND_Y = -0.8; // world height of the "ground" the flag can hit (higher = bends over a wider range)
const BEND_K = 5.0; // tip bend angle (radians) per unit of ground penetration
const BEND_MAX = 2.6; // cap on the flag bend (~150°) — flops right over, exaggerated
const FREEZE = false; // set true to hold a static, front-facing pose for inspection
// Roll style: 0 = forward roll, 1 = barrel roll, 2 = turn & float. Set a number
// to pin one; null → a weighted random style each time a character enters
// (0: 65%, 2: 25%, 1: 10%).
const VARIANT: number | null = null;

// Round "table" (a dotted 3D disc) shown on the home screen as the call to
// action. It lives in the same scene as the characters, and the centre-lane
// character rolls up onto it as it passes.
const TABLE_X = 0;
const TABLE_Z = 6.3; // toward the viewer, so the table sits low on screen
const TABLE_TOP = -0.55; // world height of the tabletop surface
const TABLE_R = 1.5; // table radius
const TABLE_H = 0.14; // tabletop slab thickness (thin side)
const LEG_BOTTOM = -1.35; // where the four legs meet the floor
const RIDE_RAMP = 0.8; // how gradually a character climbs onto the tabletop

export default function HalftoneCharacters({
  className,
  onTable,
  pressed,
}: HalftoneCharactersProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onTableRef = useRef(onTable);
  onTableRef.current = onTable;
  const pressedRef = useRef(pressed);
  pressedRef.current = pressed;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const prefersReducedMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;

    // Bail cleanly where WebGL is unavailable (e.g. jsdom in tests). Check the
    // constructors first so we never call getContext() in environments that do
    // not implement it (which would log noisy "Not implemented" errors).
    const webglSupported =
      typeof window !== "undefined" &&
      ("WebGL2RenderingContext" in window || "WebGLRenderingContext" in window);
    if (!webglSupported) {
      onTableRef.current?.(null);
      return;
    }

    let hasWebGL = false;
    try {
      const probe = document.createElement("canvas");
      hasWebGL = !!(probe.getContext("webgl2") || probe.getContext("webgl"));
    } catch {
      hasWebGL = false;
    }
    if (!hasWebGL) {
      onTableRef.current?.(null);
      return;
    }

    let disposed = false;
    let raf = 0;
    let cleanup = () => {};

    (async () => {
      const THREE = await import("three");
      if (disposed || !containerRef.current) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = container.clientWidth || 1;
      const height = container.clientHeight || 1;

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(dpr);
      renderer.setSize(width, height);
      renderer.setClearColor(0x000000, 0); // transparent — the app surface shows through
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      renderer.domElement.style.display = "block";
      container.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
      // Low, near-horizontal viewpoint so the round table reads as a flattened
      // ellipse (seen closer to eye level). The camera position sets that angle;
      // aiming it upward (lookAt above the table) pushes the table lower in the
      // frame WITHOUT changing the viewing angle / ellipse.
      camera.position.set(0, 0.0, 11);
      camera.lookAt(0, 1.7, 0);

      // Screen-space halftone dots shaded by a simple diffuse term.
      const vertexShader = `
        varying float vShade;
        varying vec3 vLocalPos;
        varying float vNy; // local normal's up-component: 1 on top/bottom faces, 0 on sides
        uniform vec3 uLightDir;
        uniform float uBend; // flag flex: tip bend angle in radians (0 = straight, up to ~PI/2)
        uniform float uBendSide; // 0 = curl backward (-z), 1 = curl sideways (-x, in the roll plane)
        void main() {
          vLocalPos = position; // for the rainbow gradient (painted on the body, rolls with it)
          vNy = normal.y;
          vec3 n = normalize(normalMatrix * normal);
          float diff = max(dot(n, normalize(uLightDir)), 0.0);
          vShade = clamp(0.32 + 0.68 * diff, 0.0, 1.0);
          vec3 p = position;
          if (uBend > 0.0001) {
            // Bend the flag into a circular arc about its base, reaching uBend
            // radians at the tip. Normally it curls backward (in the y-z plane);
            // for the face-on barrel roll it curls sideways (in the y-x plane)
            // so it folds within the spin plane instead of away from the viewer.
            float L = 0.9;
            float h = clamp(p.y, 0.0, L);
            float a = uBend * (h / L);
            float R = L / uBend;
            float ca = cos(a), sa = sin(a);
            if (uBendSide > 0.5) {
              vec3 arc = vec3(R * (1.0 - ca), R * sa, 0.0);
              vec3 nrm = vec3(ca, -sa, 0.0);
              p = vec3(0.0, 0.0, p.z) + arc + p.x * nrm;
            } else {
              vec3 arc = vec3(0.0, R * sa, -R * (1.0 - ca));
              vec3 nrm = vec3(0.0, sa, ca);
              p = vec3(p.x, 0.0, 0.0) + arc + p.z * nrm;
            }
          }
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `;
      const fragmentShader = `
        precision highp float;
        varying float vShade;
        varying vec3 vLocalPos;
        varying float vNy;
        uniform vec3 uColor;
        uniform float uDotSize;
        uniform float uShade;          // >= 0 forces a flat dot size (used for eyes)
        uniform float uRainbow;        // > 0.5 -> paint a shifting rainbow instead of uColor
        uniform float uTime;           // seconds, drives the rainbow shimmer
        uniform float uColorShade;     // > 0.5 -> also darken the color on unlit faces (3D form)
        uniform float uHolo;           // > 0.5 -> iridescent holographic shimmer + scanlines
        uniform float uFade;           // 1 solid; < 1 shrinks + fades the dots (dissolve-out)
        vec3 hsv2rgb(vec3 c) {
          vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
          vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
          return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
        }
        void main() {
          vec2 g = fract(gl_FragCoord.xy / uDotSize) - 0.5;
          float dist = length(g) * 2.0;
          float r = (uShade >= 0.0 ? uShade : vShade) * uFade; // flat, or brighter -> larger dot; uFade shrinks it
          float mask = 1.0 - smoothstep(r - 0.12, r + 0.12, dist);
          if (mask < 0.02) discard;
          vec3 col = uColor;
          if (uRainbow > 0.5) {
            float hue = fract(vLocalPos.y * 0.45 + vLocalPos.x * 0.12 + uTime * 0.2);
            col = hsv2rgb(vec3(hue, 0.85, 1.0));
          }
          if (uColorShade > 0.5) {
            col *= mix(0.55, 1.0, abs(vNy)); // bright top face, distinctly darker sides
          }
          if (uHolo > 0.5) {
            float hue = 0.62 + 0.2 * sin(vLocalPos.y * 2.4 + vLocalPos.x * 1.5 + uTime * 1.2);
            vec3 irid = hsv2rgb(vec3(hue, 0.55, 1.0));
            if (uHolo > 1.5) {
              // Full iridescent hologram (used for the winding road).
              float scan = 0.72 + 0.28 * sin(gl_FragCoord.y * 0.18 + uTime * 5.0);
              col = irid * scan;
            } else {
              // Light-blue (水色) base with only a faint iridescent + scanline
              // accent (used for the landmarks).
              col = mix(uColor, irid, 0.16);
              float scan = 0.93 + 0.07 * sin(gl_FragCoord.y * 0.18 + uTime * 5.0);
              col *= scan;
            }
          }
          gl_FragColor = vec4(col, mask * uFade);
        }
      `;

      const lightDir = new THREE.Vector3(0.4, 0.85, 0.6);
      const disposables: { dispose: () => void }[] = [];

      const makeDotMaterial = (
        rgb: readonly number[],
        doubleSide = false,
        shade = -1,
        colorShade = false,
        holo: boolean | number = false // 0/false none, 1 faint cyan accent, 2 full iridescent
      ) => {
        const mat = new THREE.ShaderMaterial({
          vertexShader,
          fragmentShader,
          transparent: true,
          side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
          uniforms: {
            uColor: { value: new THREE.Color(rgb[0], rgb[1], rgb[2]) },
            uDotSize: { value: DOT_SIZE * dpr },
            uLightDir: { value: lightDir },
            uShade: { value: shade },
            uBend: { value: 0 },
            uBendSide: { value: 0 },
            uRainbow: { value: 0 },
            uTime: { value: 0 },
            uColorShade: { value: colorShade ? 1 : 0 },
            uHolo: { value: typeof holo === "number" ? holo : holo ? 1 : 0 },
            uFade: { value: 1 },
          },
        });
        disposables.push(mat);
        return mat;
      };

      // Body-colored "eyelid" that dyes the eye from the top down. The mesh keeps
      // its full shape; the fragment shader just reveals the top `uFill` fraction
      // (by local y), so the dye descends as a clean waterline — no deforming.
      const fillVertexShader = `
        varying float vFillCoord;
        varying vec3 vLocalPos;
        uniform float uAspectX;
        uniform float uAspectY;
        uniform float uSinTilt;
        uniform float uCosTilt;
        void main() {
          // Vertical coordinate in the eye's UPRIGHT frame, so the lid closes
          // straight top->bottom regardless of the cat-eye tilt / aspect.
          vFillCoord = (uAspectX * position.x) * uSinTilt + (uAspectY * position.y) * uCosTilt;
          vLocalPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `;
      const fillFragmentShader = `
        precision highp float;
        varying float vFillCoord;
        varying vec3 vLocalPos;
        uniform vec3 uColor;
        uniform float uDotSize;
        uniform float uFill;   // 0 open .. 1 fully dyed
        uniform float uTop;    // top of the eye along the fill axis
        uniform float uHeight; // eye height along the fill axis
        uniform float uRainbow; // > 0.5 -> dye with the rainbow (matches a rainbow body)
        uniform float uTime;
        vec3 hsv2rgb(vec3 c) {
          vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
          vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
          return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
        }
        void main() {
          if (vFillCoord < uTop - uFill * uHeight) discard; // only the dyed top band
          vec2 g = fract(gl_FragCoord.xy / uDotSize) - 0.5;
          float dist = length(g) * 2.0;
          float mask = 1.0 - smoothstep(0.83, 1.07, dist); // dense dots (~shade 0.95)
          if (mask < 0.02) discard;
          vec3 col = uColor;
          if (uRainbow > 0.5) {
            float hue = fract(vLocalPos.y * 0.45 + vLocalPos.x * 0.12 + uTime * 0.2);
            col = hsv2rgb(vec3(hue, 0.85, 1.0));
          }
          gl_FragColor = vec4(col, mask);
        }
      `;
      const makeFillMaterial = (
        rgb: readonly number[],
        aspectX: number,
        aspectY: number,
        tiltZ: number,
        lowerHalf: boolean
      ) => {
        const R = 0.25;
        const sinT = Math.sin(tiltZ);
        const cosT = Math.cos(tiltZ);
        const a = aspectX * R;
        const b = aspectY * R;
        const vHalf = Math.sqrt(a * a * sinT * sinT + b * b * cosT * cosT); // upright half-height
        const mat = new THREE.ShaderMaterial({
          vertexShader: fillVertexShader,
          fragmentShader: fillFragmentShader,
          transparent: true,
          uniforms: {
            uColor: { value: new THREE.Color(rgb[0], rgb[1], rgb[2]) },
            uDotSize: { value: DOT_SIZE * dpr },
            uFill: { value: 0 },
            uTop: { value: lowerHalf ? 0 : vHalf },
            uHeight: { value: lowerHalf ? b : 2 * vHalf },
            uAspectX: { value: aspectX },
            uAspectY: { value: aspectY },
            uSinTilt: { value: sinT },
            uCosTilt: { value: cosT },
            uRainbow: { value: 0 },
            uTime: { value: 0 },
          },
        });
        disposables.push(mat);
        return mat;
      };

      const geometryFor = (shape: string) => {
        let geo: THREE.BufferGeometry;
        if (shape === "sphere") geo = new THREE.SphereGeometry(1.1, 48, 48);
        else if (shape === "box") geo = new THREE.BoxGeometry(1.7, 1.7, 1.7);
        else geo = new THREE.ConeGeometry(1.2, 2.1, 40);
        disposables.push(geo);
        return geo;
      };

      // Shared assets.
      const scleraFullGeo = new THREE.CircleGeometry(0.25, 28);
      const scleraLowerGeo = new THREE.CircleGeometry(0.25, 28, Math.PI, Math.PI); // bottom half
      const irisGeo = new THREE.CircleGeometry(0.13, 22);
      const irisLowerGeo = new THREE.CircleGeometry(0.14, 22, Math.PI, Math.PI); // bottom half-moon iris (~ other irises)
      const lidArcGeo = new THREE.RingGeometry(0.25, 0.29, 28, 1, 0, Math.PI); // top-half rim, flush with the eyeball edge + frame
      const shineGeo = new THREE.CircleGeometry(0.05, 14); // cute eye highlight
      const lashGeo = new THREE.PlaneGeometry(0.045, 0.22);
      // Pole + pennant live in the flag's height frame (base at y=0, tip near
      // y=0.9) so the bend shader (which curves by height) works for both.
      // Plenty of height segments: the bend shader displaces VERTICES, so with
      // the default single segment the pole would render as a straight chord
      // (only its end ring moves) while the flag's hoist verts follow the true
      // arc — visually detaching the flag from the pole.
      const poleGeo = new THREE.CylinderGeometry(0.028, 0.028, 0.9, 8, 24);
      poleGeo.translate(0, 0.45, 0); // base at y=0
      const flagGeo = new THREE.BufferGeometry();
      flagGeo.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array([0, 0.54, 0, 0, 0.88, 0, 0.5, 0.71, 0]), 3)
      );
      flagGeo.setAttribute(
        "normal",
        new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3)
      );
      flagGeo.setIndex([0, 1, 2]);
      disposables.push(scleraFullGeo, scleraLowerGeo, irisGeo, irisLowerGeo, lidArcGeo, shineGeo, lashGeo, poleGeo, flagGeo);

      // Solid (non-dotted) eyeball white so it never reads as transparent on a
      // dark background.
      const eyeWhiteMat = makeDotMaterial([1, 1, 1], false, 0.95); // dotted white eyeball
      const shineMat = new THREE.MeshBasicMaterial({ color: 0xffffff }); // solid highlight glint
      disposables.push(shineMat);

      // Lay a flat feature flush onto the body surface along an aim direction,
      // using the surface point + normal from a raycast so it never sinks in.
      const raycaster = new THREE.Raycaster();
      const forwardAxis = new THREE.Vector3(0, 0, 1);
      const placeOnSurface = (body: THREE.Mesh, dir: THREE.Vector3, offset: number) => {
        const d = dir.clone().normalize();
        raycaster.set(d.clone().multiplyScalar(8), d.clone().multiplyScalar(-1));
        const hit = raycaster.intersectObject(body, false)[0];
        if (!hit || !hit.face) return null;
        const normal = hit.face.normal.clone().transformDirection(body.matrixWorld).normalize();
        const pos = hit.point.clone().addScaledVector(normal, offset);
        const quat = new THREE.Quaternion().setFromUnitVectors(forwardAxis, normal);
        return { pos, quat };
      };

      // Which column each of the three characters is in (a permutation of lane
      // indices). Reshuffled once per round so the whole trio redistributes.
      const shuffledPerm = () => {
        const p = LANES.map((_, k) => k);
        for (let k = p.length - 1; k > 0; k--) {
          const j = Math.floor(Math.random() * (k + 1));
          [p[k], p[j]] = [p[j], p[k]];
        }
        return p;
      };
      // Reshuffle so every character leaves its current column (a derangement):
      // rotate all lane assignments by a random 1..N-1 columns, so each picks
      // one of the lanes it isn't already in.
      const derangePerm = (p: number[]) => {
        const shift = 1 + Math.floor(Math.random() * (LANES.length - 1));
        return p.map((v) => (v + shift) % LANES.length);
      };
      let perm = shuffledPerm();
      let recycleCount = 0;
      // Weighted roll style: mostly the plain forward roll, occasionally a
      // turn & float, rarely a barrel roll. VARIANT pins a single style instead.
      const pickStyle = () => {
        if (VARIANT !== null) return VARIANT;
        const r = Math.random();
        if (r < 0.65) return 0; // forward roll — 65%
        if (r < 0.9) return 2; // turn & float — 25%
        return 1; // barrel roll — 10%
      };
      // Rainbow "shiny" — 10% of appearances the whole body, flag, and eye
      // features (iris, frame, lashes) shimmer through the spectrum.
      const pickRainbow = () => (Math.random() < 0.1 ? 1 : 0);

      // Shared solid depth-only material for prepasses. Uses the SAME vertex
      // shader as the dots so depths match exactly (no z-fighting) and writes
      // depth only (no color). Lets a body occlude whatever is behind it, so
      // an overlapping character in a shared lane no longer shows through the
      // front character's halftone gaps.
      const depthPrepassMat = new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader: "precision highp float;\nvoid main(){ gl_FragColor = vec4(0.0); }",
        colorWrite: false,
        side: THREE.FrontSide,
        uniforms: { uLightDir: { value: lightDir }, uBend: { value: 0 }, uBendSide: { value: 0 } },
      });
      disposables.push(depthPrepassMat);

      const characters = CHARACTERS.map((c, i) => {
        const group = new THREE.Group();

        const bodyMat = makeDotMaterial(c.color);
        const body = new THREE.Mesh(geometryFor(c.shape), bodyMat);
        // Solid depth prepass of the body so a character behind it (overlapping
        // lane) is occluded instead of showing through the front dots' gaps.
        const bodyDepth = new THREE.Mesh(body.geometry, depthPrepassMat);
        bodyDepth.renderOrder = -1;
        body.add(bodyDepth);
        body.updateMatrixWorld(true); // identity — needed before raycasting for placement
        group.add(body);

        // Candidate "lowest" points (local) used to keep the body from clipping
        // into the tabletop as it rolls: each frame we rotate these and take the
        // deepest one, so the body always rests exactly on the surface. A sphere
        // is rotation-invariant, so it just uses its radius.
        const lowPts: InstanceType<typeof THREE.Vector3>[] = [];
        let roundR = 0;
        if (c.shape === "sphere") {
          roundR = 1.1;
        } else if (c.shape === "box") {
          const s = 0.85;
          for (const bx of [-s, s])
            for (const by of [-s, s])
              for (const bz of [-s, s]) lowPts.push(new THREE.Vector3(bx, by, bz));
        } else {
          lowPts.push(new THREE.Vector3(0, 1.05, 0)); // cone apex
          for (let k = 0; k < 24; k++) {
            const a = (k / 24) * Math.PI * 2;
            lowPts.push(new THREE.Vector3(Math.cos(a) * 1.2, -1.05, Math.sin(a) * 1.2)); // base rim
          }
        }

        const irisMat = makeDotMaterial(c.eyeColor, false, 0.95); // themed, dense dots

        // Eyes (+ lashes) are children of the body: they roll with it and, being
        // flat and single-sided, vanish naturally when rolled to the back.
        const blinkFills: THREE.ShaderMaterial[] = [];
        for (const side of [-1, 1]) {
          const eyeDir = new THREE.Vector3(side * c.aim.x, c.aim.y, c.aim.z);
          const eye = placeOnSurface(body, eyeDir, 0.02);
          if (!eye) continue;

          const scleraGeo = c.eyeShape === "lowerHalf" ? scleraLowerGeo : scleraFullGeo;
          const tiltZ = c.eyeTilt ? side * THREE.MathUtils.degToRad(c.eyeTilt) : 0;

          // Eyeball frame in the iris color — same in both light/dark modes.
          // A slightly larger, same-shape disc sitting just behind the white,
          // so only a colored rim shows around the eyeball.
          const frame = new THREE.Mesh(scleraGeo, irisMat);
          frame.position.copy(eye.pos);
          frame.quaternion.copy(eye.quat);
          if (tiltZ) frame.rotateZ(tiltZ);
          const frameBaseY = c.eyeSquashY * c.eyeAspect.y * 1.16;
          frame.scale.set(c.eyeAspect.x * 1.16, frameBaseY, 1);
          frame.translateZ(-0.001); // just behind the white
          body.add(frame);

          // White eyeball (dotted). Lower half only for the sleepy green.
          const sclera = new THREE.Mesh(scleraGeo, eyeWhiteMat);
          sclera.position.copy(eye.pos);
          sclera.quaternion.copy(eye.quat);
          if (tiltZ) sclera.rotateZ(tiltZ); // upturned corner
          const scleraBaseY = c.eyeSquashY * c.eyeAspect.y;
          sclera.scale.set(c.eyeAspect.x, scleraBaseY, 1); // almond when aspect != 1
          body.add(sclera);

          // Themed iris (a matching half-moon for the sleepy green), on the
          // eyeball plane; optionally shifted for cross-eye / looking down, and
          // pushed slightly forward so it never sinks.
          const irisG = c.eyeShape === "lowerHalf" ? irisLowerGeo : irisGeo;
          const iris = new THREE.Mesh(irisG, irisMat);
          iris.position.copy(eye.pos);
          iris.quaternion.copy(eye.quat);
          iris.translateX(-side * c.pupilInset);
          iris.translateY(-c.pupilLower);
          iris.translateZ(0.001);
          const irisBaseY = c.eyeSquashY * c.pupilScale.y;
          iris.scale.set(c.pupilScale.x, irisBaseY, 1);
          body.add(iris);

          // Cute white highlight on the iris.
          if (c.shine) {
            const shine = new THREE.Mesh(shineGeo, shineMat);
            shine.position.copy(eye.pos);
            shine.quaternion.copy(eye.quat);
            shine.translateX(-side * (c.pupilInset + 0.045)); // upper-inner glint, on the iris
            shine.translateY(0.06 - c.pupilLower);
            shine.translateZ(0.0018); // in front of the iris
            body.add(shine);
          }

          // Drooping upper-lid line, in the iris color (same in both modes).
          if (c.eyelidArc) {
            const lid = new THREE.Mesh(lidArcGeo, irisMat);
            lid.position.copy(eye.pos);
            lid.quaternion.copy(eye.quat);
            lid.translateZ(0.0018);
            body.add(lid);
          }

          // Short lashes from the OUTER-UPPER corner of the white, pointing up
          // and slightly out. They may stand off the surface, but never sink in.
          for (let l = 0; l < c.lashes; l++) {
            const lash = new THREE.Mesh(lashGeo, irisMat);
            lash.position.copy(eye.pos);
            lash.quaternion.copy(eye.quat);
            lash.translateX(side * (0.18 + l * 0.1)); // spread the roots along the top edge
            lash.translateY(0.2); // upper corner
            lash.translateZ(0.04); // lift clear of the surface (no clipping)
            lash.rotateZ(-side * THREE.MathUtils.degToRad(10 + l * 26)); // fan apart, up-and-out
            lash.translateY(0.11); // extend the short lash
            body.add(lash);
          }

          // Blink lid: a full-shape, body-colored cover that its shader dyes
          // from the top down (uFill). It never deforms/scales, so it can't float.
          const fillMat = makeFillMaterial(
            c.color,
            c.eyeAspect.x,
            c.eyeAspect.y,
            tiltZ,
            c.eyeShape === "lowerHalf"
          );
          const coverMesh = new THREE.Mesh(scleraGeo, fillMat);
          coverMesh.position.copy(eye.pos);
          coverMesh.quaternion.copy(eye.quat);
          if (tiltZ) coverMesh.rotateZ(tiltZ);
          coverMesh.scale.set(c.eyeAspect.x, c.eyeAspect.y, 1);
          coverMesh.translateZ(0.0026); // hair in front of the eye stack — minimal float
          body.add(coverMesh);
          blinkFills.push(fillMat);
        }

        // Flag planted on the body (rolls with the head). Pole + pennant sit in
        // a root at the head so the bend shader can flex them when the tip hits
        // the ground. Each gets its own material so uBend can be driven per char.
        const flagRoot = new THREE.Object3D();
        flagRoot.position.set(0, c.headTop, -0.05);
        const poleMat = makeDotMaterial(POLE_COLOR);
        const pennantMat = makeDotMaterial(c.color, true);
        flagRoot.add(new THREE.Mesh(poleGeo, poleMat));
        flagRoot.add(new THREE.Mesh(flagGeo, pennantMat));
        body.add(flagRoot);
        const flagMats = [poleMat, pennantMat];

        // Body + pennant + eye features (iris, frame, lashes, lid arc share
        // irisMat) + the blink eyelids all recolor together on the rare rainbow
        // roll, so a rainbow character's eyelid is rainbow too.
        const rainbowMats = [bodyMat, pennantMat, irisMat, ...blinkFills];
        const initialRainbow = pickRainbow();
        rainbowMats.forEach((m) => (m.uniforms.uRainbow.value = initialRainbow));

        // Column comes from the current permutation.
        group.position.x = LANES[perm[i]];
        // Stagger the three characters along the depth axis.
        group.position.z = Z_START + (i * (Z_END - Z_START)) / CHARACTERS.length;
        scene.add(group);
        return {
          group,
          body,
          blinkFills,
          flagMats,
          rainbowMats,
          lowPts,
          roundR,
          phase: i * 0.6,
          style: pickStyle(),
        };
      });

      const render = () => renderer.render(scene, camera);

      const tipTmp = new THREE.Vector3();
      const lowTmp = new THREE.Vector3(); // scratch for the table-clip clearance calc

      // --- Round "table" (dotted disc + four vertical legs) the centre
      // character rolls onto. Each part is drawn twice: a solid depth-only
      // prepass first (writes depth, no color) then the dotted surface, so
      // hidden geometry (back legs, legs behind the top) is depth-culled
      // instead of showing through the halftone gaps.
      // Single-sided: only the faces toward the camera are drawn, so the
      // cylinder's front and back surfaces can't overlap into a moiré.
      const tableMat = makeDotMaterial([0.6, 0.64, 0.76], false, -1, true); // slate dots, shaded
      // Dots keep depthWrite ON so front faces occlude back faces (no moiré);
      // the shared solid prepass (same vertex shader -> matching depth, no
      // z-fighting) fills the gaps between dots so nothing shows through.
      const tableDepthMat = depthPrepassMat;
      const tableGroup = new THREE.Group();
      tableGroup.position.set(TABLE_X, 0, TABLE_Z);
      const tableGeo = new THREE.CylinderGeometry(TABLE_R, TABLE_R, TABLE_H, 56, 1);
      disposables.push(tableGeo);
      const legTopY = TABLE_TOP - TABLE_H + 0.02; // meet the underside (minimal overlap -> no z-fight)
      const legInset = TABLE_R * 0.72;
      const legH = legTopY - LEG_BOTTOM;
      const legGeo = new THREE.CylinderGeometry(0.1, 0.1, legH, 16);
      disposables.push(legGeo);
      const addPart = (geo: THREE.BufferGeometry, x: number, y: number, z: number) => {
        const solid = new THREE.Mesh(geo, tableDepthMat); // depth prepass (opaque, no color)
        solid.position.set(x, y, z);
        solid.renderOrder = -1;
        tableGroup.add(solid);
        const dots = new THREE.Mesh(geo, tableMat);
        dots.position.set(x, y, z);
        tableGroup.add(dots);
      };
      addPart(tableGeo, 0, TABLE_TOP - TABLE_H / 2, 0);
      [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4].forEach((a) => {
        addPart(legGeo, Math.cos(a) * legInset, LEG_BOTTOM + legH / 2, Math.sin(a) * legInset);
      });
      scene.add(tableGroup);

      // Readable "Start a new meeting" sign standing on the table, facing the
      // camera. Drawn to a canvas texture and re-tinted when the theme flips.
      const SIGN_TEXT = "Create meeting";
      const signCanvas = document.createElement("canvas");
      signCanvas.width = 900;
      signCanvas.height = 230;
      const drawSign = () => {
        const ctx = signCanvas.getContext("2d");
        if (!ctx) return;
        const dark = document.documentElement.classList.contains("dark");
        const W = signCanvas.width;
        const H = signCanvas.height;
        ctx.clearRect(0, 0, W, H);
        // Solid (100% opaque) rounded panel behind the label — a CTA chip.
        const pad = 14;
        const r = 48;
        const x0 = pad;
        const y0 = pad;
        const x1 = W - pad;
        const y1 = H - pad;
        ctx.beginPath();
        ctx.moveTo(x0 + r, y0);
        ctx.arcTo(x1, y0, x1, y1, r);
        ctx.arcTo(x1, y1, x0, y1, r);
        ctx.arcTo(x0, y1, x0, y0, r);
        ctx.arcTo(x0, y0, x1, y0, r);
        ctx.closePath();
        ctx.fillStyle = dark ? "rgba(31,41,55,0.8)" : "rgba(255,255,255,0.8)"; // 80% opaque chip
        ctx.fill();
        // Label.
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = dark ? "#f9fafb" : "#111827";
        let font = 165;
        const fit = W - 120;
        do {
          ctx.font = `800 ${font}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
          font -= 4;
        } while (font > 24 && ctx.measureText(SIGN_TEXT).width > fit);
        ctx.fillText(SIGN_TEXT, W / 2, H / 2);
      };
      drawSign();
      const signTex = new THREE.CanvasTexture(signCanvas);
      signTex.anisotropy = renderer.capabilities.getMaxAnisotropy?.() ?? 1;
      signTex.needsUpdate = true;
      disposables.push(signTex);
      // depthTest/Write off + a high renderOrder so the label always draws on
      // top of the table and the characters (never occluded by the rider).
      const signMat = new THREE.MeshBasicMaterial({
        map: signTex,
        transparent: true,
        depthWrite: false,
        depthTest: false,
      });
      disposables.push(signMat);
      const SIGN_W = 0.7; // label sized to match the sidebar "AI Tour Meeting" title
      const signH = (SIGN_W * signCanvas.height) / signCanvas.width;
      const signGeo = new THREE.PlaneGeometry(SIGN_W, signH);
      disposables.push(signGeo);
      const sign = new THREE.Mesh(signGeo, signMat);
      sign.renderOrder = 999; // always last -> drawn in front of everything
      // Upright billboard centred exactly on the tabletop (its vertical middle).
      sign.position.set(TABLE_X, TABLE_TOP - TABLE_H / 2, TABLE_Z);
      scene.add(sign);
      const signBaseY = sign.position.y;
      let signLift = 0; // eased press-feedback offset (lifts while held)
      const themeObserver = new MutationObserver(() => {
        drawSign();
        signTex.needsUpdate = true;
        if (prefersReducedMotion || FREEZE) render();
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });

      // --- Tour-destination hologram: iridescent dotted landmarks that rise
      // from the tabletop, joined left-to-right by a winding dotted road, while
      // the Create-meeting table is hovered. The reveal interleaves building →
      // road grows → next building → ... ------------------------------------
      const holoMat = makeDotMaterial([0.3, 0.85, 1.0], false, -1, false, 1); // light-blue landmarks
      const roadMat = makeDotMaterial([0.3, 0.85, 1.0], false, -1, false, 2); // full iridescent road
      const holoGroup = new THREE.Group();
      holoGroup.position.set(TABLE_X, TABLE_TOP + 0.02, TABLE_Z);
      scene.add(holoGroup);
      const HOLO_SCALE = 0.72; // overall size of the hologram landmarks

      // A faint upward light volume rising from the WHOLE tabletop — the
      // "projector glow" that makes the landmarks feel projected. Its base spans
      // the full tabletop (right out to the rim, radius TABLE_R) and it FANS OUT
      // (widens) toward the top like a real projector beam, fading out
      // (additive). Opacity tracks the reveal (holoT).
      const beamGeo = new THREE.CylinderGeometry(1.85, TABLE_R, 0.85, 48, 1, true);
      disposables.push(beamGeo);
      const beamMat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uColor: { value: new THREE.Color(0.35, 0.8, 1.0) },
          uOpacity: { value: 0 },
        },
        vertexShader: `
          varying float vY;
          void main() {
            vY = uv.y; // 0 at the base, 1 at the top
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          precision highp float;
          uniform vec3 uColor;
          uniform float uOpacity;
          varying float vY;
          void main() {
            float a = pow(1.0 - vY, 1.2) * uOpacity; // brightest at base, fading up
            gl_FragColor = vec4(uColor * a, a);
          }
        `,
      });
      disposables.push(beamMat);
      const beam = new THREE.Mesh(beamGeo, beamMat);
      beam.position.set(0, 0.425, 0); // its base sits on the tabletop
      beam.renderOrder = -1; // behind the dotted landmarks
      holoGroup.add(beam);
      const holoBox = (
        g: THREE.Group,
        w: number,
        h: number,
        d: number,
        x: number,
        y: number,
        rotz = 0
      ) => {
        const geo = new THREE.BoxGeometry(w, h, d);
        disposables.push(geo);
        const m = new THREE.Mesh(geo, holoMat);
        m.position.set(x, y, 0);
        if (rotz) m.rotation.z = rotz;
        g.add(m);
      };
      const holoCone = (
        g: THREE.Group,
        r: number,
        h: number,
        x: number,
        y: number,
        seg = 10,
        roty = 0
      ) => {
        const geo = new THREE.ConeGeometry(r, h, seg);
        disposables.push(geo);
        const m = new THREE.Mesh(geo, holoMat);
        m.position.set(x, y, 0);
        if (roty) m.rotation.y = roty;
        g.add(m);
      };
      const holoDome = (g: THREE.Group, r: number, x: number, y: number) => {
        const geo = new THREE.SphereGeometry(r, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5);
        disposables.push(geo);
        const m = new THREE.Mesh(geo, holoMat);
        m.position.set(x, y, 0);
        g.add(m);
      };
      const holoSphere = (g: THREE.Group, r: number, x: number, y: number) => {
        const geo = new THREE.SphereGeometry(r, 12, 10);
        disposables.push(geo);
        const m = new THREE.Mesh(geo, holoMat);
        m.position.set(x, y, 0);
        g.add(m);
      };
      const holoCyl = (g: THREE.Group, r: number, h: number, x: number, y: number) => {
        const geo = new THREE.CylinderGeometry(r, r, h, 14);
        disposables.push(geo);
        const m = new THREE.Mesh(geo, holoMat);
        m.position.set(x, y, 0);
        g.add(m);
      };
      // Truncated pyramid (flat-topped): a wide-based trapezoid roof, etc.
      const holoFrustum = (
        g: THREE.Group,
        rTop: number,
        rBot: number,
        h: number,
        x: number,
        y: number,
        seg = 4,
        roty = 0
      ) => {
        const geo = new THREE.CylinderGeometry(rTop, rBot, h, seg);
        disposables.push(geo);
        const m = new THREE.Mesh(geo, holoMat);
        m.position.set(x, y, 0);
        if (roty) m.rotation.y = roty;
        g.add(m);
      };
      // A vertically-stretched sphere truncated at the bottom: it sits on a WIDE
      // flat base with its widest point low-down and tapers smoothly up to a
      // rounded (not pointed) top — a bottom-heavy egg. thetaLen (< PI) sets how
      // much of the bottom is cut off (bigger = wider base); sy stretches height.
      const holoEgg = (
        g: THREE.Group,
        r: number,
        thetaLen: number,
        sy: number,
        x: number
      ) => {
        const geo = new THREE.SphereGeometry(r, 22, 16, 0, Math.PI * 2, 0, thetaLen);
        disposables.push(geo);
        const m = new THREE.Mesh(geo, holoMat);
        m.scale.set(1, sy, 1);
        m.position.set(x, -r * Math.cos(thetaLen) * sy, 0); // sit the cut base at y=0
        g.add(m);
      };
      // Tokyo landmarks on a strongly front/back-staggered (zig-zag) path that
      // uses the table's full depth, ordered left→right:
      // 神社 → スカイツリー → 雷門 → 新宿コクーンタワー → 東京駅.
      const lmDefs = [
        {
          x: -0.98,
          z: 0.7, // front
          build: (g: THREE.Group) => {
            // 神社 (torii gate)
            holoBox(g, 0.05, 0.42, 0.05, -0.17, 0.21);
            holoBox(g, 0.05, 0.42, 0.05, 0.17, 0.21);
            holoBox(g, 0.5, 0.06, 0.1, 0, 0.44); // kasagi (top bar)
            holoBox(g, 0.38, 0.05, 0.07, 0, 0.35); // nuki (lower bar)
          },
        },
        {
          x: -0.7, // pushed out: it sits at the back, so widen to keep even on-screen spacing
          z: -0.8, // back
          build: (g: THREE.Group) => {
            // スカイツリー: tall slender tapered tower + observation bulge + antenna
            holoCone(g, 0.11, 0.95, 0, 0.475);
            holoSphere(g, 0.1, 0, 0.6);
            holoCone(g, 0.02, 0.45, 0, 1.1);
          },
        },
        {
          x: 0.0,
          z: 0.75, // front
          s: 0.78, // a touch smaller so it doesn't dominate the skyline
          build: (g: THREE.Group) => {
            // 雷門 (Kaminarimon), after the Asakusa gate: two thick posts, and —
            // its signature — a broad sweeping temple roof (wide over-hanging
            // eaves, a shallow gable, a ridge, and up-turned corners "反り"),
            // with the giant red lantern (提灯) hanging in the central passage.
            holoBox(g, 0.12, 0.5, 0.14, -0.31, 0.25); // left post
            holoBox(g, 0.12, 0.5, 0.14, 0.31, 0.25); // right post
            holoBox(g, 0.74, 0.06, 0.15, 0, 0.49); // beam the lantern hangs from
            // roof — flat-topped (trapezoid), not a triangular point
            holoBox(g, 0.94, 0.04, 0.5, 0, 0.55); // wide over-hanging eaves
            holoFrustum(g, 0.24, 0.54, 0.18, 0, 0.62, 4, Math.PI / 4); // broad flat-topped roof
            holoBox(g, 0.42, 0.055, 0.16, 0, 0.72); // flat ridge on top (棟)
            holoBox(g, 0.24, 0.035, 0.14, -0.44, 0.58, -0.5); // up-turned left corner (反り)
            holoBox(g, 0.24, 0.035, 0.14, 0.44, 0.58, 0.5); // up-turned right corner (反り)
            // giant central lantern (提灯), hanging in the passage between posts
            holoCyl(g, 0.055, 0.05, 0, 0.42); // top cap
            holoCyl(g, 0.15, 0.34, 0, 0.24); // lantern body (big)
            holoCyl(g, 0.06, 0.05, 0, 0.06); // bottom cap
          },
        },
        {
          x: 0.7, // pushed out: it sits at the back, so widen to keep even on-screen spacing
          z: -0.8, // back
          build: (g: THREE.Group) => {
            // 新宿モード学園コクーンタワー: a bottom-heavy egg — widest low-down,
            // tapering smoothly up to a rounded (not pointed) top. Cut low enough
            // that the sides curve back inward toward a modest base (not a flat,
            // straight-sided chop). A vertically-stretched sphere.
            holoEgg(g, 0.18, 0.78 * Math.PI, 2.7, 0);
          },
        },
        {
          x: 1.0,
          z: 0.5, // front
          build: (g: THREE.Group) => {
            // 東京駅 (丸の内駅舎), matched to the reference outline: a long
            // 3-storey body; a big central hipped roof (a flat-topped trapezoid)
            // that is the tallest mass, carrying a parapet with two tall thin
            // spires; and two lower outboard dome towers (square tower + small
            // dome + thin finial). Centre-tallest, domes are the lower wings.
            holoBox(g, 0.74, 0.32, 0.2, 0, 0.16); // 3-storey body (narrower, taller — ~2.3:1)
            holoBox(g, 0.78, 0.03, 0.21, 0, 0.33); // cornice band
            // central hipped roof (flat top) — tallest mass, but modest
            holoFrustum(g, 0.14, 0.3, 0.18, 0, 0.44, 4, Math.PI / 4); // base → flat top
            holoBox(g, 0.26, 0.045, 0.14, 0, 0.55); // crenellated parapet
            holoCyl(g, 0.014, 0.13, -0.1, 0.61); // left central spire (tallest)
            holoCyl(g, 0.014, 0.13, 0.1, 0.61); // right central spire
            // two lower outboard dome towers (finials ~ parapet height)
            holoBox(g, 0.09, 0.12, 0.2, -0.3, 0.39); // left tower body
            holoDome(g, 0.05, -0.3, 0.45); // left small dome
            holoCyl(g, 0.012, 0.07, -0.3, 0.51); // left finial
            holoBox(g, 0.09, 0.12, 0.2, 0.3, 0.39); // right tower body
            holoDome(g, 0.05, 0.3, 0.45); // right small dome
            holoCyl(g, 0.012, 0.07, 0.3, 0.51); // right finial
          },
        },
      ];
      const landmarks = lmDefs.map((d) => {
        const g = new THREE.Group();
        g.position.set(d.x, 0, d.z); // base sits on the tabletop
        d.build(g);
        const bs = HOLO_SCALE * ((d as { s?: number }).s ?? 1); // per-landmark size
        g.userData.bs = bs;
        g.scale.set(bs, 0.0001, bs);
        g.visible = false;
        holoGroup.add(g);
        return g;
      });
      // Winding dotted road between each consecutive pair (quadratic arc, side
      // alternating so the route zig-zags). Each stone reveals in sequence.
      const stoneGeo = new THREE.BoxGeometry(0.055, 0.028, 0.055);
      disposables.push(stoneGeo);
      const STONES = 9;
      const roads: InstanceType<typeof THREE.Mesh>[][] = [];
      for (let s = 0; s < lmDefs.length - 1; s++) {
        const a = lmDefs[s];
        const b = lmDefs[s + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const plen = Math.hypot(dx, dz) || 1;
        const px = -dz / plen; // perpendicular in the tabletop plane
        const pz = dx / plen;
        const amp = 0.15 * plen * (s % 2 === 0 ? 1 : -1); // gentle bow on the zig-zag
        const cx = (a.x + b.x) / 2 + px * amp;
        const cz = (a.z + b.z) / 2 + pz * amp;
        const stones: THREE.Mesh[] = [];
        for (let j = 0; j < STONES; j++) {
          const tt = (j + 1) / (STONES + 1); // skip endpoints (under the landmarks)
          const om = 1 - tt;
          const bx = om * om * a.x + 2 * om * tt * cx + tt * tt * b.x;
          const bz = om * om * a.z + 2 * om * tt * cz + tt * tt * b.z;
          const st = new THREE.Mesh(stoneGeo, roadMat);
          st.position.set(bx, 0.005, bz);
          st.scale.setScalar(0.0001);
          st.visible = false;
          holoGroup.add(st);
          stones.push(st);
        }
        roads.push(stones);
      }
      const HOLO_PHASES = landmarks.length * 2 - 1; // L, road, L, road, ..., L
      let holoT = 0; // 0 hidden .. 1 fully revealed; drives the sequential reveal
      let holoFade = 0; // 0 gone .. 1 solid; overall opacity (uniform fade-out on leave)

      // Report the label's projected screen box so the caller can overlay the
      // click/a11y target on just the "Create meeting" area (not the whole
      // table). Camera + sign are static, so this only recomputes on resize.
      const projCenter = new THREE.Vector3();
      const projEdgeX = new THREE.Vector3();
      const projEdgeY = new THREE.Vector3();
      const projectTable = () => {
        if (!containerRef.current) return;
        const w = container.clientWidth || 1;
        const h = container.clientHeight || 1;
        const sx = sign.position.x;
        const sy = signBaseY;
        const sz = sign.position.z;
        projCenter.set(sx, sy, sz).project(camera);
        projEdgeX.set(sx + SIGN_W / 2, sy, sz).project(camera);
        projEdgeY.set(sx, sy + signH / 2, sz).project(camera);
        const cx = (projCenter.x * 0.5 + 0.5) * w;
        const cy = (-projCenter.y * 0.5 + 0.5) * h;
        const ex = (projEdgeX.x * 0.5 + 0.5) * w;
        const ey = (-projEdgeY.y * 0.5 + 0.5) * h;
        const rx = Math.max(8, Math.abs(ex - cx));
        const ry = Math.max(6, Math.abs(ey - cy));
        onTableRef.current?.({ cx, cy, rx, ry });
      };
      projectTable();

      if (prefersReducedMotion || FREEZE) {
        // Static, front-facing pose for inspection.
        characters.forEach((c, i) => {
          c.group.position.set(CHARACTERS[i].x, 0, 1);
          c.body.rotation.x = 0;
        });
        render();
      } else {
        const start = performance.now();
        let last = start;
        const loop = () => {
          if (disposed) return;
          const now = performance.now();
          const dt = Math.min((now - last) / 1000, 0.05);
          const t = (now - start) / 1000;
          last = now;
          if (!document.hidden) {
            characters.forEach((char, i) => {
              const { group, body, blinkFills, flagMats, phase } = char;

              // All styles share the same flow: travel from the back toward the
              // viewer and recycle off the front.
              group.position.z += SPEED * dt;
              if (group.position.z > Z_END) {
                group.position.z = Z_START;
                recycleCount += 1;
                if (recycleCount % LANES.length === 1) perm = derangePerm(perm);
                group.position.x = LANES[perm[i]];
                // Fresh pose + a new random roll style for this appearance, and
                // re-roll the rare rainbow.
                body.rotation.set(0, 0, 0);
                char.style = pickStyle();
                const rb = pickRainbow();
                char.rainbowMats.forEach((m) => (m.uniforms.uRainbow.value = rb));
              }

              // Animate the rainbow shimmer only while it is active.
              if (char.rainbowMats[0].uniforms.uRainbow.value > 0.5) {
                char.rainbowMats.forEach((m) => (m.uniforms.uTime.value = t));
              }

              // While over the table (only the centre lane gets close enough),
              // rest ON the tabletop. Each style sets its spin and a
              // non-negative hop; then we measure how deep the body reaches
              // under its CURRENT rotation and lift it so that deepest point
              // sits exactly on the surface — never clipping into the table.
              const rdx = group.position.x - TABLE_X;
              const rdz = group.position.z - TABLE_Z;
              const rDist = Math.sqrt(rdx * rdx + rdz * rdz);
              // Fully up over the whole tabletop (rDist <= TABLE_R); the climb
              // up/down happens in a ring just OUTSIDE the rim, so the body is
              // never partway down while still over the table (no clipping).
              const onT = Math.max(0, Math.min(1, (TABLE_R + RIDE_RAMP - rDist) / RIDE_RAMP));

              let hop;
              if (char.style === 1) {
                // Barrel roll: spins about the travel axis like a face-on wheel.
                hop = Math.abs(Math.sin(t * HOP_FREQ + phase)) * HOP_AMP * 0.6;
                group.rotation.z = 0;
                body.rotation.z += ROLL * dt;
              } else if (char.style === 2) {
                // Turn & float: gentle UPWARD bob (never dips below the table).
                hop = (0.5 + 0.5 * Math.sin(t * 1.6 + phase)) * 0.28;
                group.rotation.z = WADDLE * 0.5 * Math.sin(t * WADDLE_FREQ + phase);
                body.rotation.y += ROLL * 0.9 * dt;
              } else {
                // Forward roll (default): the classic tumble toward the viewer.
                hop = Math.abs(Math.sin(t * HOP_FREQ + phase)) * HOP_AMP;
                group.rotation.z = WADDLE * Math.sin(t * WADDLE_FREQ + phase);
                body.rotation.x += ROLL * dt;
              }

              // Deepest reach of the body under its current world rotation
              // (body roll + group waddle). Sphere is rotation-invariant.
              let clearance = char.roundR;
              if (clearance === 0) {
                let minY = Infinity;
                for (let k = 0; k < char.lowPts.length; k++) {
                  lowTmp
                    .copy(char.lowPts[k])
                    .applyEuler(body.rotation)
                    .applyEuler(group.rotation);
                  if (lowTmp.y < minY) minY = lowTmp.y;
                }
                clearance = -minY;
              }
              const rideY = TABLE_TOP + clearance;
              const groundY = BASE_Y + (rideY - BASE_Y) * (onT * onT * (3 - 2 * onT));
              group.position.y = groundY + hop;

              // Blink (all styles): the iris-colored lid fills top→bottom and back.
              const cycle = (t + phase * 2) % BLINK_PERIOD;
              const cover = cycle < BLINK_DUR ? Math.sin((cycle / BLINK_DUR) * Math.PI) : 0;
              blinkFills.forEach((m) => (m.uniforms.uFill.value = cover));

              // Flag flex: bend when the pole's tip presses into the "ground".
              // Uses the tip's true world height, so it works for any roll axis.
              // For the barrel roll (style 1, spins face-on) the flag curls
              // sideways within the spin plane; otherwise it curls backward.
              body.updateWorldMatrix(true, false);
              tipTmp.set(0, CHARACTERS[i].headTop + 0.9, -0.05).applyMatrix4(body.matrixWorld);
              const bend =
                tipTmp.y < GROUND_Y ? Math.min((GROUND_Y - tipTmp.y) * BEND_K, BEND_MAX) : 0;
              const bendSide = char.style === 1 ? 1 : 0;
              flagMats.forEach((m) => {
                m.uniforms.uBend.value = bend;
                m.uniforms.uBendSide.value = bendSide;
              });
            });

            // Hover feedback: ease the label up just a little while active.
            const liftTarget = pressedRef.current ? 0.06 : 0;
            signLift += (liftTarget - signLift) * Math.min(1, dt * 14);
            sign.position.y = signBaseY + signLift;

            // Tour-destination hologram. Appear (hover): reveal building →
            // road grows → next building → ... sequentially. Disappear (leave):
            // the whole thing just dissolves/fades out together with the
            // projector light — NOT a reverse right-to-left retract.
            if (pressedRef.current) {
              holoT += (1 - holoT) * Math.min(1, dt * 2.5); // sequential reveal
              holoFade += (1 - holoFade) * Math.min(1, dt * 5); // opacity up to full quickly
            } else {
              holoFade += (0 - holoFade) * Math.min(1, dt * 3.5); // fade the whole hologram out
              if (holoFade < 0.02) holoT = 0; // once gone, reset so it re-reveals next hover
            }
            holoMat.uniforms.uTime.value = t; // faint cyan accent shimmer
            roadMat.uniforms.uTime.value = t; // full iridescent road shimmer
            holoMat.uniforms.uFade.value = holoFade;
            roadMat.uniforms.uFade.value = holoFade;
            beamMat.uniforms.uOpacity.value = holoT * holoFade * 0.3; // beam ramps with reveal, fades on leave
            const holoSpan = HOLO_PHASES + 1; // so the last phase fully completes
            for (let li = 0; li < landmarks.length; li++) {
              const rev = Math.max(0, Math.min(1, holoT * holoSpan - li * 2)); // phase 2i
              const e = rev * rev * (3 - 2 * rev); // smoothstep rise
              landmarks[li].visible = e > 0.002;
              landmarks[li].scale.y = Math.max(0.0001, e * landmarks[li].userData.bs);
            }
            for (let s = 0; s < roads.length; s++) {
              const roadRev = Math.max(0, Math.min(1, holoT * holoSpan - (s * 2 + 1))); // phase 2s+1
              const stones = roads[s];
              for (let j = 0; j < stones.length; j++) {
                const sr = Math.max(0, Math.min(1, roadRev * stones.length - j));
                const e = sr * sr * (3 - 2 * sr);
                stones[j].visible = e > 0.002;
                stones[j].scale.setScalar(Math.max(0.0001, e));
              }
            }

            render();
          }
          raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
      }

      const onResize = () => {
        if (!containerRef.current) return;
        const w = container.clientWidth || 1;
        const h = container.clientHeight || 1;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        projectTable();
        if (prefersReducedMotion || FREEZE) render();
      };
      const resizeObserver = new ResizeObserver(onResize);
      resizeObserver.observe(container);

      cleanup = () => {
        cancelAnimationFrame(raf);
        resizeObserver.disconnect();
        themeObserver.disconnect();
        disposables.forEach((d) => d.dispose());
        renderer.dispose();
        renderer.domElement.parentNode?.removeChild(renderer.domElement);
      };
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  return <div ref={containerRef} className={className} aria-hidden="true" />;
}
