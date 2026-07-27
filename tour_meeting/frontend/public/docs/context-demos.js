(function () {
  // Looping animations for the Context compaction section: each demo is a
  // vertical stack of context blocks that gets compacted step by step.
  //
  // Step fields:
  //   marked:  ids outlined as "about to be compacted"
  //   removed: ids collapsed out of the stack
  //   shown:   ids revealed (e.g. the inserted summary block)
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
        { id: "t4", label: "Turn 4" },
        { id: "cur", label: "Current turn", cls: "current" },
      ],
      steps: [
        { label: "The memory grows as the meeting proceeds" },
        { marked: ["t1", "t2", "t3"], label: "A specified portion is summarized…" },
        { removed: ["t1", "t2", "t3"], shown: ["sum"], label: "…and replaced with a summary after the system prompt" },
        { removed: ["t1", "t2", "t3"], shown: ["sum"], label: "Recent turns are kept in their original form", ms: 2400 },
      ],
    },

    "turn-window": {
      items: [
        { id: "sys", label: "System prompt", cls: "system" },
        { id: "t1", label: "Turn 1" },
        { id: "t2", label: "Turn 2" },
        { id: "t3", label: "Turn 3" },
        { id: "t4", label: "Turn 4" },
        { id: "cur", label: "Current turn", cls: "current" },
      ],
      steps: [
        { label: "Only the most recent turns are kept (window = 2)" },
        { marked: ["t1", "t2"], label: "Turns outside the window…" },
        { removed: ["t1", "t2"], label: "…are removed from the memory", ms: 2400 },
      ],
    },

    "token-based": {
      items: [
        { id: "sys", label: "System prompt", cls: "system" },
        { id: "t1", label: "Turn 1" },
        { id: "t2", label: "Turn 2" },
        { id: "t3", label: "Turn 3" },
        { id: "t4", label: "Turn 4" },
        { id: "cur", label: "Current turn", cls: "current" },
      ],
      steps: [
        { label: "The context exceeds the token budget", meter: "13k / 10k tokens" },
        { marked: ["t1", "t2"], label: "The oldest content beyond the budget…", meter: "13k / 10k tokens" },
        { removed: ["t1", "t2"], label: "…is dropped, keeping the most recent tokens", meter: "8k / 10k tokens", ms: 2400 },
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

    // Reserve the stack's full (uncompacted) height so the card doesn't
    // shrink and grow as blocks collapse during the animation.
    var stack = root.querySelector(".ctx-demo__stack");
    stack.style.minHeight = stack.offsetHeight + "px";
  }

  function apply(root, cfg, step) {
    var marked = step.marked || [];
    var removed = step.removed || [];
    var shown = step.shown || [];

    cfg.items.forEach(function (item) {
      var el = root.querySelector('[data-ctx-box="' + item.id + '"]');
      el.classList.toggle("is-marked", marked.indexOf(item.id) !== -1);
      el.classList.toggle("is-removed", removed.indexOf(item.id) !== -1);
      if (item.hidden) {
        el.classList.toggle("is-hidden", shown.indexOf(item.id) === -1);
      }
    });

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
      apply(root, cfg, cfg.steps[cfg.steps.length - 1]);
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
    Array.prototype.forEach.call(roots, function (root) {
      var cfg = DEMOS[root.dataset.ctxDemo];
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
