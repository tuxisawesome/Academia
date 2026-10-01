// Applies the saved color theme before first paint (avoids a flash of the wrong theme).
(function () {
  try {
    var theme = localStorage.getItem("academia-theme");
    if (theme === "light" || theme === "dark") {
      document.documentElement.dataset.theme = theme;
      // An explicit choice also wins over the OS scheme for the browser/title bar colour.
      var color = theme === "dark" ? "#191612" : "#F5EFE3";
      document.querySelectorAll('meta[name="theme-color"]').forEach(function (meta) {
        meta.content = color;
      });
    }
  } catch (e) {
    /* storage unavailable */
  }
})();
