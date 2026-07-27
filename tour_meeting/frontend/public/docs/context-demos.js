(function () {
  // Looping animations for the Context compaction section: each demo is a
  // vertical stack of context blocks that grows, gets compacted, and keeps
  // growing. The stack fades out before the loop restarts.
  //
  // Step fields:
  //   shown:   ids of initially-hidden blocks revealed (appended turns, the
  //            inserted summary, ...) — full state per step
  //   marked:  ids outlined as "about to be compacted"
  //   removed: ids collapsed out of the stack
  //   halved:  ids clipped to their bottom half (token-based truncation)
  //   fade:    true to fade the whole stack out (loop boundary)
  //   label:   caption below the stack
  //   meter:   optional text badge (e.g. token usage)
  //   ms:      duration override for this step

  var STEP_MS = 1800;

  var DEMOS = {
    summarization: {
      items: [
        { id: "sys", label: "System prompt", cls: "system" },
        { id: "sum", label: "Summary of turns 1–3", cls: "summary", hidden: true },
        { id: "t1", label: "Turn 1" },
        { id: "t2", label: "Turn 2" },
        { id: "t3", label: "Turn 3" },
        { id: "t4", label: "Turn 4", hidden: true },
        { id: "t5", label: "Turn 5", hidden: true },
        { id: "t6", label: "Turn 6", hidden: true },
        { id: "t7", label: "Turn 7", hidden: true },
      ],
      steps: [
        { label: "The memory grows as the meeting proceeds" },
        { shown: ["t4"], label: "A new turn is appended" },
        { shown: ["t4", "t5"], label: "…and another one" },
        { shown: ["t4", "t5"], marked: ["t1", "t2", "t3"], label: "Older turns are summarized…" },
        { shown: ["t4", "t5", "sum"], removed: ["t1", "t2", "t3"], label: "…and replaced with a summary after the system prompt" },
        { shown: ["t4", "t5", "sum", "t6"], removed: ["t1", "t2", "t3"], label: "The meeting continues on the compacted memory" },
        { shown: ["t4", "t5", "sum", "t6", "t7"], removed: ["t1", "t2", "t3"], label: "…and the memory keeps growing" },
        { shown: ["t4", "t5", "sum", "t6", "t7"], removed: ["t1", "t2", "t3"], fade: true, label: "", ms: 800 },
      ],
    },

    "turn-window": {
      items: [
        { id: "sys", label: "System prompt", cls: "system" },
        { id: "t1", label: "Turn 1" },
        { id: "t2", label: "Turn 2" },
        { id: "t3", label: "Turn 3" },
        { id: "t4", label: "Turn 4" },
        { id: "t5", label: "Turn 5", hidden: true },
        { id: "t6", label: "Turn 6", hidden: true },
        { id: "t7", label: "Turn 7", hidden: true },
        { id: "t8", label: "Turn 8", hidden: true },
        { id: "t9", label: "Turn 9", hidden: true },
        { id: "t10", label: "Turn 10", hidden: true },
      ],
      steps: [
        { label: "The window keeps the most recent turns (window = 4)" },
        { shown: ["t5"], removed: ["t1"], label: "Turn 5 arrives — Turn 1 slides out" },
        { shown: ["t5", "t6"], removed: ["t1", "t2"], label: "Turn 6 arrives — Turn 2 slides out" },
        { shown: ["t5", "t6", "t7"], removed: ["t1", "t2", "t3"], label: "Turn 7 arrives — Turn 3 slides out" },
        { shown: ["t5", "t6", "t7", "t8"], removed: ["t1", "t2", "t3", "t4"], label: "Turn 8 arrives — Turn 4 slides out" },
        { shown: ["t5", "t6", "t7", "t8", "t9"], removed: ["t1", "t2", "t3", "t4", "t5"], label: "Turn 9 arrives — Turn 5 slides out" },
        { shown: ["t5", "t6", "t7", "t8", "t9", "t10"], removed: ["t1", "t2", "t3", "t4", "t5", "t6"], label: "Turn 10 arrives — Turn 6 slides out" },
        { shown: ["t5", "t6", "t7", "t8", "t9", "t10"], removed: ["t1", "t2", "t3", "t4", "t5", "t6"], fade: true, label: "", ms: 800 },
      ],
    },

    "token-based": {
      items: [
        { id: "sys", label: "System prompt", cls: "system" },
        { id: "t1", label: "Turn 1" },
        { id: "t2", label: "Turn 2" },
        { id: "t3", label: "Turn 3" },
        { id: "t4", label: "Turn 4", hidden: true },
        { id: "t5", label: "Turn 5", hidden: true },
        { id: "t6", label: "Turn 6", hidden: true },
      ],
      steps: [
        { label: "The context approaches the token budget" },
        { shown: ["t4"], label: "A new turn pushes it over the budget" },
        { shown: ["t4"], marked: ["t1", "t2"], label: "The oldest tokens fall outside the budget…" },
        { shown: ["t4"], removed: ["t1"], halved: ["t2"], label: "…and are cut off — even mid-turn" },
        { shown: ["t4", "t5"], removed: ["t1"], halved: ["t2"], label: "The meeting continues on the truncated memory" },
        { shown: ["t4", "t5", "t6"], removed: ["t1"], halved: ["t2"], label: "…until the budget is exceeded again" },
        { shown: ["t4", "t5", "t6"], removed: ["t1", "t2"], halved: ["t3"], label: "The truncation then fires again" },
        { shown: ["t4", "t5", "t6"], removed: ["t1", "t2"], halved: ["t3"], fade: true, label: "", ms: 800 },
      ],
    },
  };

  function build(root, cfg) {
    var html = '<span class="ctx-demo__meter" hidden></span>';
    html += '<div class="ctx-demo__stack">';
    cfg.items.forEach(function (item) {
      html +=
        '<div class="ctx-demo__box' +
        (item.cls ? " ctx-demo__box--" + item.cls : "") +
        (item.hidden ? " is-hidden" : "") +
        '" data-ctx-box="' + item.id + '">' +
        item.label +
        "</div>";
    });
    html += "</div>";
    html += '<p class="ctx-demo__label"></p>';
    root.innerHTML = html;

    // Compute the tallest state the stack ever reaches during the steps
    // (visible = not removed, and either initially visible or revealed) so
    // the card can reserve exactly that height and never resize.
    var maxCount = 0;
    cfg.steps.forEach(function (step) {
      var shown = step.shown || [];
      var removed = step.removed || [];
      var count = 0;
      cfg.items.forEach(function (item) {
        var visible = !item.hidden || shown.indexOf(item.id) !== -1;
        if (visible && removed.indexOf(item.id) === -1) {
          count += 1;
        }
      });
      maxCount = Math.max(maxCount, count);
    });

    var stack = root.querySelector(".ctx-demo__stack");
    var box = stack.querySelector(".ctx-demo__box:not(.is-hidden)");
    var boxHeight = box ? box.offsetHeight : 32;
    return maxCount * boxHeight + (maxCount - 1) * 8;
  }

  function apply(root, cfg, step) {
    var shown = step.shown || [];
    var marked = step.marked || [];
    var removed = step.removed || [];
    var halved = step.halved || [];

    cfg.items.forEach(function (item) {
      var el = root.querySelector('[data-ctx-box="' + item.id + '"]');
      el.classList.toggle("is-marked", marked.indexOf(item.id) !== -1);
      el.classList.toggle("is-removed", removed.indexOf(item.id) !== -1);
      el.classList.toggle("is-halved", halved.indexOf(item.id) !== -1);
      if (item.hidden) {
        el.classList.toggle("is-hidden", shown.indexOf(item.id) === -1);
      }
    });

    root.querySelector(".ctx-demo__stack").classList.toggle("is-faded", !!step.fade);

    var meter = root.querySelector(".ctx-demo__meter");
    if (step.meter) {
      meter.hidden = false;
      meter.textContent = step.meter;
    } else {
      meter.hidden = true;
    }

    root.querySelector(".ctx-demo__label").textContent = step.label || "";
  }

  function start(root, cfg) {
    var index = 0;
    var timer = null;

    function tick() {
      var step = cfg.steps[index];
      var prev = cfg.steps[(index - 1 + cfg.steps.length) % cfg.steps.length];

      if (prev.fade) {
        // Coming out of the loop-boundary fade: reset the block layout
        // instantly while still invisible, then only fade back in —
        // otherwise the blocks would be seen sliding into place.
        var stack = root.querySelector(".ctx-demo__stack");
        var boxes = stack.querySelectorAll(".ctx-demo__box");
        Array.prototype.forEach.call(boxes, function (box) {
          box.style.transition = "none";
        });
        apply(root, cfg, step);
        stack.classList.add("is-faded");
        void stack.offsetWidth;
        Array.prototype.forEach.call(boxes, function (box) {
          box.style.transition = "";
        });
        stack.classList.remove("is-faded");
      } else {
        apply(root, cfg, step);
      }

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
      apply(root, cfg, cfg.steps[cfg.steps.length - 2]);
      return;
    }

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
    var roots = document.querySelectorAll("[data-ctx-demo]");
    var built = [];
    var maxHeight = 0;

    Array.prototype.forEach.call(roots, function (root) {
      var cfg = DEMOS[root.dataset.ctxDemo];
      if (!cfg) {
        return;
      }
      try {
        var height = build(root, cfg);
        maxHeight = Math.max(maxHeight, height);
        built.push({ root: root, cfg: cfg });
      } catch (e) {
        if (window.console && console.error) {
          console.error(e);
        }
      }
    });

    // Reserve the same (tallest) stack height on every demo so the stacks
    // start at the same vertical position across neighboring cards.
    built.forEach(function (entry) {
      entry.root.querySelector(".ctx-demo__stack").style.minHeight = maxHeight + "px";
      try {
        start(entry.root, entry.cfg);
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
