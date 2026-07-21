(function () {
  var sections = {
    "user-guide": [
      {
        title: "Getting started",
        items: [
          { key: "overview", label: "Overview", href: "./index.html" },
          { key: "quick-start", label: "Quick start", href: "./getting-started.html" },
          { key: "gui-guide", label: "GUI", href: "./gui.html" },
          { key: "python-cli", label: "Python CLI", href: "./python-cli.html" },
        ],
      },
      {
        title: "Framework",
        items: [
          { key: "design", label: "Design", href: "./design.html" },
          { key: "participants", label: "Participants", href: "./participants.html" },
          { key: "workflow", label: "Workflow", href: "./meeting-workflow.html" },
          { key: "context-management", label: "Context management", href: "./context-management.html" },
        ],
      },
      {
        title: "LLM settings",
        items: [
          { key: "llm-settings", label: "Provider setup", href: "./llm-settings.html" },
        ],
      },
    ],
    "developer-guide": [
      {
        title: "Developer guide",
        items: [
          { key: "testing", label: "Testing and customization", href: "./reference.html" },
          { key: "hosting", label: "Hosting and release notes", href: "./deployment.html" },
        ],
      },
      {
        title: "Coding agent integration",
        items: [
          { key: "agent-skills", label: "Agent skills", href: "./agent-skills.html" },
        ],
      },
    ],
    "changelog": [
      {
        title: "Changelog",
        items: [
          { key: "changelog", label: "Changelog", href: "./changelog.html" },
        ],
      },
    ],
    "contact": [
      {
        title: "Contact",
        items: [
          { key: "developer", label: "Developer", href: "./developer.html" },
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

  var sectionMeta = {
    "user-guide": { label: "User guide", href: "./index.html" },
    "developer-guide": { label: "Developer guide", href: "./reference.html" },
    "changelog": { label: "Changelog", href: "./changelog.html" },
    "contact": { label: "Contact", href: "./developer.html" },
  };

  function renderBreadcrumbBar(section, activeKey) {
    var meta = sectionMeta[section] || sectionMeta["user-guide"];
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

    var separator = '<span aria-hidden="true">&gt;</span>';
    var html =
      '<nav class="breadcrumb breadcrumb--bar" aria-label="Breadcrumb">' +
      '<a class="breadcrumb__link" href="' + meta.href + '">' + meta.label + "</a>";

    if (groupTitle && groupTitle !== meta.label) {
      html += separator + "<span>" + groupTitle + "</span>";
    }

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

    if (sidebar && window.getComputedStyle(sidebar).position === "sticky") {
      stickyBarHeight = sidebar.getBoundingClientRect().height;
    }

    return Math.max(96, Math.round(headerHeight + stickyBarHeight) + 20);
  }

  function updateHeaderHeight() {
    var header = document.querySelector(".site-header");

    if (header) {
      document.documentElement.style.setProperty("--header-height", header.offsetHeight + "px");
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

  function init() {
    updateHeaderHeight();
    window.addEventListener("resize", updateHeaderHeight);

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
