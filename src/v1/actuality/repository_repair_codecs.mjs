import { fail } from "../errors.mjs";

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export const LIMITS = Object.freeze({
  path: 256,
  goal: 4096,
  query: 256,
  excerpt: 512,
  file: 32 * 1024,
  process: 16 * 1024,
  summary: 4096,
  digest: 64,
  repository: 128,
  denialReason: 256,
  treeEntries: 128,
  searchHits: 32,
  changedFiles: 4,
  observations: 8,
  actions: 7,
  actionName: 15,
  actionDescription: 116
});

export const ACTION_TAG = Object.freeze({
  list_repository: 0,
  read_file: 1,
  search_text: 2,
  run_tests: 3,
  replace_file: 4,
  final: 5,
  abort: 6
});

export const OBSERVATION_TAG = Object.freeze({
  list_repository: 0,
  read_file: 1,
  search_text: 2,
  run_tests: 3,
  replace_file: 4
});

const FAILURE_NAMES = Object.freeze([
  "budget_exhausted",
  "history_overflow",
  "arithmetic_overflow",
  "invalid_index",
  "invalid_variant",
  "capacity_exceeded",
  "authored_abort"
]);

const ENTRY_KIND_NAMES = Object.freeze(["file", "directory"]);
const ACTION_KIND_NAMES = Object.freeze(["effect", "final", "fail"]);
const DECISION_PHASE_NAMES = Object.freeze(["decide", "propose", "reflect"]);
const REPLACE_OUTCOME_NAMES = Object.freeze(["applied", "denied", "conflict"]);

export function decodeListRequest(bytes) {
  return decode(bytes, "ERR_ACTUALITY_LIST_REQUEST", (reader) => {
    reader.finish();
    return Object.freeze({});
  });
}

export function decodeReadRequest(bytes) {
  return decode(bytes, "ERR_ACTUALITY_READ_REQUEST", (reader) => Object.freeze({
    path: reader.text(LIMITS.path, "path")
  }));
}

export function decodeSearchRequest(bytes) {
  return decode(bytes, "ERR_ACTUALITY_SEARCH_REQUEST", (reader) => Object.freeze({
    query: reader.text(LIMITS.query, "query"),
    pathPrefix: reader.text(LIMITS.path, "path_prefix")
  }));
}

export function decodeTestRequest(bytes) {
  return decode(bytes, "ERR_ACTUALITY_TEST_REQUEST", (reader) => Object.freeze({
    suite: reader.enumName(["default"], "suite")
  }));
}

export function decodeReplaceRequest(bytes) {
  return decode(bytes, "ERR_ACTUALITY_REPLACE_REQUEST", (reader) => Object.freeze({
    path: reader.text(LIMITS.path, "path"),
    expectedSha256: reader.digestText("expected_sha256"),
    replacement: reader.text(LIMITS.file, "replacement"),
    rationale: reader.text(LIMITS.summary, "rationale")
  }));
}

export function decodeDecisionRequest(bytes) {
  return decode(bytes, "ERR_ACTUALITY_DECISION_REQUEST", (reader) => {
    const instructions = reader.text(4096, "instructions");
    const actionCatalog = reader.vector(LIMITS.actions, "action_catalog", (_, index) => Object.freeze({
      name: reader.text(LIMITS.actionName, `action_catalog[${index}].name`),
      description: reader.text(
        LIMITS.actionDescription,
        `action_catalog[${index}].description`
      ),
      payloadSchemaDigest: reader.fixed(32).toString("hex"),
      kind: reader.enumName(ACTION_KIND_NAMES, `action_catalog[${index}].kind`)
    }));
    const goal = Object.freeze({
      task: reader.text(LIMITS.goal, "goal.task"),
      repository: reader.text(LIMITS.repository, "goal.repository")
    });
    const counters = Object.freeze({
      turns: reader.u32(),
      decisions: reader.u32(),
      effectActions: reader.u32(),
      childActions: reader.u32()
    });
    const phase = reader.enumName(DECISION_PHASE_NAMES, "phase");
    const history = reader.vector(
      LIMITS.observations,
      "history",
      () => decodeObservationFrom(reader)
    );
    return Object.freeze({
      instructions,
      actionCatalog,
      goal,
      counters,
      phase,
      history
    });
  });
}

