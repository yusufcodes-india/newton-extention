import { SECTION_KEYS, normalizeState, validateSettings } from "./utils/storage.js";

const $ = (id) => document.getElementById(id);

async function init() {
  const state = normalizeState(await chrome.storage.local.get(null));
  const s = state.settings;
  $("digestTime").value = s.digestTime;
  $("threshold").value = s.attendanceThreshold;
  $("leads").value = s.assignmentLeadsMin.join(", ");
  $("classLead").value = s.classLeadMin;
  $("nudgeHour").value = s.qotdNudgeHour;
  for (const k of SECTION_KEYS) {
    const box = $("sec-" + k);
    if (box) box.checked = !s.enabledSections || s.enabledSections[k] !== false;
  }
  if (s.quietHours) {
    $("quietStart").value = s.quietHours.start;
    $("quietEnd").value = s.quietHours.end;
  }
  $("opts").addEventListener("submit", async (e) => {
    e.preventDefault();
    const leads = $("leads")
      .value.split(",")
      .map((x) => Number(x.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    const cur = normalizeState(await chrome.storage.local.get(null));
    const enabledSections = {};
    for (const k of SECTION_KEYS) {
      const box = $("sec-" + k);
      enabledSections[k] = box ? box.checked : true;
    }
    cur.settings = validateSettings({
      digestTime: $("digestTime").value,
      attendanceThreshold: $("threshold").value,
      assignmentLeadsMin: leads,
      classLeadMin: $("classLead").value,
      qotdNudgeHour: $("nudgeHour").value,
      enabledSections,
      quietHours:
        $("quietStart").value && $("quietEnd").value
          ? { start: $("quietStart").value, end: $("quietEnd").value }
          : null,
    });
    await chrome.storage.local.set({ settings: cur.settings });
    $("saved").hidden = false;
    setTimeout(() => ($("saved").hidden = true), 1500);
  });
}

init();
