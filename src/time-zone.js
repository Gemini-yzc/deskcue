const DEFAULT_ZONE = 'America/Los_Angeles';
const LEGACY_ZONE = 'Asia/Singapore';
const FOLLOW_SYSTEM = 'system';
const HOUR = 3600000;
const formatters = new Map();

function systemTimeZone() {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function effectiveTimeZone(setting, systemZone = systemTimeZone()) {
  return setting === FOLLOW_SYSTEM ? systemZone : setting || DEFAULT_ZONE;
}

function validateTimeZone(value) {
  if (value === FOLLOW_SYSTEM) return value;
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_+/-]*$/i.test(value)) throw new Error('请选择有效时区');
  try { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone; }
  catch { throw new Error('请选择有效时区'); }
}

function wallTime(value, zone) {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, calendar: 'iso8601', numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23',
    });
    formatters.set(zone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).map(part => [part.type, part.value]));
  const day = `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`;
  return `${day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}`;
}

function dateKey(date, zone) {
  return wallTime(date, zone).slice(0, 10);
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function moveDay(day, offset) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function weekday(day) {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

function wallValue(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{3})?)?$/.test(value) &&
    validDate(value.slice(0, 10));
}

function wallInstant(value, zone) {
  const target = Date.parse(`${value}Z`);
  const civilAt = time => Date.parse(`${wallTime(time, zone)}Z`);
  // Project the requested clock time using the UTC offsets on both sides of a transition.
  const offsets = new Set([-36, 0, 36].map(hours => {
    const probe = target + hours * HOUR;
    return civilAt(probe) - probe;
  }));
  const candidates = [...offsets].map(offset => target - offset).sort((a, b) => a - b);
  let before;
  let after;
  for (const time of candidates) {
    const civil = civilAt(time);
    if (civil === target) return time;
    if (civil < target) before = time;
    else if (after === undefined) after = time;
  }
  if (before === undefined || after === undefined || before >= after) throw new Error('无法换算事项时刻');
  // For a clock time skipped by a forward transition, find the first valid instant.
  while (after - before > 1) {
    const middle = Math.floor((before + after) / 2);
    if (civilAt(middle) < target) before = middle;
    else after = middle;
  }
  return after;
}

function taskInstant(value, zone) {
  return wallValue(value) ? wallInstant(value, zone) : Date.parse(value);
}

module.exports = {
  DEFAULT_ZONE, LEGACY_ZONE, FOLLOW_SYSTEM, systemTimeZone, effectiveTimeZone, validateTimeZone,
  wallTime, dateKey, validDate, moveDay, weekday, wallValue, wallInstant, taskInstant,
};