export function encodeAction(value) {
  const [action, argumentsValue] = exactRecord(
    value,
    ["action", "arguments"],
    "ERR_ACTUALITY_ACTION",
    "action"
  );
  if (!Object.hasOwn(ACTION_TAG, action)) actualityFail("ERR_ACTUALITY_ACTION", "action");
  const writer = new Writer("ERR_ACTUALITY_ACTION");
  writer.u32(ACTION_TAG[action]);
  switch (action) {
    case "list_repository":
      exactRecord(argumentsValue, [], writer.errorCode, "arguments");
      break;
    case "read_file":
      encodeReadRequestInto(writer, argumentsValue);
      break;
    case "search_text":
      encodeSearchRequestInto(writer, argumentsValue);
      break;
    case "run_tests":
      encodeTestRequestInto(writer, argumentsValue);
      break;
    case "replace_file":
      encodeReplaceRequestInto(writer, argumentsValue);
      break;
    case "final":
      encodeFinalResultInto(writer, argumentsValue);
      break;
    case "abort":
      writer.enumValue(argumentsValue, FAILURE_NAMES, "arguments");
      break;
    default:
      actualityFail(writer.errorCode, "action");
  }
  return writer.finish();
}

export function decodeAction(bytes) {
  return decode(bytes, "ERR_ACTUALITY_ACTION", (reader) => {
    const action = reader.enumName(Object.keys(ACTION_TAG), "action");
    let argumentsValue;
    switch (action) {
      case "list_repository": argumentsValue = Object.freeze({}); break;
      case "read_file": argumentsValue = Object.freeze({
        path: reader.text(LIMITS.path, "arguments.path")
      }); break;
      case "search_text": argumentsValue = Object.freeze({
        query: reader.text(LIMITS.query, "arguments.query"),
        path_prefix: reader.text(LIMITS.path, "arguments.path_prefix")
      }); break;
      case "run_tests": argumentsValue = Object.freeze({
        suite: reader.enumName(["default"], "arguments.suite")
      }); break;
      case "replace_file": argumentsValue = Object.freeze({
        path: reader.text(LIMITS.path, "arguments.path"),
        expected_sha256: reader.digestText("arguments.expected_sha256"),
        replacement: reader.text(LIMITS.file, "arguments.replacement"),
        rationale: reader.text(LIMITS.summary, "arguments.rationale")
      }); break;
      case "final": argumentsValue = decodeFinalResultFrom(reader); break;
      case "abort": argumentsValue = reader.enumName(FAILURE_NAMES, "arguments"); break;
      default: actualityFail(reader.errorCode, "action");
    }
    return Object.freeze({ action, arguments: argumentsValue });
  });
}

export function decodeFinalResult(bytes) {
  return decode(bytes, "ERR_ACTUALITY_FINAL_RESULT", decodeFinalResultFrom);
}

export function encodeListResult(value) {
  const writer = new Writer("ERR_ACTUALITY_LIST_RESULT");
  const [entries] = exactRecord(value, ["entries"], writer.errorCode, "result");
  writer.vector(entries, LIMITS.treeEntries, "entries", (entry, index) => {
    const [path, kind, byteLength] = exactRecord(
      entry,
      ["path", "kind", "byteLength"],
      writer.errorCode,
      `entries[${index}]`
    );
    writer.text(path, LIMITS.path, `entries[${index}].path`);
    writer.enumValue(kind, ENTRY_KIND_NAMES, `entries[${index}].kind`);
    writer.u32Value(byteLength, `entries[${index}].byteLength`);
  });
  return writer.finish();
}

export function encodeReadResult(value) {
  const writer = new Writer("ERR_ACTUALITY_READ_RESULT");
  const [path, sha256, contents] = exactRecord(
    value,
    ["path", "sha256", "contents"],
    writer.errorCode,
    "result"
  );
  writer.text(path, LIMITS.path, "path");
  writer.digestText(sha256, "sha256");
  writer.text(contents, LIMITS.file, "contents");
  return writer.finish();
}

