/**
 * Polling helper that becomes a no-op in static-archive builds.
 * Use for data-refresh intervals backed by API calls; do NOT use for
 * animations / clocks / pure-client UI loops.
 */
const STATIC_MODE = import.meta.env.VITE_STATIC_MODE === 'true';

export function startPoll(fn, ms) {
  return STATIC_MODE ? null : setInterval(fn, ms);
}

export function stopPoll(id) {
  if (id != null) clearInterval(id);
}
