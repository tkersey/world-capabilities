import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPack, verifyPack, verifySelfContained } from "../harness/pack-utils.mjs";

test("negative pack is rejected", async () => {
  await expect(verifyPack(await loadPack("negative-pack", "examples"))).rejects.toThrow();
});

test("sidecar fixture imports are checksum covered", async () => {
  await verifySelfContained(await loadPack("sidecar-fixture"));
});

test("self-containment scanner supports shebang JavaScript", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-shebang-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.js"), "#!/usr/bin/env bun\nimport { helper } from \"./helper.js\";\nexport default helper;\n");
    await writeFile(join(dir, "helper.js"), "export const helper = true;\n");
    await verifySelfContained({
      name: "shebang-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.js" }, { path: "helper.js" }],
        metadata: { allowedBuiltins: [] }
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("self-containment scanner supports TypeScript artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-ts-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.ts"), "import { helper } from \"./helper\";\ntype Result = boolean;\nexport const result: Result = helper;\n");
    await writeFile(join(dir, "helper.ts"), "export const helper: boolean = true;\n");
    await verifySelfContained({
      name: "ts-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.ts" }, { path: "helper.ts" }],
        metadata: { allowedBuiltins: [] }
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extensionless JavaScript imports resolve against covered helpers", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-js-extensionless-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.js"), "import { helper } from \"./helper\";\nexport const result = helper;\n");
    await writeFile(join(dir, "helper.js"), "export const helper = true;\n");
    await verifySelfContained({
      name: "js-extensionless-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.js" }, { path: "helper.js" }],
        metadata: { allowedBuiltins: [] }
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extensionless imports reject uncovered runtime alternatives", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-extensionless-shadow-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.js"), "import { helper } from \"./helper\";\nexport const result = helper;\n");
    await writeFile(join(dir, "helper"), "export const helper = \"uncovered-exact\";\n");
    await writeFile(join(dir, "helper.js"), "export const helper = \"covered\";\n");
    await writeFile(join(dir, "helper.jsx"), "export const helper = \"uncovered\";\n");
    await expect(verifySelfContained({
      name: "extensionless-shadow-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.js" }, { path: "helper.js" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/local import \.\/helper not checksum-covered/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("covered extensionless import artifacts are scanned", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-extensionless-helper-scan-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.js"), "import \"./helper\";\nexport const result = true;\n");
    await writeFile(join(dir, "helper"), "process.stdout.write(\"leak\");\n");
    await expect(verifySelfContained({
      name: "extensionless-helper-scan-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.js" }, { path: "helper" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/process access rejected in helper/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit non-scannable local imports are rejected even when covered", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-non-scannable-import-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "import \"./addon.node\";\nexport const result = true;\n");
    await writeFile(join(dir, "addon.node"), "native fixture\n");
    await expect(verifySelfContained({
      name: "non-scannable-import-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }, { path: "addon.node" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/local import \.\/addon\.node uses unsupported extension/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extensionless imports cover every Bun runtime candidate", async () => {
  for (const ext of [".mjs", ".ts", ".tsx", ".mts", ".cts", ".json"]) {
    const root = await mkdtemp(join(tmpdir(), "world-extensionless-candidate-pack-"));
    try {
      const dir = join(root, "pack");
      await mkdir(dir);
      await writeFile(join(dir, "adapter.js"), "import { helper } from \"./helper\";\nexport const result = helper;\n");
      await writeFile(join(dir, "helper.js"), "export const helper = \"covered\";\n");
      await writeFile(join(dir, `helper${ext}`), ext === ".json" ? "{\"helper\":\"uncovered\"}\n" : "export const helper = \"uncovered\";\n");
      await expect(verifySelfContained({
        name: `extensionless-${ext.slice(1)}-candidate-pack`,
        dir,
        manifest: {
          artifacts: [{ path: "adapter.js" }, { path: "helper.js" }],
          metadata: { allowedBuiltins: [] }
        }
      })).rejects.toThrow(/local import \.\/helper not checksum-covered/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("directory imports resolve against covered index candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-directory-import-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(join(dir, "helper"), { recursive: true });
    await writeFile(join(dir, "adapter.mjs"), "import { helper } from \"./helper/\";\nexport const result = helper;\n");
    await writeFile(join(dir, "helper", "index.js"), "export const helper = \"unchecked\";\n");
    await writeFile(join(dir, "helper", ".js"), "export const helper = \"covered-shadow\";\n");
    await expect(verifySelfContained({
      name: "directory-import-shadow-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }, { path: "helper/.js" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/local import \.\/helper\/ not checksum-covered/);

    await verifySelfContained({
      name: "directory-import-index-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }, { path: "helper/index.js" }],
        metadata: { allowedBuiltins: [] }
      }
    });

    await writeFile(join(dir, "helper", "package.json"), "{\"main\":\"main.js\"}\n");
    await writeFile(join(dir, "helper", "main.js"), "export const helper = \"unchecked-main\";\n");
    await expect(verifySelfContained({
      name: "directory-import-package-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }, { path: "helper/index.js" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/package-backed directory import \.\/helper\/ rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CommonJS requires are self-containment checked", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-cjs-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.cjs"), "const childProcess = require(\"node:child_process\");\nconst childProcessRef = childProcess;\n");
    await expect(verifySelfContained({
      name: "cjs-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.cjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/unchecked builtin node:child_process/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CommonJS artifacts can use covered helpers with ordinary exports", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-cjs-covered-helper-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.cjs"), "const helper = require(\"./helper\");\nmodule.exports = helper;\n");
    await writeFile(join(dir, "helper.cjs"), "exports.helper = true;\n");
    await verifySelfContained({
      name: "cjs-covered-helper-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.cjs" }, { path: "helper.cjs" }],
        metadata: { allowedBuiltins: [] }
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dynamic CommonJS requires are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-dynamic-cjs-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.cjs"), "const mod = \"node:child_process\";\nconst childProcessRef = require(mod);\n");
    await expect(verifySelfContained({
      name: "dynamic-cjs-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.cjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/dynamic require rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("escaped dynamic CommonJS requires are normalized before rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-escaped-dynamic-cjs-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.cjs"), "const mod = \"node:child_process\";\nconst childProcessRef = requ\\u0069re(mod);\n");
    await expect(verifySelfContained({
      name: "escaped-dynamic-cjs-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.cjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/dynamic require rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("folded CommonJS require specifiers are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-folded-cjs-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.cjs"), "const childProcessRef = require(\"node:\" + \"child_process\");\n");
    await expect(verifySelfContained({
      name: "folded-cjs-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.cjs" }],
        metadata: { allowedBuiltins: ["node:child_process"] }
      }
    })).rejects.toThrow(/dynamic require rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createRequire alias loaders are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-create-require-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "import { createRequire as cr } from \"node:module\";\nconst r = cr(import.meta.url);\nexport default r(\"node:child_process\");\n");
    await expect(verifySelfContained({
      name: "create-require-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: ["node:module"] }
      }
    })).rejects.toThrow(/unsafe loader rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("indirect eval and optional Function calls are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-indirect-eval-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "(0, eval)(\"1 + 1\");\nFunction?.(\"return 1\");\n");
    await expect(verifySelfContained({
      name: "indirect-eval-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/unsafe loader rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("aliased eval and Function loaders are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-aliased-eval-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const F = Function;\nconst run = eval;\nconst o = { F: Function };\nconst t = `${Function(\"return process\")()}`;\nF(\"return this\")();\nrun(\"1 + 1\");\no.F(\"return this\")();\n");
    await expect(verifySelfContained({
      name: "aliased-eval-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/unsafe loader rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("benign constructor methods and global names are allowed", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-benign-loader-words-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "import \"./global-helper.mjs\";\nconst label = `Function eval global`;\nclass Safe { constructor() {} }\nexport default { Safe, label };\n");
    await writeFile(join(dir, "global-helper.mjs"), "export const ok = true;\n");
    await verifySelfContained({
      name: "benign-loader-words-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }, { path: "global-helper.mjs" }],
        metadata: { allowedBuiltins: [] }
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("node module loader builtin is rejected even with computed access", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-node-module-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "import * as mod from /* comment */ \"node:module\";\nconst r = mod[\"create\" + \"Require\"](\"file:///tmp/adapter.mjs\");\nexport default r(\"node:child_process\");\n");
    await expect(verifySelfContained({
      name: "node-module-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: ["node:module"] }
      }
    })).rejects.toThrow(/unsafe loader rejected|loader builtin node:module rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CommonJS module loader aliases are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-cjs-module-loader-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.cjs"), "module.exports = module.constructor._load(\"node:child_process\");\n");
    await expect(verifySelfContained({
      name: "cjs-module-loader-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.cjs" }],
        metadata: { allowedBuiltins: ["node:child_process"] }
      }
    })).rejects.toThrow(/unsafe loader rejected|CommonJS module loader rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("literal CommonJS requires still honor allowed builtins", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-literal-cjs-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.cjs"), "const crypto = require(\"node:crypto\");\nconst cryptoRef = crypto;\n");
    await verifySelfContained({
      name: "literal-cjs-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.cjs" }],
        metadata: { allowedBuiltins: ["node:crypto"] }
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("code execution builtins are rejected even when allowlisted", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-code-exec-builtin-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "import childProcess from \"node:child_process\";\nexport default childProcess;\n");
    await expect(verifySelfContained({
      name: "code-exec-builtin-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: ["node:child_process"] }
      }
    })).rejects.toThrow(/code execution builtin node:child_process rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process spawning builtins are rejected even when allowlisted", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-process-spawn-builtin-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "import cluster from \"node:cluster\";\nexport default cluster;\n");
    await expect(verifySelfContained({
      name: "process-spawn-builtin-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: ["node:cluster"] }
      }
    })).rejects.toThrow(/code execution builtin node:cluster rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("comment-hidden dynamic imports are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-comment-dynamic-import-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "export default import/*hide*/(\"node:fs/promises\");\n");
    await expect(verifySelfContained({
      name: "comment-dynamic-import-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: ["node:fs/promises"] }
      }
    })).rejects.toThrow(/dynamic import rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("string-literal block comment markers cannot hide forbidden process access", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-comment-marker-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const open = \"/*\";\nprocess.getBuiltinModule(\"node:child_process\");\nconst close = \"*/\";\n");
    await expect(verifySelfContained({
      name: "comment-marker-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/unsafe loader rejected|process access rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Bun import.meta.require loaders are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-import-meta-require-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "export default import.meta.require(\"node:child_process\");\n");
    await expect(verifySelfContained({
      name: "import-meta-require-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/unsafe loader rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bracketed process builtin loaders are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-process-loader-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "export default process[\"getBuiltinModule\"](\"node:child_process\");\n");
    await expect(verifySelfContained({
      name: "process-loader-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/unsafe loader rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("computed reflective loader access is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-reflect-loader-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "export default Reflect.get(process, \"getBuiltinModule\")(\"node:child_process\");\n");
    await expect(verifySelfContained({
      name: "reflect-loader-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/unsafe loader rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("indirect Function constructors are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-constructor-loader-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "export default ({}).constructor.constructor(\"return this\")()[\"pro\" + \"cess\"];\n");
    await expect(verifySelfContained({
      name: "constructor-loader-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/unsafe loader rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("computed constructor property loaders are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-computed-constructor-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "export default ({})[\"constr\" + \"uctor\"];\n");
    await expect(verifySelfContained({
      name: "computed-constructor-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/unsafe loader rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("split computed member loader construction is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-split-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = [\"con\", \"structor\"].join(\"\");\nexport default ({})[key];\n");
    await expect(verifySelfContained({
      name: "split-computed-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/computed member access rejected|unsafe loader rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("optional and destructured computed members are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-optional-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"process\";\nconst { safe, [key]: p } = {};\nexport default p?.[\"stdout\"];\n");
    await expect(verifySelfContained({
      name: "optional-computed-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/computed member access rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("array literals are not treated as computed member access", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-array-literal-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "export const matrix = [[1], [2]];\n");
    await verifySelfContained({
      name: "array-literal-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: [] }
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process loader aliases are rejected while stdout sidecar remains allowed", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-process-alias-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "export default ((p) => p.getBuiltinModule(\"node:child_process\"))(process);\n");
    await expect(verifySelfContained({
      name: "process-alias-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/process access rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process output is allowed only for sidecar artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-process-stdout-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "process.stderr.write(\"leak\");\n");
    await writeFile(join(dir, "sidecar.mjs"), "process.stdout.write(\"ok\");\nprocess.stderr.write(\"diag\");\nprocess.stderr.write(\"again\");\n");
    await expect(verifySelfContained({
      name: "process-stdout-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs", role: "adapter" }, { path: "sidecar.mjs", role: "sidecar" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["bun", "sidecar.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    })).rejects.toThrow(/process access rejected/);
    await verifySelfContained({
      name: "process-stdout-sidecar-pack",
      dir,
      manifest: {
        artifacts: [{ path: "sidecar.mjs", role: "sidecar" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["bun", "sidecar.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Bun and global host aliases are rejected outside sidecar stdin", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-bun-global-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "Bun.spawn([\"echo\", \"x\"]);\n");
    await writeFile(join(dir, "sidecar.mjs"), "Bun.stdin.stream();\nBun.stdin.stream();\n");
    await expect(verifySelfContained({
      name: "bun-global-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs", role: "adapter" }, { path: "sidecar.mjs", role: "sidecar" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["bun", "sidecar.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    })).rejects.toThrow(/Bun access rejected/);
    await verifySelfContained({
      name: "bun-stdin-sidecar-pack",
      dir,
      manifest: {
        artifacts: [{ path: "sidecar.mjs", role: "sidecar" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["bun", "sidecar.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sidecar IO allowance follows the declared runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-sidecar-runtime-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "sidecar.mjs"), "Bun.stdin.stream();\nprocess.stdout.write(\"ok\");\n");
    await expect(verifySelfContained({
      name: "node-sidecar-bun-io-pack",
      dir,
      manifest: {
        artifacts: [{ path: "sidecar.mjs", role: "sidecar" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["node", "sidecar.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    })).rejects.toThrow(/Bun access rejected/);

    await writeFile(join(dir, "sidecar.mjs"), "let text = \"\";\nfor await (const chunk of process.stdin) text += chunk;\nprocess.stdout.write(text);\nprocess.stderr.write(\"diag\");\n");
    await verifySelfContained({
      name: "node-sidecar-process-io-pack",
      dir,
      manifest: {
        artifacts: [{ path: "sidecar.mjs", role: "sidecar" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["node", "sidecar.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    });

    await writeFile(join(dir, "sidecar.mjs"), "await Deno.stdout.write(new Uint8Array());\nawait Deno.stderr.write(new Uint8Array());\nDeno.stdin.readable;\n");
    await expect(verifySelfContained({
      name: "bun-sidecar-deno-io-pack",
      dir,
      manifest: {
        artifacts: [{ path: "sidecar.mjs", role: "sidecar" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["bun", "sidecar.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    })).rejects.toThrow(/Deno access rejected/);

    await expect(verifySelfContained({
      name: "deno-sidecar-without-run-pack",
      dir,
      manifest: {
        artifacts: [{ path: "sidecar.mjs", role: "sidecar" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["deno", "sidecar.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    })).rejects.toThrow(/deno run subcommand required/);

    await verifySelfContained({
      name: "deno-sidecar-stdio-pack",
      dir,
      manifest: {
        artifacts: [{ path: "sidecar.mjs", role: "sidecar" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["deno", "run", "sidecar.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sidecar IO allowance is bound to the declared entrypoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-sidecar-entrypoint-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "process.stdout.write(\"leak\");\n");
    await writeFile(join(dir, "sidecar.mjs"), "export default true;\n");
    await expect(verifySelfContained({
      name: "sidecar-entrypoint-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs", role: "sidecar" }, { path: "sidecar.mjs", role: "sidecar" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["bun", "sidecar.mjs"] }
        }
      }
    })).rejects.toThrow(/process access rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sidecar command entrypoint follows the executable artifact extension set", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-sidecar-extension-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "sidecar.mts"), "process.stdout.write(\"ok\");\n");
    await verifySelfContained({
      name: "sidecar-mts-pack",
      dir,
      manifest: {
        artifacts: [{ path: "sidecar.mts", role: "sidecar" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["bun", "sidecar.mts"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sidecar command rejects preload arguments before entrypoint selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-sidecar-preload-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "loader.jsx"), "export default true;\n");
    await writeFile(join(dir, "sidecar.mjs"), "process.stdout.write(\"ok\");\n");
    await expect(verifySelfContained({
      name: "sidecar-preload-pack",
      dir,
      manifest: {
        artifacts: [{ path: "loader.jsx", role: "sidecar" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["bun", "--preload", "loader.jsx", "sidecar.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    })).rejects.toThrow(/preload flag rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sidecar command entrypoint is bound to the runtime target", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-sidecar-runtime-target-pack-"));
  try {
    for (const [name, command] of [
      ["bun-script", ["bun", "run", "script", "sidecar.mjs"]],
      ["deno-package", ["deno", "run", "npm:example", "sidecar.mjs"]]
    ]) {
      const dir = join(root, name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "sidecar.mjs"), "export default true;\n");
      await expect(verifySelfContained({
        name: `${name}-pack`,
        dir,
        manifest: {
          artifacts: [{ path: "sidecar.mjs", role: "sidecar" }],
          metadata: {
            allowedBuiltins: [],
            sidecar: { command, stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
          }
        }
      })).rejects.toThrow(/sidecar entrypoint missing/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Deno host globals are rejected in sidecar artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-deno-global-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "sidecar.mjs"), "Deno.Command(\"sh\", { args: [\"-c\", \"echo pwn\"] });\n");
    await expect(verifySelfContained({
      name: "deno-global-pack",
      dir,
      manifest: {
        artifacts: [{ path: "sidecar.mjs", role: "sidecar" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/Deno access rejected/);

    await expect(verifySelfContained({
      name: "deno-command-sidecar-pack",
      dir,
      manifest: {
        artifacts: [{ path: "sidecar.mjs", role: "sidecar" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["deno", "run", "sidecar.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    })).rejects.toThrow(/Deno access rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("optional-chained CommonJS globals are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-optional-cjs-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.cjs"), "const childProcess = module?.constructor._load(\"node:child_process\");\n");
    await expect(verifySelfContained({
      name: "optional-cjs-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.cjs" }],
        metadata: { allowedBuiltins: ["node:child_process"] }
      }
    })).rejects.toThrow(/unsafe loader rejected|CommonJS module loader rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("escaped CommonJS globals are normalized before rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-escaped-cjs-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.cjs"), "mod\\u0075le.constructor._load(\"node:\" + \"child_process\");\n");
    await expect(verifySelfContained({
      name: "escaped-cjs-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.cjs" }],
        metadata: { allowedBuiltins: ["node:child_process"] }
      }
    })).rejects.toThrow(/unsafe loader rejected|CommonJS module loader rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pack artifacts and imports must stay inside the pack root", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-pack-root-"));
  try {
    const packDir = join(root, "foo");
    const siblingDir = join(root, "foo-extra");
    await mkdir(packDir);
    await mkdir(siblingDir);
    await writeFile(join(packDir, "adapter.mjs"), "import \"../foo-extra/helper.mjs\";\n");
    await writeFile(join(siblingDir, "helper.mjs"), "export const helper = true;\n");
    await expect(verifySelfContained({
      name: "foo",
      dir: packDir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }, { path: "../foo-extra/helper.mjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/host path import|artifact path escapes pack root/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pack imports allow in-root dot-dot-prefixed names", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-pack-dotdot-prefix-"));
  try {
    const packDir = join(root, "pack");
    const helperDir = join(packDir, "..helpers");
    await mkdir(packDir);
    await mkdir(helperDir);
    await writeFile(join(packDir, "adapter.mjs"), "import \"./..helpers/helper.mjs\";\n");
    await writeFile(join(helperDir, "helper.mjs"), "export const helper = true;\n");
    await verifySelfContained({
      name: "dotdot-prefix-pack",
      dir: packDir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }, { path: "..helpers/helper.mjs" }],
        metadata: { allowedBuiltins: [] }
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("symlinked pack artifacts must not point outside the pack root", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-pack-symlink-"));
  try {
    const packDir = join(root, "pack");
    const siblingDir = join(root, "pack-extra");
    await mkdir(packDir);
    await mkdir(siblingDir);
    await writeFile(join(packDir, "adapter.mjs"), "import \"./helper.mjs\";\n");
    await writeFile(join(siblingDir, "helper.mjs"), "export const helper = true;\n");
    await symlink(join(siblingDir, "helper.mjs"), join(packDir, "helper.mjs"));
    await expect(verifySelfContained({
      name: "symlink-pack",
      dir: packDir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }, { path: "helper.mjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/artifact path escapes pack root/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