export function encodeSearchResult(value) {
  const writer = new Writer("ERR_ACTUALITY_SEARCH_RESULT");
  const [hits, truncated] = exactRecord(
    value,
    ["hits", "truncated"],
    writer.errorCode,
    "result"
  );
  writer.vector(hits, LIMITS.searchHits, "hits", (hit, index) => {
    const [path, line, excerpt] = exactRecord(
      hit,
      ["path", "line", "excerpt"],
      writer.errorCode,
      `hits[${index}]`
    );
    writer.text(path, LIMITS.path, `hits[${index}].path`);
    writer.u32Value(line, `hits[${index}].line`);
    writer.text(excerpt, LIMITS.excerpt, `hits[${index}].excerpt`);
  });
  writer.bool(truncated, "truncated");
  return writer.finish();
}

export function encodeTestResult(value) {
  const writer = new Writer("ERR_ACTUALITY_TEST_RESULT");
  const [exitCode, passed, stdout, stderr, stdoutTruncated, stderrTruncated] = exactRecord(
    value,
    ["exitCode", "passed", "stdout", "stderr", "stdoutTruncated", "stderrTruncated"],
    writer.errorCode,
    "result"
  );
  writer.i32Value(exitCode, "exitCode");
  writer.bool(passed, "passed");
  writer.text(stdout, LIMITS.process, "stdout");
  writer.text(stderr, LIMITS.process, "stderr");
  writer.bool(stdoutTruncated, "stdoutTruncated");
  writer.bool(stderrTruncated, "stderrTruncated");
  return writer.finish();
}

export function encodeReplaceOutcome(value) {
  const [kind, payload] = exactRecord(
    value,
    ["kind", "payload"],
    "ERR_ACTUALITY_REPLACE_OUTCOME",
    "result"
  );
  const writer = new Writer("ERR_ACTUALITY_REPLACE_OUTCOME");
  writer.enumValue(kind, REPLACE_OUTCOME_NAMES, "kind");
  switch (kind) {
    case "applied": {
      const [path, oldSha256, newSha256, alreadyApplied] = exactRecord(
        payload,
        ["path", "oldSha256", "newSha256", "alreadyApplied"],
        writer.errorCode,
        "payload"
      );
      writer.text(path, LIMITS.path, "payload.path");
      writer.digestText(oldSha256, "payload.oldSha256");
      writer.digestText(newSha256, "payload.newSha256");
      writer.bool(alreadyApplied, "payload.alreadyApplied");
      break;
    }
    case "denied": {
      const [reason] = exactRecord(payload, ["reason"], writer.errorCode, "payload");
      writer.text(reason, LIMITS.denialReason, "payload.reason");
      break;
    }
    case "conflict": {
      const [path, expectedSha256, actualSha256] = exactRecord(
        payload,
        ["path", "expectedSha256", "actualSha256"],
        writer.errorCode,
        "payload"
      );
      writer.text(path, LIMITS.path, "payload.path");
      writer.digestText(expectedSha256, "payload.expectedSha256");
      writer.digestText(actualSha256, "payload.actualSha256");
      break;
    }
    default:
      actualityFail(writer.errorCode, "kind");
  }
  return writer.finish();
}

