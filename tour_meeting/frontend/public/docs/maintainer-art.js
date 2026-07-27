(function () {
  // Interactive dot-grid wave art on the Maintainer page. A grid of dots
  // undulates continuously; moving the pointer over it lifts nearby dots and
  // clicking drops a ripple.
  var canvas = document.querySelector("[data-maintainer-art]");
  if (!canvas || !canvas.getContext) {
    return;
  }

  var ctx = canvas.getContext("2d");
  var SIZE = 280; // backing-store pixels (CSS size is set in the stylesheet)
  canvas.width = SIZE;
  canvas.height = SIZE;

  var N = 21;
  var MARGIN = 18;
  var SPACING = (SIZE - 2 * MARGIN) / (N - 1);

  var t = 0;
  var ripples = [];
  var rafId = null;
  var lastEmit = null;

  function toCanvasCoords(event) {
    var rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * SIZE,
      y: ((event.clientY - rect.top) / rect.height) * SIZE,
    };
  }

  function emitRipple(center, amp) {
    ripples.push({ center: center, age: 0, amp: amp });
    if (ripples.length > 14) {
      ripples.shift();
    }
  }

  // Moving the pointer continuously emits small waves along its path;
  // clicking drops a big one.
  canvas.addEventListener("pointermove", function (event) {
    var p = toCanvasCoords(event);
    if (lastEmit) {
      var dx = p.x - lastEmit.x;
      var dy = p.y - lastEmit.y;
      if (dx * dx + dy * dy < 22 * 22) {
        return;
      }
    }
    lastEmit = p;
    emitRipple(p, 1.1);
  });
  canvas.addEventListener("pointerdown", function (event) {
    emitRipple(toCanvasCoords(event), 2.6);
  });

  function accentColor() {
    // The tile always has the dark-theme background, so always use the
    // dark-theme accent for the dots regardless of the site theme.
    return "#53d17d";
  }

  function drawFrame() {
    ctx.clearRect(0, 0, SIZE, SIZE);
    var color = accentColor();

    for (var iy = 0; iy < N; iy++) {
      for (var ix = 0; ix < N; ix++) {
        var x = MARGIN + ix * SPACING;
        var y = MARGIN + iy * SPACING;

        // Base traveling wave over the grid
        var wave =
          Math.sin(x * 0.045 + t) * Math.cos(y * 0.045 + t * 0.7) +
          Math.sin((x + y) * 0.025 - t * 0.6);

        // Waves expanding from pointer interactions
        for (var r = 0; r < ripples.length; r++) {
          var rip = ripples[r];
          var dxr = x - rip.center.x;
          var dyr = y - rip.center.y;
          var dr = Math.sqrt(dxr * dxr + dyr * dyr);
          var front = rip.age * 2.4;
          var falloff = Math.exp(-rip.age * 0.025);
          wave += Math.exp(-Math.pow(dr - front, 2) / 90) * rip.amp * falloff;
        }

        var lift = wave * 2.2;
        var radius = 1 + Math.max(0, wave + 1.6) * 0.55;
        var alpha = 0.25 + Math.min(0.75, Math.max(0, wave + 1.6) * 0.22);

        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y - lift, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function frame() {
    t += 0.03;
    for (var i = ripples.length - 1; i >= 0; i--) {
      ripples[i].age += 1;
      if (ripples[i].age > 160) {
        ripples.splice(i, 1);
      }
    }
    drawFrame();
    rafId = window.requestAnimationFrame(frame);
  }

  function stop() {
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    drawFrame();
    return;
  }

  // Animate only while visible
  if ("IntersectionObserver" in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          if (rafId === null) {
            frame();
          }
        } else {
          stop();
        }
      });
    }, { threshold: 0.1 });
    observer.observe(canvas);
  } else {
    frame();
  }
})();
