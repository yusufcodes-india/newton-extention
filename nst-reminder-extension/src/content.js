// Runs on my.newtonschool.co. One job: hand the signed-in session token and
// current course hash to the extension. No DOM scraping — data comes from
// Newton's API via the background worker. Classic script (no imports).
(function () {
  if (window.__nstSessHooked) return;
  window.__nstSessHooked = true;

  var COURSE_RE = /\/course\/([^/]+)\/details/;
  var DEBOUNCE_MS = 1000;
  var timer = null;
  var last = { token: null, hash: null, url: null };

  function alive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function readToken() {
    try {
      var raw = localStorage.getItem("auth-token");
      if (raw) return raw.replace(/^"|"$/g, "");
    } catch (e) {}
    var m = document.cookie.match(/(?:^|;\s*)access_token_ns_student_web=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function sync() {
    if (!alive()) return;
    var token = readToken();
    var hash = (location.pathname.match(COURSE_RE) || [])[1] || null;
    var patch = {};
    if (token && token !== last.token) patch.authToken = token;
    if (hash && hash !== last.hash) patch.courseHash = hash;
    last = { token: token || last.token, hash: hash || last.hash, url: location.href };
    if (Object.keys(patch).length) {
      try {
        chrome.storage.local.set(patch);
      } catch (e) {}
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(sync, DEBOUNCE_MS);
  }

  var _pushState = history.pushState;
  history.pushState = function () {
    var r = _pushState.apply(this, arguments);
    schedule();
    return r;
  };

  var _replaceState = history.replaceState;
  history.replaceState = function () {
    var r = _replaceState.apply(this, arguments);
    schedule();
    return r;
  };

  window.addEventListener("popstate", schedule);
  window.addEventListener("hashchange", schedule);

  sync();
})();