function decodeObservationFrom(reader) {
  const kind = reader.enumName(Object.keys(OBSERVATION_TAG), "history.variant");
  let payload;
  switch (kind) {
    case "list_repository":
      payload = Object.freeze({
        entries: reader.vector(LIMITS.treeEntries, "history.entries", (_, index) => Object.freeze({
          path: reader.text(LIMITS.path, `history.entries[${index}].path`),
          kind: reader.enumName(ENTRY_KIND_NAMES, `history.entries[${index}].kind`),
          byteLength: reader.u32()
        }))
      });
      break;
    case "read_file":
      payload = Object.freeze({
        path: reader.text(LIMITS.path, "history.read.path"),
        sha256: reader.digestText("history.read.sha256"),
        contents: reader.text(LIMITS.file, "history.read.contents")
      });
      break;
    case "search_text":
      payload = Object.freeze({
        hits: reader.vector(LIMITS.searchHits, "history.hits", (_, index) => Object.freeze({
          path: reader.text(LIMITS.path, `history.hits[${index}].path`),
          line: reader.u32(),
          excerpt: reader.text(LIMITS.excerpt, `history.hits[${index}].excerpt`)
        })),
        truncated: reader.bool("history.search.truncated")
      });
      break;
    case "run_tests":
      payload = Object.freeze({
        exitCode: reader.i32(),
        passed: reader.bool("history.test.passed"),
        stdout: reader.text(LIMITS.process, "history.test.stdout"),
        stderr: reader.text(LIMITS.process, "history.test.stderr"),
        stdoutTruncated: reader.bool("history.test.stdout_truncated"),
        stderrTruncated: reader.bool("history.test.stderr_truncated")
      });
      break;
    case "replace_file": {
      const outcome = reader.enumName(REPLACE_OUTCOME_NAMES, "history.replace.variant");
      if (outcome === "applied") payload = Object.freeze({ kind: outcome, payload: Object.freeze({
        path: reader.text(LIMITS.path, "history.replace.path"),
        oldSha256: reader.digestText("history.replace.old_sha256"),
        newSha256: reader.digestText("history.replace.new_sha256"),
        alreadyApplied: reader.bool("history.replace.already_applied")
      }) });
      else if (outcome === "denied") payload = Object.freeze({ kind: outcome, payload: Object.freeze({
        reason: reader.text(LIMITS.denialReason, "history.replace.reason")
      }) });
      else payload = Object.freeze({ kind: outcome, payload: Object.freeze({
        path: reader.text(LIMITS.path, "history.replace.path"),
        expectedSha256: reader.digestText("history.replace.expected_sha256"),
        actualSha256: reader.digestText("history.replace.actual_sha256")
      }) });
      break;
    }
    default:
      actualityFail(reader.errorCode, "history.variant");
  }
  return Object.freeze({ kind, payload });
}

function encodeReadRequestInto(writer, value) {
  const [path] = exactRecord(value, ["path"], writer.errorCode, "arguments");
  writer.text(path, LIMITS.path, "arguments.path");
}

function encodeSearchRequestInto(writer, value) {
  const [query, pathPrefix] = exactRecord(
    value,
    ["query", "path_prefix"],
    writer.errorCode,
    "arguments"
  );
  writer.text(query, LIMITS.query, "arguments.query");
  writer.text(pathPrefix, LIMITS.path, "arguments.path_prefix");
}

function encodeTestRequestInto(writer, value) {
  const [suite] = exactRecord(value, ["suite"], writer.errorCode, "arguments");
  writer.enumValue(suite, ["default"], "arguments.suite");
}

function encodeReplaceRequestInto(writer, value) {
  const [path, expectedSha256, replacement, rationale] = exactRecord(
    value,
    ["path", "expected_sha256", "replacement", "rationale"],
    writer.errorCode,
    "arguments"
  );
  writer.text(path, LIMITS.path, "arguments.path");
  writer.digestText(expectedSha256, "arguments.expected_sha256");
  writer.text(replacement, LIMITS.file, "arguments.replacement");
  writer.text(rationale, LIMITS.summary, "arguments.rationale");
}

function encodeFinalResultInto(writer, value) {
  const [summary, changedFiles, testsPassed, finalSourceSha256] = exactRecord(
    value,
    ["summary", "changed_files", "tests_passed", "final_source_sha256"],
    writer.errorCode,
    "arguments"
  );
  writer.text(summary, LIMITS.summary, "arguments.summary");
  writer.vector(changedFiles, LIMITS.changedFiles, "arguments.changed_files", (path, index) => {
    writer.text(path, LIMITS.path, `arguments.changed_files[${index}]`);
  });
  writer.bool(testsPassed, "arguments.tests_passed");
  writer.digestText(finalSourceSha256, "arguments.final_source_sha256");
}

function decodeFinalResultFrom(reader) {
  return Object.freeze({
    summary: reader.text(LIMITS.summary, "arguments.summary"),
    changed_files: reader.vector(
      LIMITS.changedFiles,
      "arguments.changed_files",
      (_, index) => reader.text(LIMITS.path, `arguments.changed_files[${index}]`)
    ),
    tests_passed: reader.bool("arguments.tests_passed"),
    final_source_sha256: reader.digestText("arguments.final_source_sha256")
  });
}

function decode(bytes, errorCode, body) {
  const reader = new Reader(bytes, errorCode);
  const result = body(reader);
  reader.finish();
  return result;
}

