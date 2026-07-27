(function () {
  // Looping step-based animations for the Meeting workflow page.
  // Each demo is a timeline of steps applied to a small stage of actors.
  //
  // Step fields:
  //   active:  actor id or array of ids highlighted as the current speaker(s)
  //   dim:     array of actor ids rendered semi-transparent
  //   bubbles: {actorId: {type, text}} — full bubble state for this step
  //            (types: propose, satisfied, pass, accept, reject, score)
  //   arrow:   [fromId, toId] — curved arrow between two actors
  //   phase:   "conversation" | "voting" — updates the phase badge
  //   label:   caption below the stage
  //   result:  "accept" | "reject" — colors the caption
  //   ms:      duration override for this step

  var STEP_MS = 1500;

  // ---------------------------------------------------------------------
  // Pixel-art dot characters — a vanilla port of the GUI's CharacterAvatar
  // sprite generator (frontend/src/components/CharacterAvatar.tsx), so the
  // demos show the same characters as the app.
  // ---------------------------------------------------------------------
  var G = 24;
  var BLUSH = "#FF9EB5";
  var WHITE = "#FFFFFF";
  var PUPIL = "#2A2F3A";
  var POLE = "#9AA3B2";

  var PALETTES = [
    { body: "#7FB2F0", dark: "#3F6DBF" }, // blue
    { body: "#7FD99B", dark: "#3E9E63" }, // green
    { body: "#F2A5D0", dark: "#C25E9C" }, // pink
    { body: "#B79BF0", dark: "#7E5FBF" }, // purple
    { body: "#F5C97A", dark: "#C2903E" }, // amber
    { body: "#7FD5D9", dark: "#3E9EA3" }, // teal
  ];

  // Sprites for the recurring cast of the demos
  var CAST = {
    A: { shape: "circle", palette: 0, face: 0 },
    B: { shape: "square", palette: 1, face: 1 },
    C: { shape: "triangle", palette: 2, face: 3 },
    F: { shape: "circle", palette: 3, face: 4 },
  };

  function inCircle(x, y) {
    var dx = (x + 0.5 - 12) / 9;
    var dy = (y + 0.5 - 15) / 7;
    return dx * dx + dy * dy <= 1;
  }

  function inSquare(x, y) {
    if (x < 4 || x > 19 || y < 8 || y > 21) {
      return false;
    }
    var corner = (x < 7 || x > 16) && (y < 11 || y > 18);
    if (corner) {
      var rx = x < 11.5 ? 6 : 17;
      var ry = y < 15.5 ? 10 : 19;
      if ((x - rx) * (x - rx) + (y - ry) * (y - ry) > 9) {
        return false;
      }
    }
    return true;
  }

  function inTriangle(x, y) {
    if (y < 8 || y > 21) {
      return false;
    }
    var t = (y - 8) / 13;
    var hw = 1.2 + t * 9.5;
    return Math.abs(x + 0.5 - 12) <= hw;
  }

  function silhouetteFn(shape) {
    return shape === "circle" ? inCircle : shape === "square" ? inSquare : inTriangle;
  }

  function paintFace(px, shape, face) {
    var ey = shape === "triangle" ? 17 : 14;
    var dx = shape === "triangle" ? 2 : 3;
    var exs = [12 - dx, 12 + dx];

    function set(x, y, c) {
      if (x >= 0 && x < G && y >= 0 && y < G) {
        px[y][x] = c;
      }
    }
    function roundEye(cx, dir) {
      for (var ox = -1; ox <= 1; ox++) {
        for (var oy = -1; oy <= 2; oy++) {
          set(cx + ox, ey + oy, WHITE);
        }
      }
      set(cx + dir, ey, PUPIL);
      set(cx + dir, ey + 1, PUPIL);
    }
    function bigDot(cx) {
      for (var ox = 0; ox <= 1; ox++) {
        for (var oy = 0; oy <= 1; oy++) {
          set(cx + ox, ey + oy, PUPIL);
        }
      }
    }
    function caret(cx) {
      set(cx - 1, ey + 1, PUPIL);
      set(cx, ey, PUPIL);
      set(cx + 1, ey + 1, PUPIL);
    }
    function line(cx) {
      for (var ox = -1; ox <= 1; ox++) {
        set(cx + ox, ey, PUPIL);
      }
    }
    function blush(cx, side) {
      set(cx + side * 2, ey + 2, BLUSH);
      set(cx + side * 2 + (side > 0 ? 1 : -1), ey + 2, BLUSH);
      set(cx + side * 2, ey + 3, BLUSH);
    }

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

  function paintFlag(px, body, dark) {
    var poleX = 11;
    for (var y = 1; y <= 7; y++) {
      px[y][poleX] = POLE;
    }
    var penn = [
      [12, 2, 1],
      [12, 3, 2],
      [12, 4, 3],
      [12, 5, 2],
      [12, 6, 1],
    ];
    penn.forEach(function (row) {
      for (var i = 0; i < row[2]; i++) {
        px[row[1]][row[0] + i] = body;
      }
    });
    px[1][12] = dark;
    px[2][13] = dark;
    px[3][14] = dark;
    px[4][15] = dark;
    px[5][14] = dark;
    px[6][13] = dark;
  }

  var spriteCache = {};

  function spriteSvg(spec) {
    var key = spec.shape + "-" + spec.palette + "-" + spec.face;
    if (spriteCache[key]) {
      return spriteCache[key];
    }

    var pal = PALETTES[spec.palette] || PALETTES[0];
    var inside = silhouetteFn(spec.shape);
    var fill = [];
    var px = [];
    var x, y;
    for (y = 0; y < G; y++) {
      fill.push([]);
      px.push([]);
      for (x = 0; x < G; x++) {
        fill[y][x] = inside(x, y);
        px[y][x] = null;
      }
    }
    for (y = 0; y < G; y++) {
      for (x = 0; x < G; x++) {
        if (fill[y][x]) {
          px[y][x] = pal.body;
        }
      }
    }
    // 1px outline around the silhouette
    var neighbors = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (y = 0; y < G; y++) {
      for (x = 0; x < G; x++) {
        if (fill[y][x]) {
          continue;
        }
        for (var k = 0; k < neighbors.length; k++) {
          var nx = x + neighbors[k][0];
          var ny = y + neighbors[k][1];
          if (nx >= 0 && nx < G && ny >= 0 && ny < G && fill[ny][nx]) {
            px[y][x] = pal.dark;
            break;
          }
        }
      }
    }
    paintFace(px, spec.shape, spec.face);
    paintFlag(px, pal.body, pal.dark);

    // Run-length-encode rows into rects
    var rects = "";
    for (y = 0; y < G; y++) {
      x = 0;
      while (x < G) {
        var c = px[y][x];
        if (c === null) {
          x++;
          continue;
        }
        var w = 1;
        while (x + w < G && px[y][x + w] === c) {
          w++;
        }
        rects += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="1" fill="' + c + '"></rect>';
        x += w;
      }
    }

    var svg =
      '<svg viewBox="0 0 24 24" shape-rendering="crispEdges" aria-hidden="true">' + rects + "</svg>";
    spriteCache[key] = svg;
    return svg;
  }

  var ACCEPT = { type: "accept", text: "✓ accept" };
  var REJECT = { type: "reject", text: "✗ reject" };
  var SATISFIED = { type: "satisfied", text: "satisfied" };

  function score(n) {
    return { type: "score", text: String(n) };
  }

  var DEMOS = {
    phases: {
      actors: [{ id: "A" }, { id: "B" }, { id: "C" }],
      steps: [
        { phase: "conversation", active: "A", label: "A takes their turn (search, ask, …)" },
        { phase: "conversation", active: "B", bubbles: { B: { type: "propose", text: "propose" } }, label: "B proposes a new itinerary" },
        { phase: "voting", active: "C", bubbles: { C: ACCEPT }, label: "All participants except B vote" },
        { phase: "voting", active: "A", bubbles: { C: ACCEPT, A: ACCEPT }, label: "All participants except B vote" },
        { phase: "voting", bubbles: { C: ACCEPT, A: ACCEPT }, label: "Accepted — the current itinerary is replaced", result: "accept", ms: 2100 },
        { phase: "conversation", active: "C", label: "Back to the conversation phase" },
        { phase: "conversation", active: "A", bubbles: { A: SATISFIED }, label: "A is satisfied with the current itinerary" },
        { phase: "conversation", active: "B", bubbles: { A: SATISFIED, B: SATISFIED }, label: "B is satisfied, too" },
        { phase: "conversation", active: "C", bubbles: { A: SATISFIED, B: SATISFIED, C: SATISFIED }, label: "C is satisfied, too" },
        { phase: "conversation", bubbles: { A: SATISFIED, B: SATISFIED, C: SATISFIED }, label: "Consensus reached — the meeting concludes", result: "accept", ms: 2400 },
      ],
    },

    "round-robin": {
      actors: [{ id: "A" }, { id: "B" }, { id: "C" }],
      steps: [
        { active: "A", label: "Turn 1: A" },
        { active: "B", arrow: ["A", "B"], label: "Turn 2: B" },
        { active: "C", arrow: ["B", "C"], label: "Turn 3: C" },
        { active: "A", arrow: ["C", "A"], label: "Turn 4: back to A" },
        { active: "B", arrow: ["A", "B"], label: "Turn 5: B …" },
      ],
    },

    random: {
      actors: [{ id: "A" }, { id: "B" }, { id: "C" }],
      steps: [
        { active: "B", label: "Turn 1: B is picked at random" },
        { active: "A", label: "Turn 2: A is picked at random" },
        { active: "C", label: "Turn 3: C is picked at random" },
        { active: "A", label: "Turn 4: A is picked at random …" },
      ],
    },

    inviting: {
      actors: [{ id: "A" }, { id: "B" }, { id: "C" }],
      steps: [
        { active: "A", label: "A speaks" },
        { active: "A", arrow: ["A", "C"], label: "A invites C to speak next" },
        { active: "C", label: "C speaks" },
        { active: "C", arrow: ["C", "B"], label: "C invites B to speak next" },
        { active: "B", label: "B speaks …" },
      ],
    },

    facilitating: {
      actors: [{ id: "F", tag: "facilitator" }, { id: "A" }, { id: "B" }, { id: "C" }],
      steps: [
        { active: "A", label: "A speaks" },
        { active: "F", label: "The facilitator takes a turn" },
        { active: "F", arrow: ["F", "C"], label: "… and picks the next speaker" },
        { active: "C", label: "C speaks" },
        { active: "F", arrow: ["F", "B"], label: "The facilitator picks again …" },
        { active: "B", label: "B speaks …" },
      ],
    },

    parallel: {
      actors: [{ id: "A" }, { id: "B" }, { id: "C" }],
      steps: [
        { phase: "voting", label: "An itinerary has been proposed" },
        { phase: "voting", active: ["A", "B", "C"], bubbles: { A: ACCEPT, B: REJECT, C: ACCEPT }, label: "All participants vote at the same time", ms: 2400 },
      ],
    },

    balancing: {
      actors: [{ id: "A" }, { id: "B" }, { id: "C" }],
      steps: [
        { active: "B", label: "Cycle 1: B speaks" },
        { active: "A", label: "Cycle 1: A speaks" },
        { active: "C", label: "Cycle 1: C speaks — everyone spoke once" },
        { active: "A", label: "Cycle 2: A speaks" },
        { active: "C", label: "Cycle 2: C speaks …" },
      ],
    },

    volunteer: {
      actors: [{ id: "A" }, { id: "B" }, { id: "C" }],
      steps: [
        { active: "A", label: "A speaks" },
        { dim: ["B"], bubbles: { B: { type: "pass", text: "pass" } }, label: "B has nothing to add and passes" },
        { active: "C", dim: ["B"], label: "C speaks …" },
      ],
    },

    majority: {
      actors: [{ id: "A" }, { id: "B" }, { id: "C" }],
      steps: [
        { phase: "voting", active: "A", bubbles: { A: ACCEPT }, label: "A votes" },
        { phase: "voting", active: "B", bubbles: { A: ACCEPT, B: REJECT }, label: "B votes" },
        { phase: "voting", active: "C", bubbles: { A: ACCEPT, B: REJECT, C: ACCEPT }, label: "C votes" },
        { phase: "voting", bubbles: { A: ACCEPT, B: REJECT, C: ACCEPT }, label: "2 of 3 accept — the proposal is adopted", result: "accept", ms: 2400 },
      ],
    },

    unanimous: {
      actors: [{ id: "A" }, { id: "B" }, { id: "C" }],
      steps: [
        { phase: "voting", active: "A", bubbles: { A: ACCEPT }, label: "A votes" },
        { phase: "voting", active: "B", bubbles: { A: ACCEPT, B: REJECT }, label: "B votes" },
        { phase: "voting", active: "C", bubbles: { A: ACCEPT, B: REJECT, C: ACCEPT }, label: "C votes" },
        { phase: "voting", bubbles: { A: ACCEPT, B: REJECT, C: ACCEPT }, label: "Not unanimous — the proposal is rejected", result: "reject", ms: 2400 },
      ],
    },

    "single-decider": {
      actors: [{ id: "A" }, { id: "B", tag: "decider" }, { id: "C" }],
      steps: [
        { phase: "voting", dim: ["A", "C"], label: "Only the designated decider votes" },
        { phase: "voting", active: "B", dim: ["A", "C"], bubbles: { B: ACCEPT }, label: "B accepts the proposal" },
        { phase: "voting", dim: ["A", "C"], bubbles: { B: ACCEPT }, label: "The proposal is adopted", result: "accept", ms: 2100 },
      ],
    },

    "most-pleasure": {
      actors: [{ id: "A" }, { id: "B" }, { id: "C" }],
      steps: [
        { phase: "voting", active: "A", bubbles: { A: score(7) }, label: "A scores the proposal" },
        { phase: "voting", active: "B", bubbles: { A: score(7), B: score(4) }, label: "B scores the proposal" },
        { phase: "voting", active: "C", bubbles: { A: score(7), B: score(4), C: score(6) }, label: "C scores the proposal" },
        { phase: "voting", bubbles: { A: score(7), B: score(4), C: score(6) }, label: "Sum 17 ≥ current itinerary's 15 — adopted", result: "accept", ms: 2600 },
      ],
    },

    "least-misery": {
      actors: [{ id: "A" }, { id: "B" }, { id: "C" }],
      steps: [
        { phase: "voting", active: "A", bubbles: { A: score(7) }, label: "A scores the proposal" },
        { phase: "voting", active: "B", bubbles: { A: score(7), B: score(4) }, label: "B scores the proposal" },
        { phase: "voting", active: "C", bubbles: { A: score(7), B: score(4), C: score(6) }, label: "C scores the proposal" },
        { phase: "voting", bubbles: { A: score(7), B: score(4), C: score(6) }, label: "Min 4 < current itinerary's 5 — rejected", result: "reject", ms: 2600 },
      ],
    },
  };

  var demoCounter = 0;

  function build(root, cfg) {
    var n = demoCounter++;
    var html = '<span class="flow-demo__phase" hidden></span>';
    html += '<div class="flow-demo__stage">';
    cfg.actors.forEach(function (actor) {
      var spec = actor.sprite || CAST[actor.id] || CAST.A;
      html +=
        '<div class="flow-actor" data-actor="' + actor.id + '">' +
        '<span class="flow-actor__bubble"></span>' +
        '<span class="flow-actor__sprite">' + spriteSvg(spec) + "</span>" +
        '<span class="flow-actor__name">' + actor.id + "</span>" +
        '<span class="flow-actor__tag">' + (actor.tag || "") + "</span>" +
        "</div>";
    });
    html += "</div>";
    html +=
      '<svg class="flow-demo__arrows" aria-hidden="true">' +
      "<defs>" +
      '<marker id="flow-arrowhead-' + n + '" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">' +
      '<path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"></path>' +
      "</marker>" +
      "</defs>" +
      '<path class="flow-demo__arrow-path" fill="none" marker-end="url(#flow-arrowhead-' + n + ')"></path>' +
      "</svg>";
    html += '<p class="flow-demo__label"></p>';
    root.innerHTML = html;
  }

  function drawArrow(root, fromId, toId) {
    var path = root.querySelector(".flow-demo__arrow-path");
    if (!fromId || !toId) {
      path.removeAttribute("d");
      return;
    }
    var from = root.querySelector('[data-actor="' + fromId + '"] .flow-actor__sprite');
    var to = root.querySelector('[data-actor="' + toId + '"] .flow-actor__sprite');
    if (!from || !to) {
      path.removeAttribute("d");
      return;
    }
    var rootRect = root.getBoundingClientRect();
    var a = from.getBoundingClientRect();
    var b = to.getBoundingClientRect();
    var x1 = a.left + a.width / 2 - rootRect.left;
    var x2 = b.left + b.width / 2 - rootRect.left;
    var y = a.top - rootRect.top - 8;
    var mid = (x1 + x2) / 2;
    var lift = Math.min(30, Math.abs(x2 - x1) * 0.35) + 12;
    path.setAttribute("d", "M " + x1 + " " + y + " Q " + mid + " " + (y - lift) + " " + x2 + " " + y);
  }

  function apply(root, cfg, step) {
    var active = step.active ? [].concat(step.active) : [];
    var dim = step.dim || [];
    var bubbles = step.bubbles || {};

    cfg.actors.forEach(function (actor) {
      var el = root.querySelector('[data-actor="' + actor.id + '"]');
      var isActive = active.indexOf(actor.id) !== -1;
      el.classList.toggle("is-active", isActive);
      el.classList.toggle("is-dim", dim.indexOf(actor.id) !== -1);

      var bubble = el.querySelector(".flow-actor__bubble");
      var spec = bubbles[actor.id];
      // Active speakers with no explicit bubble get animated speech dots
      // (suppressed on arrow steps so the bubble doesn't collide with it)
      var speech = !spec && isActive && !step.arrow && step.speech !== false;
      var sig = spec ? spec.type + "|" + spec.text : speech ? "speech" : "";
      if (bubble.dataset.sig !== sig) {
        bubble.dataset.sig = sig;
        bubble.className = "flow-actor__bubble";
        bubble.textContent = "";
        if (spec) {
          bubble.textContent = spec.text;
          bubble.classList.add("is-visible", "flow-actor__bubble--" + spec.type);
        } else if (speech) {
          bubble.innerHTML = "<i></i><i></i><i></i>";
          bubble.classList.add("is-visible", "flow-actor__bubble--speech");
        }
      }
    });

    var arrow = step.arrow || [];
    drawArrow(root, arrow[0], arrow[1]);

    var phaseEl = root.querySelector(".flow-demo__phase");
    if (step.phase) {
      phaseEl.hidden = false;
      phaseEl.textContent = step.phase === "voting" ? "Voting phase" : "Conversation phase";
      phaseEl.className = "flow-demo__phase flow-demo__phase--" + step.phase;
    } else if (!cfg.keepPhase) {
      phaseEl.hidden = true;
    }

    var label = root.querySelector(".flow-demo__label");
    label.textContent = step.label || "";
    label.className = "flow-demo__label" + (step.result ? " flow-demo__label--" + step.result : "");
  }

  function start(root, cfg) {
    var index = 0;
    var timer = null;

    function tick() {
      var step = cfg.steps[index];
      apply(root, cfg, step);
      index = (index + 1) % cfg.steps.length;
      timer = window.setTimeout(tick, step.ms || STEP_MS);
    }

    function stop() {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    }

    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      apply(root, cfg, cfg.steps[0]);
      return;
    }

    // Animate only while the demo is on screen
    if ("IntersectionObserver" in window) {
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            if (timer === null) {
              tick();
            }
          } else {
            stop();
          }
        });
      }, { threshold: 0.2 });
      observer.observe(root);
      apply(root, cfg, cfg.steps[0]);
    } else {
      tick();
    }
  }

  function init() {
    var roots = document.querySelectorAll("[data-demo]");
    Array.prototype.forEach.call(roots, function (root) {
      var cfg = DEMOS[root.dataset.demo];
      if (!cfg) {
        return;
      }
      try {
        build(root, cfg);
        start(root, cfg);
      } catch (e) {
        if (window.console && console.error) {
          console.error(e);
        }
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
