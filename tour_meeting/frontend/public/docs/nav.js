(function () {
  var sections = {
    "user-guide": [
      {
        title: "Getting started",
        items: [
          { key: "overview", label: "Overview", href: "./index.html" },
          { key: "quick-start", label: "Quick start", href: "./getting-started.html" },
          { key: "gui-guide", label: "GUI", href: "./gui.html" },
          { key: "cli", label: "CLI", href: "./cli.html" },
          { key: "python-api", label: "Python API", href: "./python-api.html" },
        ],
      },
      {
        title: "Technical details",
        items: [
          { key: "design", label: "Overall design", href: "./design.html" },
          { key: "participants", label: "Participant", href: "./participants.html" },
          { key: "workflow", label: "Meeting workflow", href: "./meeting-workflow.html" },
          { key: "context-management", label: "Context management", href: "./context-management.html" },
        ],
      },
    ],
    "developer-guide": [
      {
        title: "System integration",
        items: [
          { key: "agent-skills", label: "Agent skills", href: "./agent-skills.html" },
          { key: "evaluation", label: "Evaluate your system", href: "./evaluation.html" },
        ],
      },
    ],
    "others": [
      {
        title: "Changelog",
        items: [
          { key: "changelog", label: "Changelog", href: "./changelog.html" },
        ],
      },
      {
        title: "Contact",
        items: [
          { key: "developer", label: "Maintainer", href: "./developer.html" },
          { key: "citation", label: "Citation", href: "./citation.html" },
        ],
      },
    ],
  };

  function renderLink(item, activeKey) {
    var isActive = item.key === activeKey;
    var classes = "nav-link";

    if (isActive) {
      classes += " is-active";
    }

    return (
      '<a class="' +
      classes +
      '" href="' +
      item.href +
      '"' +
      (isActive ? ' aria-current="page"' : "") +
      ">" +
      item.label +
      "</a>"
    );
  }

  function renderGroup(group, activeKey) {
    return (
      '<div class="nav-group">' +
      '<span class="nav-group__title">' +
      group.title +
      "</span>" +
      group.items.map(function (item) {
        return renderLink(item, activeKey);
      }).join("") +
      "</div>"
    );
  }

  function renderSidebar(section, activeKey) {
    var visibleGroups = sections[section] || sections["user-guide"];

    return visibleGroups
      .map(function (group) {
        return renderGroup(group, activeKey);
      })
      .join("");
  }

  function renderBreadcrumbBar(section, activeKey) {
    var groups = sections[section] || sections["user-guide"];
    var groupTitle = null;
    var itemLabel = null;

    groups.forEach(function (group) {
      group.items.forEach(function (item) {
        if (item.key === activeKey) {
          groupTitle = group.title;
          itemLabel = item.label;
        }
      });
    });

    if (!groupTitle && !itemLabel) {
      return "";
    }

    var separator = '<span aria-hidden="true">&gt;</span>';
    var html = '<nav class="breadcrumb breadcrumb--bar" aria-label="Breadcrumb">';

    html += "<span>" + groupTitle + "</span>";

    if (itemLabel && itemLabel !== groupTitle) {
      html += separator + '<span class="breadcrumb__current">' + itemLabel + "</span>";
    }

    return html + "</nav>";
  }

  function flattenSection(section) {
    var groups = sections[section] || sections["user-guide"];
    var items = [];

    groups.forEach(function (group) {
      items = items.concat(group.items);
    });

    return items;
  }

  var chevronLeft =
    '<svg class="pager__icon" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path fill="currentColor" d="M14.7 17.7a1 1 0 0 1-1.41 0l-5-5a1 1 0 0 1 0-1.4l5-5a1 1 0 1 1 1.41 1.4L10.41 12l4.3 4.3a1 1 0 0 1 0 1.4Z"/>' +
    "</svg>";

  var chevronRight =
    '<svg class="pager__icon" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path fill="currentColor" d="M9.3 6.3a1 1 0 0 1 1.41 0l5 5a1 1 0 0 1 0 1.4l-5 5a1 1 0 1 1-1.41-1.4L13.59 12l-4.3-4.3a1 1 0 0 1 0-1.4Z"/>' +
    "</svg>";

  function renderPager(section, activeKey) {
    var items = flattenSection(section);
    var index = -1;

    items.forEach(function (item, i) {
      if (item.key === activeKey) {
        index = i;
      }
    });

    if (index === -1) {
      return "";
    }

    var prev = index > 0 ? items[index - 1] : null;
    var next = index < items.length - 1 ? items[index + 1] : null;

    if (!prev && !next) {
      return "";
    }

    var html = '<nav class="pager" aria-label="Page navigation">';

    if (prev) {
      html +=
        '<a class="pager__link pager__link--prev" href="' + prev.href + '" rel="prev" aria-label="Previous page">' +
        chevronLeft +
        '<span class="pager__label">' +
        prev.label +
        "</span></a>";
    } else {
      html += "<span></span>";
    }

    if (next) {
      html +=
        '<a class="pager__link pager__link--next" href="' + next.href + '" rel="next" aria-label="Next page">' +
        '<span class="pager__label">' +
        next.label +
        "</span>" +
        chevronRight +
        "</a>";
    }

    return html + "</nav>";
  }

  var copyIcon =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path fill="currentColor" d="M9 3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H9Zm0 2h9v10H9V5ZM5 7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2h-2v.001H5V9h.001V7H5Z"/>' +
    "</svg>";

  var checkIcon =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path fill="currentColor" d="M9.55 17.05a1 1 0 0 1-.71-.29l-4.1-4.1a1 1 0 1 1 1.42-1.42l3.39 3.4 8.29-8.3a1 1 0 1 1 1.42 1.42l-9 9a1 1 0 0 1-.71.29Z"/>' +
    "</svg>";

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }

    var textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();

    try {
      document.execCommand("copy");
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    } finally {
      document.body.removeChild(textarea);
    }
  }

  function initSyntaxHighlight() {
    var blocks = document.querySelectorAll("pre code[class*='language-']");

    if (!blocks.length) {
      return;
    }

    var script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js";
    script.defer = true;
    script.onload = function () {
      Array.prototype.forEach.call(blocks, function (block) {
        window.hljs.highlightElement(block);
      });
    };
    document.head.appendChild(script);
  }

  function initCopyButtons() {
    var blocks = document.querySelectorAll("pre");

    Array.prototype.forEach.call(blocks, function (pre) {
      var wrapper = document.createElement("div");
      wrapper.className = "code-block";
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(pre);

      var button = document.createElement("button");
      button.type = "button";
      button.className = "code-copy";
      button.setAttribute("aria-label", "Copy to clipboard");
      button.innerHTML = copyIcon;
      wrapper.appendChild(button);

      var resetTimer = null;

      button.addEventListener("click", function () {
        copyText(pre.textContent.replace(/\n$/, "")).then(function () {
          button.classList.add("is-copied");
          button.innerHTML = checkIcon;
          window.clearTimeout(resetTimer);
          resetTimer = window.setTimeout(function () {
            button.classList.remove("is-copied");
            button.innerHTML = copyIcon;
          }, 2000);
        });
      });
    });
  }

  function getScrollContainer() {
    var content = document.querySelector(".content");

    if (!content) {
      return null;
    }

    var overflowY = window.getComputedStyle(content).overflowY;

    return overflowY === "auto" || overflowY === "scroll" ? content : null;
  }

  function getScrollOffset() {
    var header = document.querySelector(".site-header");
    var headerHeight = header ? header.getBoundingClientRect().height : 0;
    var sidebar = document.querySelector(".sidebar");
    var stickyBarHeight = 0;

    if (sidebar) {
      var toggle = sidebar.querySelector(".sidebar-toggle");
      var isMobileBar = toggle && window.getComputedStyle(toggle).display !== "none";

      if (isMobileBar && window.getComputedStyle(sidebar).position === "sticky") {
        stickyBarHeight = sidebar.getBoundingClientRect().height;
      }
    }

    return Math.max(96, Math.round(headerHeight + stickyBarHeight) + 20);
  }

  function updateHeaderHeight() {
    var header = document.querySelector(".site-header");

    if (header) {
      var height = header.getBoundingClientRect().height;
      document.documentElement.style.setProperty("--header-height", height + "px");
    }
  }

  function scrollToHash(hash, behavior) {
    if (!hash) {
      return;
    }

    var target = document.getElementById(hash.slice(1));

    if (!target) {
      return;
    }

    var container = getScrollContainer();

    if (!container) {
      window.scrollTo({
        top: target.getBoundingClientRect().top + window.scrollY - getScrollOffset(),
        behavior: behavior || "auto",
      });
      return;
    }

    var containerRect = container.getBoundingClientRect();
    var targetRect = target.getBoundingClientRect();
    var top = container.scrollTop + (targetRect.top - containerRect.top) - getScrollOffset();

    container.scrollTo({
      top: top,
      behavior: behavior || "auto",
    });
  }

  function handleSidebarClick(event) {
    var link = event.target.closest("[data-doc-sidebar] a[href*='#']");

    if (!link) {
      return;
    }

    var url = new URL(link.href, window.location.href);

    if (url.pathname !== window.location.pathname || !url.hash) {
      return;
    }

    var target = document.getElementById(url.hash.slice(1));

    if (!target) {
      return;
    }

    event.preventDefault();
    history.pushState(null, "", url.hash);

    var sidebar = link.closest("[data-doc-sidebar]");
    if (sidebar && sidebar.classList.contains("is-open")) {
      sidebar.classList.remove("is-open");
      var toggle = sidebar.querySelector(".sidebar-toggle");
      if (toggle) {
        toggle.setAttribute("aria-expanded", "false");
      }
    }

    scrollToHash(url.hash, "smooth");
  }

  var GITHUB_REPO = "ntt-dkiku/ai-tour-meeting";

  function formatStarCount(count) {
    if (count >= 1000) {
      return (Math.round(count / 100) / 10).toFixed(1).replace(/\.0$/, "") + "k";
    }
    return String(count);
  }

  function initGithubLink() {
    var actions = document.querySelector(".site-header__actions");
    if (!actions || actions.querySelector(".github-link")) {
      return;
    }

    var link = document.createElement("a");
    link.className = "github-link";
    link.href = "https://github.com/" + GITHUB_REPO;
    link.target = "_blank";
    link.rel = "noopener";
    link.setAttribute("aria-label", "GitHub repository");
    link.innerHTML =
      '<svg class="github-link__mark" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path fill="currentColor" d="M12 1.7a10.5 10.5 0 0 0-3.32 20.46c.53.1.72-.23.72-.5v-1.97c-2.92.63-3.54-1.24-3.54-1.24c-.48-1.21-1.17-1.53-1.17-1.53c-.95-.65.07-.64.07-.64c1.05.07 1.6 1.08 1.6 1.08c.94 1.6 2.46 1.14 3.06.87c.1-.68.37-1.14.66-1.4c-2.33-.27-4.79-1.17-4.79-5.2c0-1.14.41-2.08 1.08-2.81c-.1-.27-.47-1.34.1-2.79c0 0 .89-.28 2.9 1.08a10.06 10.06 0 0 1 5.28 0c2-1.36 2.89-1.08 2.89-1.08c.58 1.45.21 2.52.1 2.79c.68.73 1.08 1.67 1.08 2.81c0 4.04-2.46 4.93-4.81 5.19c.38.33.72.97.72 1.96v2.9c0 .28.19.61.73.5A10.5 10.5 0 0 0 12 1.7Z"/>' +
      "</svg>" +
      '<span class="github-link__text">' +
      '<span class="github-link__repo">' + GITHUB_REPO + "</span>" +
      '<span class="github-link__meta" hidden>' +
      '<span class="github-link__stat">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 3.6l2.35 4.76l5.25.76l-3.8 3.7l.9 5.23L12 15.58l-4.7 2.47l.9-5.23l-3.8-3.7l5.25-.76L12 3.6Z"/></svg>' +
      '<span class="github-link__stars-count"></span>' +
      "</span>" +
      '<span class="github-link__stat">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 3a3 3 0 0 1 1 5.83v2.67c0 .28.22.5.5.5h7a.5.5 0 0 0 .5-.5V8.83A3 3 0 1 1 18 8.9v2.6a2.5 2.5 0 0 1-2.5 2.5H13v1.17a3 3 0 1 1-2 0V14H8.5A2.5 2.5 0 0 1 6 11.5V8.83A3 3 0 0 1 7 3Zm0 2a1 1 0 1 0 0 2a1 1 0 0 0 0-2Zm10 0a1 1 0 1 0 0 2a1 1 0 0 0 0-2ZM12 17a1 1 0 1 0 0 2a1 1 0 0 0 0-2Z"/></svg>' +
      '<span class="github-link__forks-count"></span>' +
      "</span>" +
      "</span>" +
      "</span>";
    actions.insertBefore(link, actions.firstChild);

    var meta = link.querySelector(".github-link__meta");
    var starsCount = link.querySelector(".github-link__stars-count");
    var forksCount = link.querySelector(".github-link__forks-count");

    // Show each stat only when its count is at least 1
    function showMeta(stars, forks) {
      starsCount.textContent = formatStarCount(stars);
      forksCount.textContent = formatStarCount(forks);
      starsCount.parentNode.hidden = stars < 1;
      forksCount.parentNode.hidden = forks < 1;
      meta.hidden = stars < 1 && forks < 1;
    }

    // Cache the counts for an hour to stay clear of GitHub API rate limits
    var cacheKey = "ai-tour-meeting-gh-meta";
    try {
      var cached = JSON.parse(localStorage.getItem(cacheKey));
      if (cached && Date.now() - cached.time < 3600000) {
        showMeta(cached.stars, cached.forks);
        return;
      }
    } catch (e) {}

    fetch("https://api.github.com/repos/" + GITHUB_REPO)
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (data) {
        if (!data || typeof data.stargazers_count !== "number") {
          return;
        }
        var forks = typeof data.forks_count === "number" ? data.forks_count : 0;
        showMeta(data.stargazers_count, forks);
        try {
          localStorage.setItem(
            cacheKey,
            JSON.stringify({
              stars: data.stargazers_count,
              forks: forks,
              time: Date.now(),
            })
          );
        } catch (e) {}
      })
      .catch(function () {});
  }

  // Docs versions shown in the badge next to the site title. Add entries here
  // as new versions are published: { label: "v1.0", href: "../v1.0/index.html" }
  var VERSIONS = [{ label: "alpha", href: "./index.html" }];
  var CURRENT_VERSION = "alpha";

  function initVersionBadge() {
    var title = document.querySelector(".site-title");
    if (!title || document.querySelector(".version-menu")) {
      return;
    }

    var row = document.createElement("div");
    row.className = "site-title-row";
    title.parentNode.insertBefore(row, title);
    row.appendChild(title);

    var menu = document.createElement("div");
    menu.className = "version-menu";
    menu.innerHTML =
      '<button type="button" class="version-badge" aria-haspopup="listbox" aria-expanded="false" aria-label="Select docs version">' +
      CURRENT_VERSION +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6.3 9.3a1 1 0 0 1 1.4 0L12 13.59l4.3-4.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 0 1 0-1.42Z"/></svg>' +
      "</button>" +
      '<div class="version-menu__list" role="listbox" hidden>' +
      VERSIONS.map(function (v) {
        var isCurrent = v.label === CURRENT_VERSION;
        return (
          '<a class="version-menu__item' +
          (isCurrent ? " is-current" : "") +
          '" role="option" aria-selected="' +
          (isCurrent ? "true" : "false") +
          '" href="' +
          v.href +
          '">' +
          v.label +
          "</a>"
        );
      }).join("") +
      "</div>";
    row.appendChild(menu);

    var badge = menu.querySelector(".version-badge");
    var list = menu.querySelector(".version-menu__list");

    function closeMenu() {
      list.hidden = true;
      badge.setAttribute("aria-expanded", "false");
    }

    badge.addEventListener("click", function (event) {
      event.stopPropagation();
      var open = list.hidden;
      list.hidden = !open;
      badge.setAttribute("aria-expanded", open ? "true" : "false");
    });

    document.addEventListener("click", function (event) {
      if (!menu.contains(event.target)) {
        closeMenu();
      }
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        closeMenu();
      }
    });
  }

  function init() {
    initGithubLink();
    initVersionBadge();
    updateHeaderHeight();
    window.addEventListener("resize", updateHeaderHeight);
    initSyntaxHighlight();
    initCopyButtons();

    var sidebars = document.querySelectorAll("[data-doc-sidebar]");
    Array.prototype.forEach.call(sidebars, function (sidebar) {
      sidebar.innerHTML =
        '<button type="button" class="sidebar-toggle" aria-expanded="false" aria-label="Toggle navigation">' +
        '<svg class="sidebar-toggle__icon" viewBox="0 0 24 24" aria-hidden="true">' +
        '<path fill="currentColor" d="M3.5 6.25a1 1 0 0 1 1-1h15a1 1 0 1 1 0 2h-15a1 1 0 0 1-1-1Zm0 5.75a1 1 0 0 1 1-1h15a1 1 0 1 1 0 2h-15a1 1 0 0 1-1-1Zm1 4.75a1 1 0 1 0 0 2h15a1 1 0 1 0 0-2h-15Z"/>' +
        "</svg>" +
        "</button>" +
        '<div class="sidebar-backdrop"></div>' +
        '<div class="sidebar__nav">' +
        renderSidebar(sidebar.dataset.docSection || "", sidebar.dataset.docActive || "") +
        "</div>";

      sidebar.insertAdjacentHTML(
        "beforeend",
        renderBreadcrumbBar(sidebar.dataset.docSection || "", sidebar.dataset.docActive || "")
      );

      var toggle = sidebar.querySelector(".sidebar-toggle");
      var backdrop = sidebar.querySelector(".sidebar-backdrop");

      function closeSidebar() {
        sidebar.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      }

      toggle.addEventListener("click", function () {
        var isOpen = sidebar.classList.toggle("is-open");
        toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
      });

      backdrop.addEventListener("click", closeSidebar);

      document.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && sidebar.classList.contains("is-open")) {
          closeSidebar();
        }
      });
    });

    var firstSidebar = document.querySelector("[data-doc-sidebar]");
    var content = document.querySelector(".content");

    if (firstSidebar && content) {
      var pagerHtml = renderPager(firstSidebar.dataset.docSection || "", firstSidebar.dataset.docActive || "");

      if (pagerHtml) {
        content.insertAdjacentHTML("beforeend", pagerHtml);
      }
    }

    document.addEventListener("click", handleSidebarClick);

    if (window.location.hash) {
      window.requestAnimationFrame(function () {
        scrollToHash(window.location.hash, "auto");
      });
    }

    window.addEventListener("popstate", function () {
      if (window.location.hash) {
        scrollToHash(window.location.hash, "auto");
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
