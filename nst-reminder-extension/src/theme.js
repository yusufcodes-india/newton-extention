// Runs at document_start on my.newtonschool.co. One job: restyle the whole
// portal page to the theme picked in the popup (Settings -> Page theme).
// Classic script (no imports).
//
// How it works: the portal's DOM isn't ours, so instead of overriding its
// CSS we flip the whole page with a CSS filter on <html> and flip media
// (images, video, canvas, iframes) back so they keep their real colours.
// The chosen theme is mirrored into the page's localStorage so the next
// load can apply it synchronously, before first paint (no white flash).
(function () {
  if (window.__nstThemeHooked) return;
  window.__nstThemeHooked = true;

  var STYLE_ID = "nst-ext-theme";
  var LS_KEY = "nst-ext-theme";
  var FLIP = "invert(1) hue-rotate(180deg)";
  var FILTERS = {
    dark: FLIP,
    dim: FLIP + " brightness(0.88) contrast(0.95)",
    warm: FLIP + " sepia(0.35) brightness(0.9)",
  };
  var mq = window.matchMedia("(prefers-color-scheme: dark)");
  var current = "off";

  function resolve(name) {
    if (name === "auto") return mq.matches ? "dark" : "off";
    return FILTERS[name] ? name : "off";
  }

  function cssFor(name) {
    var f = FILTERS[name];
    if (!f) return "";
    return (
      "html{background:#fff!important;filter:" + f + "!important;}" +
      "img,picture,video,canvas,iframe,embed,object{filter:" + FLIP + "!important;}"
    );
  }

  function apply(name) {
    current = name;
    var css = cssFor(resolve(name));
    var el = document.getElementById(STYLE_ID);
    if (!css) {
      if (el) el.remove();
      return;
    }
    if (!el) {
      el = document.createElement("style");
      el.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(el);
    }
    el.textContent = css;
  }

  function remember(name) {
    try {
      localStorage.setItem(LS_KEY, name);
    } catch (e) {}
  }

  function alive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  // 1) Instant apply from the cached value (synchronous, pre-paint).
  var cached = "off";
  try {
    cached = localStorage.getItem(LS_KEY) || "off";
  } catch (e) {}
  apply(cached);

  if (!alive()) return;

  // 2) Reconcile with the real setting, then follow live changes from the popup.
  try {
    chrome.storage.local.get("uiTheme", function (r) {
      var t = (r && r.uiTheme) || "off";
      remember(t);
      apply(t);
    });
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local" || !changes.uiTheme) return;
      var t = changes.uiTheme.newValue || "off";
      remember(t);
      apply(t);
    });
  } catch (e) {}

  // 3) "Auto" follows the OS light/dark setting.
  var onScheme = function () {
    if (current === "auto") apply("auto");
  };
  if (mq.addEventListener) mq.addEventListener("change", onScheme);
  else if (mq.addListener) mq.addListener(onScheme);
})();
