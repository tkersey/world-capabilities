import * as researchLookupFixture from "../../packages/research-lookup-fixture/adapter.mjs";
import { fail } from "./errors.mjs";
import { effectInterfaceId } from "./protocol.mjs";

export const RESEARCH_LOOKUP_INTERFACE_LABEL = "research.lookup.v2";
export const RESEARCH_DIGEST_APPLICATION_ID =
  "677efd4c6918662bdc21df5ae3b9f37266509000d91241272771e3f630604e08";
export const RESEARCH_REQUEST_SCHEMA_ID =
  "0cce95380bfd932c58c185226d71a2957fc25f7fe3423598a29f5dede8a096f2";
export const RESEARCH_RESPONSE_SCHEMA_ID =
  "1fd9bd60f34d340b4181b9dbd678c8dc680c9c776f200d13ca5717103bdc5d1c";

const MAXIMUM_QUERY_BYTES = 512;
const MAXIMUM_ITEMS = 8;
const MAXIMUM_TITLE_BYTES = 256;
const MAXIMUM_SUMMARY_BYTES = 1024;

export function researchLookupFixtureBinding(options = {}) {
  const adapter = options.adapter ?? researchLookupFixture;
  return {
    bindingId: "research-lookup-fixture.v2",
    driverId: "research-lookup-fixture",
    packageName: "@tkersey/world-capabilities/research-lookup-fixture",
    interfaceId: effectInterfaceId(RESEARCH_LOOKUP_INTERFACE_LABEL),
    payloadSchemaId: digest(RESEARCH_REQUEST_SCHEMA_ID),
    resultSchemaId: digest(RESEARCH_RESPONSE_SCHEMA_ID),
    applicationIds: [digest(RESEARCH_DIGEST_APPLICATION_ID)],
    authorityRequirements: 128n,
    target: {
      descriptorFingerprint: "desc.research-lookup-fixture.v2",
      actuatorRef: "actuator.research-lookup-fixture.v2",
      actuationClass: "research"
    },
    adapter,
    decodePayload: decodeResearchRequest,
    encodeOutcome: (outcome) => encodeResearchResponse(outcome.payload),
    recoveryClass: "pure"
  };
}

export function decodeResearchRequest(encoded) {
  const reader = new Reader(encoded, "ERR_CAPABILITY_V1_RESEARCH_REQUEST");
  const query = reader.string(MAXIMUM_QUERY_BYTES, "query");
  const maximumItems = reader.u32();
  reader.finish();
  return Object.freeze({ query, maximumItems });
}

export function encodeResearchResponse(value) {
  if (!hasExactOwnKeys(value, ["items"])) {
    fail("ERR_CAPABILITY_V1_RESEARCH_RESPONSE");
  }
  if (!Array.isArray(value.items) || value.items.length > MAXIMUM_ITEMS) {
    fail("ERR_CAPABILITY_V1_RESEARCH_RESPONSE", "items");
  }
  const length = Buffer.alloc(4);
  length.writeUInt32LE(value.items.length);
  return Buffer.concat([
    length,
    ...Array.from(
      value.items,
      (item, index) => encodeResearchItem(item, `items[${index}]`)
    )
  ]);
}

export function decodeResearchResponse(encoded) {
  const reader = new Reader(encoded, "ERR_CAPABILITY_V1_RESEARCH_RESPONSE");
  const length = reader.u32();
  if (length > MAXIMUM_ITEMS) fail("ERR_CAPABILITY_V1_RESEARCH_RESPONSE", "items");
  const response = {
    items: Array.from(
      { length },
      (_, index) => decodeResearchItem(reader, `items[${index}]`)
    )
  };
  reader.finish();
  return response;
}

function encodeResearchItem(value, label) {
  if (!hasExactOwnKeys(value, ["summary", "title"])) {
    fail("ERR_CAPABILITY_V1_RESEARCH_RESPONSE", label);
  }
  return Buffer.concat([
    encodeString(value.title, MAXIMUM_TITLE_BYTES, `${label}.title`),
    encodeString(value.summary, MAXIMUM_SUMMARY_BYTES, `${label}.summary`)
  ]);
}

function hasExactOwnKeys(value, expectedKeys) {
  if (!value || typeof value !== "object") return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key));
}

function decodeResearchItem(reader, label) {
  return {
    title: reader.string(MAXIMUM_TITLE_BYTES, `${label}.title`),
    summary: reader.string(MAXIMUM_SUMMARY_BYTES, `${label}.summary`)
  };
}

function encodeString(value, maximum, label) {
  if (typeof value !== "string") fail("ERR_CAPABILITY_V1_RESEARCH_RESPONSE", label);
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > maximum || new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== value) {
    fail("ERR_CAPABILITY_V1_RESEARCH_RESPONSE", label);
  }
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function digest(value) {
  return Buffer.from(value, "hex");
}

class Reader {
  constructor(value, errorCode) {
    if (!(value instanceof Uint8Array)) fail(errorCode);
    this.value = Buffer.from(value);
    this.offset = 0;
    this.errorCode = errorCode;
  }

  bytes(length) {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.value.length) {
      fail(this.errorCode);
    }
    const result = this.value.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  u32() {
    return this.bytes(4).readUInt32LE();
  }

  string(maximum, label) {
    const bytes = this.bytes(this.u32());
    if (bytes.length > maximum) fail(this.errorCode, label);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail(this.errorCode, label);
    }
  }

  finish() {
    if (this.offset !== this.value.length) fail(this.errorCode);
  }
}
