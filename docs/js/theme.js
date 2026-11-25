const THEME_KEY = "droproom_theme";

export function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const initial = saved === "light" || saved === "dark" ? saved : "dark";
  applyTheme(initial);

  const btn = document.getElementById("themeToggleBtn");
  btn.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next);
    localStorage.setItem(THEME_KEY, next);
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const sun = document.getElementById("themeIconSun");
  const moon = document.getElementById("themeIconMoon");
  if (sun && moon) {
    sun.classList.toggle("hidden", theme === "light");
    moon.classList.toggle("hidden", theme === "dark");
  }
}
