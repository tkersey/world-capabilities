export function fail(message) {
  throw new Error(message);
}

export function assert(condition, message) {
  if (!condition) fail(message);
}

export function assertEqual(actual, expected, message) {
  if (actual !== expected) fail(`${message}: expected ${expected}, got ${actual}`);
}

export function assertDeepEqual(actual, expected, message) {
  const a = stableStringify(actual);
  const b = stableStringify(expected);
  if (a !== b) fail(`${message}: expected ${b}, got ${a}`);
}

export function stableStringify(value) {
  return JSON.stringify(sortValue(value), null, 2);
}

export function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortValue(item)])
    );
  }
  return value;
}
