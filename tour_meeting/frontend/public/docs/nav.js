(function () {
  var sections = {
    "user-guide": [
      {
        title: "Getting Started",
        items: [
          { key: "overview", label: "Overview", href: "./index.html" },
          { key: "quick-start", label: "Quick Start", href: "./getting-started.html" },
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
        title: "Developer Guide",
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

  function getScrollContainer() {
    return document.querySelector(".content");
  }

  function getScrollOffset() {
    var header = document.querySelector(".site-header");
    var headerHeight = header ? header.getBoundingClientRect().height : 0;

    return Math.max(96, Math.round(headerHeight) + 20);
  }

  function scrollToHash(hash, behavior) {
    if (!hash) {
      return;
    }

    var target = document.getElementById(hash.slice(1));
    var container = getScrollContainer();

    if (!target || !container) {
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
    scrollToHash(url.hash, "smooth");
  }

  function init() {
    var sidebars = document.querySelectorAll("[data-doc-sidebar]");
    Array.prototype.forEach.call(sidebars, function (sidebar) {
      sidebar.innerHTML = renderSidebar(sidebar.dataset.docSection || "", sidebar.dataset.docActive || "");
    });

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
