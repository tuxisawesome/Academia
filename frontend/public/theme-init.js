// Applies the saved color theme before first paint (avoids a flash of the wrong theme).
(function () {
  try {
    var theme = localStorage.getItem("academia-theme");
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  } catch (e) {
    /* storage unavailable */
  }
})();
