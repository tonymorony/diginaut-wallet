// Inactivity auto-lock is the control that drops the vault's AES session key
// and every plaintext mnemonic on an unattended device (spec §5: default 5
// minutes). Its delay resolution lives here, as a pure function of the stored
// string, because it used to live inline in app.js where the DEFAULT path was
// unreachable from any test — and that is precisely where it was broken:
//
//   Number(localStorage.getItem(key))  // absent key → Number(null) → 0
//
// 0 is a MEANINGFUL setting ("Never"), so coercing before checking for absence
// turned the documented 5-minute default into no auto-lock at all for every
// profile that had never touched the setting, while the select still displayed
// "5 minutes". Absent and 0 must stay distinguishable.

export const AUTOLOCK_KEY = 'diginaut.autolock';
export const AUTOLOCK_DEFAULT_MIN = 5;

/** Stored ladder value (raw string, or null when absent) → minutes.
 * 0 means Never — the only way to get it is to have chosen it. Anything
 * unusable (absent, blank, non-numeric, negative) falls back to the default:
 * a corrupted preference must not silently disable the lock. */
export function autolockMinutes(raw) {
  if (raw === null || raw === undefined) return AUTOLOCK_DEFAULT_MIN;
  const text = String(raw).trim();
  if (text === '') return AUTOLOCK_DEFAULT_MIN;
  const mins = Number(text);
  if (!Number.isFinite(mins) || mins < 0) return AUTOLOCK_DEFAULT_MIN;
  return mins;
}
