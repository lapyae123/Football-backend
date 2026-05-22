// Checks whether the current local time falls within the scraper's configured
// active window. Config shape (stored in sources.config JSON):
//
//   active_hours: { from: "HH:MM", to: "HH:MM" }
//
// Examples:
//   { from: "06:00", to: "23:00" }  → run 06:00–23:00, skip 23:00–06:00
//   { from: "22:00", to: "08:00" }  → overnight window (from > to wraps midnight)
//
// If active_hours is not configured, always returns true (run anytime).

const parseHHMM = (str) => {
  if (!str) return null;
  const [h, m] = str.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m; // minutes since midnight
};

const isWithinActiveHours = (cfg) => {
  const hours = cfg?.active_hours;
  if (!hours?.from || !hours?.to) return true; // no schedule = always run

  const from    = parseHHMM(hours.from);
  const to      = parseHHMM(hours.to);
  if (from === null || to === null) return true;

  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();

  if (from <= to) {
    // Normal window: e.g. 06:00–23:00
    return cur >= from && cur < to;
  } else {
    // Overnight window: e.g. 22:00–06:00 (wraps midnight)
    return cur >= from || cur < to;
  }
};

module.exports = { isWithinActiveHours };
