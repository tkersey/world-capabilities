import { fail } from "./errors.mjs";
import { decodeStringValue, encodeStringValue } from "./protocol.mjs";

export function decodeJsonStringValue(bytes, maximumBytes = 1 << 20) {
  const text = decodeStringValue(bytes, maximumBytes);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("ERR_CAPABILITY_V1_JSON");
  }
  assertJsonValue(value, "$", 0);
  return value;
}

export function encodeJsonStringValue(value) {
  return encodeStringValue(JSON.stringify(snapshotJsonValue(value, "$", 0)));
}

function assertJsonValue(value, path, depth) {
  if (depth > 16) fail("ERR_CAPABILITY_V1_JSON_DEPTH", path);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("ERR_CAPABILITY_V1_JSON_NUMBER", path);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 1024) fail("ERR_CAPABILITY_V1_JSON_COUNT", path);
    for (let index = 0; index < value.length; index += 1) assertJsonValue(value[index], `${path}[${index}]`, depth + 1);
    return;
  }
  if (typeof value !== "object") fail("ERR_CAPABILITY_V1_JSON_VALUE", path);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("ERR_CAPABILITY_V1_JSON_VALUE", path);
  const entries = Object.entries(value);
  if (entries.length > 1024) fail("ERR_CAPABILITY_V1_JSON_COUNT", path);
  for (const [key, child] of entries) assertJsonValue(child, `${path}.${key}`, depth + 1);
}

function snapshotJsonValue(value, path, depth) {
  if (depth > 16) fail("ERR_CAPABILITY_V1_JSON_DEPTH", path);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("ERR_CAPABILITY_V1_JSON_NUMBER", path);
    return value;
  }
  if (Array.isArray(value)) return snapshotJsonArray(value, path, depth);
  if (typeof value !== "object") fail("ERR_CAPABILITY_V1_JSON_VALUE", path);

  let descriptors;
  let prototype;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    fail("ERR_CAPABILITY_V1_JSON_VALUE", path);
  }
  if (prototype !== Object.prototype && prototype !== null) fail("ERR_CAPABILITY_V1_JSON_VALUE", path);

  const admitted = Object.create(null);
  let count = 0;
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== "string" || !descriptor?.enumerable) continue;
    count += 1;
    if (count > 1024) fail("ERR_CAPABILITY_V1_JSON_COUNT", path);
    if (!Object.hasOwn(descriptor, "value")) fail("ERR_CAPABILITY_V1_JSON_VALUE", `${path}.${key}`);
    Object.defineProperty(admitted, key, {
      value: snapshotJsonValue(descriptor.value, `${path}.${key}`, depth + 1),
      enumerable: true,
      configurable: false,
      writable: false
    });
  }
  return Object.freeze(admitted);
}

function snapshotJsonArray(value, path, depth) {
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail("ERR_CAPABILITY_V1_JSON_VALUE", path);
  }
  const lengthDescriptor = descriptors.length;
  if (!Object.hasOwn(descriptors, "length") || !lengthDescriptor || !Object.hasOwn(lengthDescriptor, "value") ||
      !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
    fail("ERR_CAPABILITY_V1_JSON_VALUE", `${path}.length`);
  }
  const length = lengthDescriptor.value;
  if (length > 1024) fail("ERR_CAPABILITY_V1_JSON_COUNT", path);
  const admitted = [];
  Object.setPrototypeOf(admitted, null);
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptors, key) || !descriptor || !Object.hasOwn(descriptor, "value")) {
      fail("ERR_CAPABILITY_V1_JSON_VALUE", `${path}[${index}]`);
    }
    Object.defineProperty(admitted, key, {
      value: snapshotJsonValue(descriptor.value, `${path}[${index}]`, depth + 1),
      enumerable: true,
      configurable: false,
      writable: false
    });
  }
  Object.defineProperty(admitted, "length", {
    value: length,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return Object.freeze(admitted);
}
