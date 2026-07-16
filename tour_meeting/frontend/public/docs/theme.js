(function () {
  const storageKey = "ai-tour-meeting-docs-theme";
  const root = document.documentElement;
  const button = document.querySelector("[data-theme-toggle]");
  if (!button) {
    return;
  }

  button.innerHTML = [
    '<svg class="theme-icon theme-icon--sun" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
    '<circle cx="12" cy="12" r="4"></circle>',
    '<path d="M12 2v2"></path>',
    '<path d="M12 20v2"></path>',
    '<path d="m4.93 4.93 1.41 1.41"></path>',
    '<path d="m17.66 17.66 1.41 1.41"></path>',
    '<path d="M2 12h2"></path>',
    '<path d="M20 12h2"></path>',
    '<path d="m6.34 17.66-1.41 1.41"></path>',
    '<path d="m19.07 4.93-1.41 1.41"></path>',
    '</svg>',
    '<svg class="theme-icon theme-icon--moon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
    '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path>',
    '</svg>',
  ].join("");

  const savedTheme = window.localStorage.getItem(storageKey);
  const initialTheme = savedTheme === "light" || savedTheme === "dark"
    ? savedTheme
    : "light";

  const applyTheme = (theme) => {
    root.dataset.theme = theme;
    button.setAttribute("aria-label", theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
    button.setAttribute("title", theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
    button.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
  };

  applyTheme(initialTheme);

  button.addEventListener("click", () => {
    const nextTheme = root.dataset.theme === "dark" ? "light" : "dark";
    window.localStorage.setItem(storageKey, nextTheme);
    applyTheme(nextTheme);
  });
})();