function exactRecord(value, keys, errorCode, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    actualityFail(errorCode, label);
  }
  let descriptors;
  let prototype;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    actualityFail(errorCode, label);
  }
  if (prototype !== Object.prototype && prototype !== null) actualityFail(errorCode, label);
  const actualKeys = Reflect.ownKeys(descriptors);
  if (actualKeys.length !== keys.length || !keys.every((key) => Object.hasOwn(descriptors, key))) {
    actualityFail(errorCode, label);
  }
  return keys.map((key) => {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) actualityFail(errorCode, `${label}.${key}`);
    return descriptor.value;
  });
}

function actualityFail(code, label) {
  fail(code, label);
}

class Reader {
  constructor(value, errorCode) {
    if (!(value instanceof Uint8Array)) actualityFail(errorCode, "bytes");
    this.bytesValue = Buffer.from(value);
    this.offset = 0;
    this.errorCode = errorCode;
  }

  fixed(length) {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytesValue.length) {
      actualityFail(this.errorCode, "bytes");
    }
    const result = this.bytesValue.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  u32() { return this.fixed(4).readUInt32LE(); }
  i32() { return this.fixed(4).readInt32LE(); }

  bool(label) {
    const value = this.fixed(1)[0];
    if (value > 1) actualityFail(this.errorCode, label);
    return value === 1;
  }

  text(maximum, label) {
    const length = this.u32();
    if (length > maximum) actualityFail(this.errorCode, label);
    const bytes = this.fixed(length);
    try {
      const result = UTF8.decode(bytes);
      if (!Buffer.from(result, "utf8").equals(bytes)) actualityFail(this.errorCode, label);
      return result;
    } catch {
      actualityFail(this.errorCode, label);
    }
  }

  digestText(label) {
    const value = this.text(LIMITS.digest, label);
    if (!/^[0-9a-f]{64}$/.test(value)) actualityFail(this.errorCode, label);
    return value;
  }

  enumName(names, label) {
    const tag = this.u32();
    if (tag >= names.length) actualityFail(this.errorCode, label);
    return names[tag];
  }

  vector(maximum, label, decodeItem) {
    const length = this.u32();
    if (length > maximum) actualityFail(this.errorCode, label);
    return Object.freeze(Array.from({ length }, (_, index) => decodeItem(this, index)));
  }

  finish() {
    if (this.offset !== this.bytesValue.length) actualityFail(this.errorCode, "trailing_bytes");
  }
}

class Writer {
  constructor(errorCode) {
    this.parts = [];
    this.errorCode = errorCode;
  }

  fixed(value) { this.parts.push(Buffer.from(value)); }

  u32(value) {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(value);
    this.parts.push(bytes);
  }

  i32(value) {
    const bytes = Buffer.alloc(4);
    bytes.writeInt32LE(value);
    this.parts.push(bytes);
  }

  u32Value(value, label) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) actualityFail(this.errorCode, label);
    this.u32(value);
  }

  i32Value(value, label) {
    if (!Number.isInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff) {
      actualityFail(this.errorCode, label);
    }
    this.i32(value);
  }

  bool(value, label) {
    if (typeof value !== "boolean") actualityFail(this.errorCode, label);
    this.parts.push(Buffer.from([value ? 1 : 0]));
  }

  text(value, maximum, label) {
    if (typeof value !== "string") actualityFail(this.errorCode, label);
    const bytes = Buffer.from(value, "utf8");
    if (bytes.length > maximum || UTF8.decode(bytes) !== value) actualityFail(this.errorCode, label);
    this.u32(bytes.length);
    this.parts.push(bytes);
  }

  digestText(value, label) {
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) actualityFail(this.errorCode, label);
    this.text(value, LIMITS.digest, label);
  }

  enumValue(value, names, label) {
    const tag = names.indexOf(value);
    if (tag < 0) actualityFail(this.errorCode, label);
    this.u32(tag);
  }

  vector(value, maximum, label, encodeItem) {
    if (!Array.isArray(value) || value.length > maximum) actualityFail(this.errorCode, label);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== value.length + 1 || !Object.hasOwn(descriptors, "length")) {
      actualityFail(this.errorCode, label);
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(descriptors, String(index)) || !Object.hasOwn(descriptors[String(index)], "value")) {
        actualityFail(this.errorCode, `${label}[${index}]`);
      }
    }
    this.u32(value.length);
    for (let index = 0; index < value.length; index += 1) {
      encodeItem(descriptors[String(index)].value, index);
    }
  }

  finish() { return Buffer.concat(this.parts); }
}
