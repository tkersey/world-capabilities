import { expect, test } from "bun:test";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPack,
  scannerExecutableCodeSourceForTest,
  scannerHasComputedMemberAccessForTest,
  verifyPack,
  verifySelfContained
} from "../harness/pack-utils.mjs";

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

test("dotted extensionless imports resolve against covered helpers", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-dotted-extensionless-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.js"), "import { helper } from \"./helper.v1\";\nexport const result = helper;\n");
    await writeFile(join(dir, "helper.v1.js"), "export const helper = true;\n");
    await verifySelfContained({
      name: "dotted-extensionless-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.js" }, { path: "helper.v1.js" }],
        metadata: { allowedBuiltins: [] }
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dotted extensionless directory imports resolve against covered index candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-dotted-directory-index-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(join(dir, "helper.v1"), { recursive: true });
    await writeFile(join(dir, "adapter.js"), "import { helper } from \"./helper.v1\";\nexport const result = helper;\n");
    await writeFile(join(dir, "helper.v1", "index.js"), "export const helper = true;\n");
    await verifySelfContained({
      name: "dotted-directory-index-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.js" }, { path: "helper.v1/index.js" }],
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
    await writeFile(join(dir, "adapter-no-slash.mjs"), "import { helper } from \"./helper\";\nexport const result = helper;\n");
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

    await verifySelfContained({
      name: "directory-import-extensionless-index-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter-no-slash.mjs" }, { path: "helper/index.js" }],
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
    await expect(verifySelfContained({
      name: "extensionless-directory-import-package-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter-no-slash.mjs" }, { path: "helper/index.js" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/package-backed directory import \.\/helper rejected/);
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

test("CommonJS extensionless requires reject package-backed directories even with covered direct candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-cjs-package-backed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(join(dir, "helper"), { recursive: true });
    await writeFile(join(dir, "adapter.cjs"), "const helper = require(\"./helper\");\nmodule.exports = helper;\n");
    await writeFile(join(dir, "helper.cjs"), "module.exports = \"covered\";\n");
    await writeFile(join(dir, "helper", "package.json"), "{\"main\":\"main.cjs\"}\n");
    await writeFile(join(dir, "helper", "main.cjs"), "module.exports = \"unchecked\";\n");
    await expect(verifySelfContained({
      name: "cjs-package-backed-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.cjs" }, { path: "helper.cjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/package-backed directory import \.\/helper rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CommonJS extensionless requires reject native addon candidates", async () => {
  for (const [name, specifier, helperPath, nativePath, expectedImport] of [
    ["direct", "./helper", "helper.cjs", "helper.node", /local import \.\/helper uses unsupported runtime extension/],
    ["index", "./helper", "helper.cjs", "helper/index.node", /local import \.\/helper uses unsupported runtime extension/],
    ["dotted", "./helper.v1", "helper.v1.cjs", "helper.v1.node", /local import \.\/helper\.v1 uses unsupported runtime extension/]
  ]) {
    const root = await mkdtemp(join(tmpdir(), "world-cjs-native-candidate-pack-"));
    try {
      const dir = join(root, "pack");
      await mkdir(dir, { recursive: true });
      if (nativePath.includes("/")) {
        await mkdir(join(dir, nativePath.split("/").slice(0, -1).join("/")), { recursive: true });
      }
      await writeFile(join(dir, "adapter.cjs"), `const helper = require("${specifier}");\nmodule.exports = helper;\n`);
      await writeFile(join(dir, helperPath), "module.exports = \"covered\";\n");
      await writeFile(join(dir, nativePath), "native fixture\n");
      await expect(verifySelfContained({
        name: `cjs-native-${name}-candidate-pack`,
        dir,
        manifest: {
          artifacts: [{ path: "adapter.cjs" }, { path: helperPath }],
          metadata: { allowedBuiltins: [] }
        }
      })).rejects.toThrow(expectedImport);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("non-Bun sidecars require explicit local specifiers", async () => {
  for (const [name, artifact, source, metadata] of [
    [
      "node-cjs",
      { path: "sidecar.cjs", role: "sidecar" },
      "const helper = require(\"./helper\");\nprocess.stdout.write(String(helper));\n",
      { allowedBuiltins: [], sidecar: { command: ["node", "sidecar.cjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 } }
    ],
    [
      "node-esm",
      { path: "sidecar.mjs", role: "sidecar" },
      "import \"./helper\";\nprocess.stdout.write(\"ok\");\n",
      { allowedBuiltins: [], sidecar: { command: ["node", "sidecar.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 } }
    ],
    [
      "node-dotted",
      { path: "sidecar.cjs", role: "sidecar" },
      "const helper = require(\"./helper.v1\");\nprocess.stdout.write(String(helper));\n",
      { allowedBuiltins: [], sidecar: { command: ["node", "sidecar.cjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 } }
    ],
    [
      "deno",
      { path: "sidecar.mjs", role: "sidecar" },
      "import \"./helper\";\nawait Deno.stdout.write(new Uint8Array());\n",
      { allowedBuiltins: [], sidecar: { command: ["deno", "run", "sidecar.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 } }
    ]
  ]) {
    const root = await mkdtemp(join(tmpdir(), "world-explicit-sidecar-import-pack-"));
    try {
      const dir = join(root, "pack");
      await mkdir(dir);
      await writeFile(join(dir, artifact.path), source);
      await writeFile(join(dir, "helper.mjs"), "export default true;\n");
      await writeFile(join(dir, "helper.cjs"), "module.exports = true;\n");
      await expect(verifySelfContained({
        name: `explicit-sidecar-${name}-pack`,
        dir,
        manifest: {
          artifacts: [artifact, { path: "helper.mjs", role: "helper" }, { path: "helper.cjs", role: "helper" }],
          metadata
        }
      })).rejects.toThrow(/non-Bun sidecar extensionless local import \.\/helper(?:\.v1)? rejected/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Node ESM sidecars reject JSON imports without verifiable attributes", async () => {
  for (const [name, artifactPath, packageJson] of [
    ["mjs", "sidecar.mjs", null],
    ["mts", "sidecar.mts", null],
    ["module-js", "sidecar.js", "{\"type\":\"module\"}\n"],
    ["syntax-js", "sidecar.js", null],
    ["syntax-ts", "sidecar.ts", null]
  ]) {
    const root = await mkdtemp(join(tmpdir(), "world-node-json-import-pack-"));
    try {
      const dir = join(root, "pack");
      await mkdir(dir);
      if (packageJson) await writeFile(join(dir, "package.json"), packageJson);
      await writeFile(join(dir, artifactPath), "import data from \"./data.json\";\nprocess.stdout.write(String(data.ok));\n");
      await writeFile(join(dir, "data.json"), "{\"ok\":true}\n");
      const artifacts = [{ path: artifactPath, role: "sidecar" }, { path: "data.json", role: "helper" }];
      if (packageJson) artifacts.push({ path: "package.json", role: "helper" });
      await expect(verifySelfContained({
        name: `node-json-import-${name}-pack`,
        dir,
        manifest: {
          artifacts,
          metadata: {
            allowedBuiltins: [],
            sidecar: { command: ["node", artifactPath], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
          }
        }
      })).rejects.toThrow(/sidecar JSON import requires verifiable import attributes/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Deno sidecars reject JSON imports without verifiable attributes", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-deno-json-import-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "sidecar.mjs"), "import data from \"./data.json\";\nvoid data;\n");
    await writeFile(join(dir, "data.json"), "{\"ok\":true}\n");
    await expect(verifySelfContained({
      name: "deno-json-import-pack",
      dir,
      manifest: {
        artifacts: [{ path: "sidecar.mjs", role: "sidecar" }, { path: "data.json", role: "helper" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["deno", "run", "sidecar.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    })).rejects.toThrow(/sidecar JSON import requires verifiable import attributes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Node sidecar entrypoints cannot import adapter modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-node-sidecar-adapter-import-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "sidecar.mjs"), "import \"./adapter.mjs\";\nprocess.stdout.write(\"ok\");\n");
    await writeFile(join(dir, "adapter.mjs"), "import data from \"./data.json\";\nexport default data;\n");
    await writeFile(join(dir, "data.json"), "{\"ok\":true}\n");
    await expect(verifySelfContained({
      name: "node-sidecar-adapter-import-pack",
      dir,
      manifest: {
        artifacts: [
          { path: "sidecar.mjs", role: "sidecar" },
          { path: "adapter.mjs", role: "adapter" },
          { path: "data.json", role: "helper" }
        ],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["node", "sidecar.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    })).rejects.toThrow(/sidecar adapter import rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Node sidecar helpers cannot import adapter modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-node-sidecar-helper-adapter-import-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "sidecar.mjs"), "import \"./helper.mjs\";\nprocess.stdout.write(\"ok\");\n");
    await writeFile(join(dir, "helper.mjs"), "import \"./adapter.mjs\";\nexport default true;\n");
    await writeFile(join(dir, "adapter.mjs"), "export default true;\n");
    await expect(verifySelfContained({
      name: "node-sidecar-helper-adapter-import-pack",
      dir,
      manifest: {
        artifacts: [
          { path: "sidecar.mjs", role: "sidecar" },
          { path: "helper.mjs", role: "helper" },
          { path: "adapter.mjs", role: "adapter" }
        ],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["node", "sidecar.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    })).rejects.toThrow(/sidecar adapter import rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Node sidecar package type must be checksum covered", async () => {
  for (const [name, packageJsonDir] of [
    ["pack", "pack"],
    ["parent", "."]
  ]) {
    const root = await mkdtemp(join(tmpdir(), "world-node-package-type-covered-pack-"));
    try {
      const dir = join(root, "pack");
      await mkdir(dir);
      await writeFile(join(root, packageJsonDir, "package.json"), "{\"type\":\"module\"}\n");
      await writeFile(join(dir, "sidecar.js"), "process.stdout.write(\"ok\");\n");
      await expect(verifySelfContained({
        name: `node-package-type-covered-${name}-pack`,
        dir,
        manifest: {
          artifacts: [{ path: "sidecar.js", role: "sidecar" }],
          metadata: {
            allowedBuiltins: [],
            sidecar: { command: ["node", "sidecar.js"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
          }
        }
      })).rejects.toThrow(/Node sidecar package\.json not checksum-covered/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Node CommonJS sidecars allow covered JSON requires", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-node-json-require-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "sidecar.cjs"), "const data = require(\"./data.json\");\nprocess.stdout.write(String(data.ok));\n");
    await writeFile(join(dir, "data.json"), "{\"ok\":true}\n");
    await verifySelfContained({
      name: "node-json-require-pack",
      dir,
      manifest: {
        artifacts: [{ path: "sidecar.cjs", role: "sidecar" }, { path: "data.json", role: "helper" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["node", "sidecar.cjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Node sidecar helper artifacts reject unsupported runtime extensions", async () => {
  for (const [ext, source] of [
    [".tsx", "export const helper: string = \"covered\";\n"],
    [".jsx", "export const helper = \"covered\";\n"]
  ]) {
    const root = await mkdtemp(join(tmpdir(), "world-node-runtime-extension-pack-"));
    try {
      const dir = join(root, "pack");
      await mkdir(dir);
      await writeFile(join(dir, "sidecar.mts"), `import { helper } from "./helper${ext}";\nprocess.stdout.write(String(helper));\n`);
      await writeFile(join(dir, `helper${ext}`), source);
      await expect(verifySelfContained({
        name: `node-runtime-extension-${ext.slice(1)}-pack`,
        dir,
        manifest: {
          artifacts: [
            { path: "sidecar.mts", role: "sidecar" },
            { path: `helper${ext}`, role: "helper" }
          ],
          metadata: {
            allowedBuiltins: [],
            sidecar: { command: ["node", "sidecar.mts"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
          }
        }
      })).rejects.toThrow(new RegExp(`Node sidecar unsupported runtime artifact rejected in helper\\${ext}`));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("non-Bun sidecars reject encoded parent-segment imports even when covered", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-encoded-parent-sidecar-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(join(dir, "%2e%2e"), { recursive: true });
    await writeFile(join(dir, "sidecar.mjs"), "import { marker } from \"./%2e%2e/evil.mjs\";\nprocess.stdout.write(marker);\n");
    await writeFile(join(dir, "%2e%2e", "evil.mjs"), "export const marker = \"covered\";\n");
    await expect(verifySelfContained({
      name: "encoded-parent-sidecar-pack",
      dir,
      manifest: {
        artifacts: [
          { path: "sidecar.mjs", role: "sidecar" },
          { path: "%2e%2e/evil.mjs", role: "helper" }
        ],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["node", "sidecar.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    })).rejects.toThrow(/encoded dot segment import \.\/%2e%2e\/evil\.mjs rejected/);
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

test("require-looking string and regex literals are allowed", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-require-literal-text-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const msg = \"require is unavailable\";\nconst regex = /require/;\nexport default regex.test(msg);\n");
    await verifySelfContained({
      name: "require-literal-text-pack",
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

test("require-looking string literals do not consume scanned CommonJS requires", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-cjs-require-literal-before-static-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(
      join(dir, "adapter.cjs"),
      "const msg = 'require(\"node:crypto\")';\nconst crypto = require(\"node:crypto\");\nmodule.exports = Boolean(crypto.randomUUID && msg);\n"
    );
    await verifySelfContained({
      name: "cjs-require-literal-before-static-pack",
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

test("require-looking comments do not consume scanned CommonJS requires", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-cjs-require-comment-before-static-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(
      join(dir, "adapter.cjs"),
      "//! require(\"node:crypto\")\nconst crypto = require(\"node:crypto\");\nmodule.exports = Boolean(crypto.randomUUID);\n"
    );
    await verifySelfContained({
      name: "cjs-require-comment-before-static-pack",
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

test("commented static CommonJS requires are stripped", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-cjs-commented-static-require-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.cjs"), "const helper = require /* static */ (\"./helper.cjs\");\nmodule.exports = helper.value;\n");
    await writeFile(join(dir, "helper.cjs"), "module.exports = { value: true };\n");
    await verifySelfContained({
      name: "cjs-commented-static-require-pack",
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

test("template-form static CommonJS requires are stripped", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-cjs-template-require-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(
      join(dir, "adapter.cjs"),
      "const diagnostic = `require(\"node:crypto\")`;\nconst crypto = require(`node:crypto`);\nconst id = `${require(\"node:crypto\").randomUUID}`;\nmodule.exports = Boolean(crypto.randomUUID && id && diagnostic);\n"
    );
    await verifySelfContained({
      name: "cjs-template-require-pack",
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

test("descriptor-based Function recovery is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-descriptor-function-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "export default Object.getOwnPropertyDescriptor(Object.getPrototypeOf(function(){}), \"constructor\").value(\"return this\")();\n");
    await expect(verifySelfContained({
      name: "descriptor-function-pack",
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

test("aliased reflective Function recovery is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-aliased-reflective-function-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const { getOwnPropertyDescriptor, getPrototypeOf } = Object;\nconst R = Reflect;\nconst F = getOwnPropertyDescriptor(getPrototypeOf(function(){}), \"constructor\").value;\nexport default R.get({ F }, \"F\")(\"return process\")();\n");
    await expect(verifySelfContained({
      name: "aliased-reflective-function-pack",
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

test("literal constructor destructuring is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-constructor-destructure-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const { constructor: F } = function() {};\nexport default F(\"return process\")();\n");
    await expect(verifySelfContained({
      name: "constructor-destructure-pack",
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

test("shorthand constructor destructuring is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-shorthand-constructor-destructure-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const { constructor } = function() {};\nexport default constructor(\"return process\")();\n");
    await expect(verifySelfContained({
      name: "shorthand-constructor-destructure-pack",
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

test("default constructor destructuring is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-default-constructor-destructure-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const { constructor = function noop() {} } = function() {};\nexport default constructor(\"return process\")();\n");
    await expect(verifySelfContained({
      name: "default-constructor-destructure-pack",
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

test("host global names inside literals are allowed", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-benign-global-literals-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "export const label = \"process Bun Deno\";\nexport const diagnostic = `process Bun Deno`;\nexport default { label, diagnostic };\n");
    await verifySelfContained({
      name: "benign-global-literals-pack",
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

test("host global names inside non-ASCII identifiers are allowed", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-unicode-global-identifier-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), [
      "const \u03c0process = 1;",
      "const process\u03c0 = 2;",
      "const \u03c0Bun = 3;",
      "const Deno\u03c0 = 4;",
      "const \u03c0Function = 5;",
      "const \u03c0globalThis = { x: 6 };",
      "const \u03c0global = { x: 7 };",
      "const \u03c0self = { x: 8 };",
      "const \u03c0Reflect = { get: 9 };",
      "const \u03c0Object = { x: 10 };",
      "const \u03c0getPrototypeOf = () => 11;",
      "const \u03c0getOwnPropertyDescriptor = () => 12;",
      "const \u03c0createRequire = () => 12;",
      "const \u03c0with = () => 13;",
      "export default \u03c0process + process\u03c0 + \u03c0Bun + Deno\u03c0 + \u03c0Function + \u03c0globalThis.x + \u03c0global.x + \u03c0self.x + \u03c0Reflect.get + \u03c0Object.x + \u03c0getPrototypeOf() + \u03c0getOwnPropertyDescriptor() + \u03c0createRequire() + \u03c0with();",
      ""
    ].join("\n"));
    await verifySelfContained({
      name: "unicode-global-identifier-pack",
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

test("host global names inside private identifiers are allowed", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-private-global-identifier-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), [
      "class SafeNames {",
      "  #process = 1;",
      "  #require() { return this.#process; }",
      "  read() { return this.#require(); }",
      "}",
      "export default new SafeNames().read();",
      ""
    ].join("\n"));
    await verifySelfContained({
      name: "private-global-identifier-pack",
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

test("host global names inside regex literals are allowed", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-benign-global-regex-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "export const labels = [/process/, /Function/, /Bun|Deno/];\nexport default labels;\n");
    await verifySelfContained({
      name: "benign-global-regex-pack",
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

test("regex literals after statement blocks are allowed", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-block-regex-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const value = \"process\";\nif (value) {} /process|require/.test(value);\nexport default value;\n");
    await verifySelfContained({
      name: "block-regex-pack",
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

test("regex literals after declaration blocks are allowed", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-declaration-regex-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const value = \"process\";\nfunction marker() {}\n/process|require/.test(value);\nclass Holder {}\n/Function|globalThis/.test(value);\nexport default value;\n");
    await verifySelfContained({
      name: "declaration-regex-pack",
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

test("function expression divisions after braces still expose host globals", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-function-expression-division-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const value = function () {} / process.env / 1;\nexport default value;\n");
    await expect(verifySelfContained({
      name: "function-expression-division-pack",
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

test("object literal divisions after braces still expose host globals", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-object-division-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const value = ({}) / process.env / 1;\nexport default value;\n");
    await expect(verifySelfContained({
      name: "object-division-pack",
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

test("host global names inside preserved comments are allowed", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-benign-global-comment-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "//! process require Function\nexport default 1;\n");
    await verifySelfContained({
      name: "benign-global-comment-pack",
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

test("host global names in executable code are still rejected after regex stripping", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-global-code-after-regex-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "export const label = /safe/;\nexport const leaked = 1 / process.pid;\n");
    await expect(verifySelfContained({
      name: "global-code-after-regex-pack",
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

test("network globals require explicit authority labels", async () => {
  for (const [name, source] of [
    ["fetch", "export default fetch;\n"],
    ["websocket", "export default WebSocket;\n"]
  ]) {
    const root = await mkdtemp(join(tmpdir(), `world-network-global-${name}-pack-`));
    try {
      const dir = join(root, "pack");
      await mkdir(dir);
      await writeFile(join(dir, "adapter.mjs"), source);
      await expect(verifySelfContained({
        name: `network-global-${name}-pack`,
        dir,
        manifest: {
          artifacts: [{ path: "adapter.mjs" }],
          metadata: { allowedBuiltins: [] }
        }
      })).rejects.toThrow(/network global access rejected/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("network authority labels allow network globals", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-network-authority-global-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "export default fetch;\n");
    await verifySelfContained({
      name: "network-authority-global-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        authorityLabels: ["network.http"],
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
    })).rejects.toThrow(/computed member access rejected|unsafe loader rejected|loader builtin node:module rejected/);
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

test("CommonJS wrapper arguments cannot alias require", async () => {
  for (const [name, artifactPath, source, metadata] of [
    [
      "adapter-cjs",
      "adapter.cjs",
      "const [, r] = arguments;\nmodule.exports = r(\"node:fs\");\n",
      { allowedBuiltins: [] }
    ],
    [
      "adapter-arrow-cjs",
      "adapter.cjs",
      "const leak = () => { const [, r] = arguments; return r(\"node:fs\"); };\nmodule.exports = leak();\n",
      { allowedBuiltins: [] }
    ],
    [
      "node-cts",
      "sidecar.cts",
      "const [, r] = arguments;\nr(\"node:fs\");\nprocess.stdout.write(\"ok\");\n",
      { allowedBuiltins: [], sidecar: { command: ["node", "sidecar.cts"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 } }
    ],
    [
      "node-cts-type-alias-parenthesized",
      "sidecar.cts",
      "type T = string\n([, r] = arguments);\nr(\"node:fs\");\nprocess.stdout.write(\"ok\");\n",
      { allowedBuiltins: [], sidecar: { command: ["node", "sidecar.cts"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 } }
    ],
    [
      "node-cts-optimizer-erased",
      "sidecar.cts",
      "/* @__PURE__ */ Array.prototype.at.call(arguments, 1)(\"node:fs\");\nprocess.stdout.write(\"ok\");\n",
      { allowedBuiltins: [], sidecar: { command: ["node", "sidecar.cts"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 } }
    ],
    [
      "node-arrow-cts",
      "sidecar.cts",
      "const leak = () => { const [, r] = arguments; return r(\"node:fs\"); };\nleak();\nprocess.stdout.write(\"ok\");\n",
      { allowedBuiltins: [], sidecar: { command: ["node", "sidecar.cts"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 } }
    ]
  ]) {
    const root = await mkdtemp(join(tmpdir(), `world-cjs-wrapper-arguments-${name}-pack-`));
    try {
      const dir = join(root, "pack");
      await mkdir(dir);
      await writeFile(join(dir, artifactPath), source);
      await expect(verifySelfContained({
        name: `cjs-wrapper-arguments-${name}-pack`,
        dir,
        manifest: {
          artifacts: [{ path: artifactPath, role: artifactPath === "adapter.cjs" ? "adapter" : "sidecar" }],
          metadata
        }
      })).rejects.toThrow(/CommonJS wrapper arguments rejected/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("CommonJS wrapper arguments check allows nested function arguments", async () => {
  for (const [name, artifactPath, source, metadata] of [
    [
      "adapter-cjs",
      "adapter.cjs",
      "function count() { return arguments.length; }\nfunction outer() { return () => arguments.length; }\nmodule.exports = count(1, 2) + outer(1, 2)();\n",
      { allowedBuiltins: [] }
    ],
    [
      "node-cts",
      "sidecar.cts",
      "function count() { return arguments.length; }\nfunction outer() { return () => arguments.length; }\nprocess.stdout.write(String(count(1, 2) + outer(1, 2)()));\n",
      { allowedBuiltins: [], sidecar: { command: ["node", "sidecar.cts"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 } }
    ]
  ]) {
    const root = await mkdtemp(join(tmpdir(), `world-cjs-nested-arguments-${name}-pack-`));
    try {
      const dir = join(root, "pack");
      await mkdir(dir);
      await writeFile(join(dir, artifactPath), source);
      await verifySelfContained({
        name: `cjs-nested-arguments-${name}-pack`,
        dir,
        manifest: {
          artifacts: [{ path: artifactPath, role: artifactPath === "adapter.cjs" ? "adapter" : "sidecar" }],
          metadata
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("contextual keyword divisions stay visible to loader scans", () => {
  for (const keyword of ["yield", "await"]) {
    const codeSource = scannerExecutableCodeSourceForTest(`var ${keyword} = 1;\nconst x = 1;\nmodule.exports = ${keyword} / module.constructor._load("node:child_process") / x;\n`);
    expect(codeSource).toContain("module.constructor._load");
    expect(scannerHasComputedMemberAccessForTest(`var ${keyword} = {};\n${keyword}["constructor"];\n`)).toBe(true);
  }
});

test("CommonJS module-loader-looking string and regex literals are allowed", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-cjs-module-literal-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.cjs"), "const msg = \"module.constructor\";\nconst regex = /module.constructor/;\nmodule.exports = regex.test(msg);\n");
    await verifySelfContained({
      name: "cjs-module-literal-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.cjs" }],
        metadata: { allowedBuiltins: [] }
      }
    });
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

test("process builtin aliases are rejected even when allowlisted", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-process-builtin-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "import { getBuiltinModule } from \"node:process\";\nexport default getBuiltinModule(\"node:child_process\");\n");
    await expect(verifySelfContained({
      name: "process-builtin-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs" }],
        metadata: { allowedBuiltins: ["node:process"] }
      }
    })).rejects.toThrow(/loader builtin node:process rejected/);
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

test("Unicode line separators terminate line comments before optimizer-resistant scans", async () => {
  for (const [name, terminator] of [
    ["line", String.fromCharCode(0x2028)],
    ["paragraph", String.fromCharCode(0x2029)]
  ]) {
    const root = await mkdtemp(join(tmpdir(), "world-unicode-line-comment-pack-"));
    try {
      const dir = join(root, "pack");
      await mkdir(dir);
      await writeFile(
        join(dir, "adapter.mjs"),
        `if (false) {// hide${terminator}Function("return process")();\n}\nexport default 1;\n`
      );
      await expect(verifySelfContained({
        name: `unicode-line-comment-${name}-pack`,
        dir,
        manifest: {
          artifacts: [{ path: "adapter.mjs" }],
          metadata: { allowedBuiltins: [] }
        }
      })).rejects.toThrow(/unsafe loader rejected|process access rejected/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("property names before division do not hide host globals", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-property-division-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const obj = { in: 1, instanceof: 1 };\nexport default obj.in / process.env / 1 || obj.instanceof / Function(\"return process\")() / 1;\n");
    await expect(verifySelfContained({
      name: "property-division-pack",
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

test("bare of before division does not hide host globals", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-of-division-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const of = 1;\nexport default of / process.env / 1;\n");
    await expect(verifySelfContained({
      name: "of-division-pack",
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

test("keyword-suffixed identifiers before division do not hide host globals", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-keyword-suffix-division-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const $in = 1;\nexport default $in / process.env / 1;\n");
    await expect(verifySelfContained({
      name: "keyword-suffix-division-pack",
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

test("unicode identifiers ending with keywords before division do not hide host globals", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-unicode-keyword-suffix-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const \\u03c0in = 1;\nexport default \\u03c0in / Function(\"return process\")() / 1;\n");
    await expect(verifySelfContained({
      name: "unicode-keyword-suffix-pack",
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

test("classic for of identifier divisions do not hide host globals", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-for-of-division-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const of = 1;\nfor (let x = of / process.env / 1; false; ) {}\nfor (of / process.env / 1; false; ) {}\nexport default of;\n");
    await expect(verifySelfContained({
      name: "for-of-division-pack",
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

test("for-of RHS of identifiers do not hide divisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-for-of-rhs-of-division-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const of = 1;\nfor (const x of of / process.env / 1 || []) {}\nexport default of;\n");
    await expect(verifySelfContained({
      name: "for-of-rhs-of-division-pack",
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

test("word operators before of divisions do not hide host globals", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-instanceof-of-division-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const of = function() {};\nfor (let ok = ({} instanceof of / Function(\"return process\")() / 1); false; ) {}\nexport default of;\n");
    await expect(verifySelfContained({
      name: "instanceof-of-division-pack",
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

test("unary word operators before of divisions do not hide host globals", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-typeof-of-division-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const of = 1;\nfor (typeof of / process.env / 1; false; ) {}\nexport default of;\n");
    await expect(verifySelfContained({
      name: "typeof-of-division-pack",
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

test("slash operators before of divisions do not hide host globals", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-slash-of-division-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "let x = 1;\nconst of = 1;\nfor (x / of / process.env / 1; false; ) {}\nexport default of;\n");
    await expect(verifySelfContained({
      name: "slash-of-division-pack",
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

test("property calls ending with control keywords before division do not hide host globals", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-property-control-call-division-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const obj = { if: () => 1 };\nexport default obj.if() / process.env / 1;\n");
    await expect(verifySelfContained({
      name: "property-control-call-division-pack",
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

test("Worker aliases are rejected before unchecked worker execution", async () => {
  for (const [name, source] of [
    ["alias", "const W = Worker;\nexport default new W(\"./unchecked.mjs\");\n"],
    ["subclass", "class W extends Worker {}\nexport default new W(\"./unchecked.mjs\");\n"]
  ]) {
    const root = await mkdtemp(join(tmpdir(), "world-worker-alias-pack-"));
    try {
      const dir = join(root, "pack");
      await mkdir(dir);
      await writeFile(join(dir, "adapter.mjs"), source);
      await expect(verifySelfContained({
        name: `worker-${name}-pack`,
        dir,
        manifest: {
          artifacts: [{ path: "adapter.mjs" }],
          metadata: { allowedBuiltins: [] }
        }
      })).rejects.toThrow(/unsafe loader rejected/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

test("unicode computed loader access is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-unicode-computed-loader-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const \u03c0 = () => {};\nexport default \u03c0[\"constructor\"](\"return process\")();\n");
    await expect(verifySelfContained({
      name: "unicode-computed-loader-pack",
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
    })).rejects.toThrow(/computed member access rejected|unsafe loader rejected/);
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

test("multiline destructured computed members are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-multiline-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"constructor\";\nconst { safe,\n  [key]: F } = function() {};\nexport default F(\"return process\")();\n");
    await expect(verifySelfContained({
      name: "multiline-computed-pack",
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

test("regex braces before destructuring do not hide computed members", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-regex-brace-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"constructor\";\nconst foo = {};\nlet F;\nif (Math.random()) /{/.test(\"\");\nconst { a = foo instanceof /}/,\n  [key]: G } = function() {};\nconst { a: { b = (() => { for (const x of /}/) {} })(), [key]: H } } = { a: function() {} };\n({ [key]: F } = function() {});\nexport default (F || G || H)(\"return process\")();\n");
    await expect(verifySelfContained({
      name: "regex-brace-computed-pack",
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

test("regex literals in parameter defaults do not hide computed members", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-default-regex-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"constructor\";\nfunction run({ a = (() => { do /{/.test(\"\"); while(false); })(), [key]: F }) { return F(\"return process\")(); }\nexport default run(function() {});\n");
    await expect(verifySelfContained({
      name: "default-regex-computed-pack",
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

test("template regex braces do not hide computed destructuring", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-template-regex-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"constructor\";\nlet F;\n`${/}/.test(\"}\") && ({ [key]: F } = function() {})}`;\nexport default F(\"return process\")();\n");
    await expect(verifySelfContained({
      name: "template-regex-computed-pack",
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

test("template control-body regex braces do not hide computed destructuring", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-template-control-regex-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"constructor\";\nlet F;\nconst fn = function() {};\n`${(() => { if (true) /}/.test(\"\"); })(), ({ [key]: F } = fn)}`;\nexport default F(\"return process\")();\n");
    await expect(verifySelfContained({
      name: "template-control-regex-computed-pack",
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

test("template new-regex braces do not hide computed destructuring", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-template-new-regex-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"constructor\";\nlet F;\n`${new /}/, ({ [key]: F } = function() {})}`;\nexport default F(\"return process\")();\n");
    await expect(verifySelfContained({
      name: "template-new-regex-computed-pack",
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

test("regex defaults with computed-looking text do not create computed patterns", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-regex-default-text-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const { y, x = /,[a]:/ } = {};\nexport default x.test(y ?? \"\");\n");
    await verifySelfContained({
      name: "regex-default-text-pack",
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

test("computed-looking string and regex literals are allowed", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-computed-literal-text-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const text = \"object[key]\";\nconst regex = /name[abc]/;\nexport default regex.test(text);\n");
    await verifySelfContained({
      name: "computed-literal-text-pack",
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

test("computed member access on literal receivers is rejected", async () => {
  for (const [name, source] of [
    ["string", "const key = \"constructor\";\nexport default \"abc\"[key];\n"],
    ["number", "const key = \"constructor\";\nexport default 0[key];\n"],
    ["bigint", "const key = \"constructor\";\nexport default 1n[key];\n"],
    ["regex", "const key = \"constructor\";\nexport default /abc/[key];\n"]
  ]) {
    const root = await mkdtemp(join(tmpdir(), "world-literal-receiver-computed-pack-"));
    try {
      const dir = join(root, "pack");
      await mkdir(dir);
      await writeFile(join(dir, "adapter.mjs"), source);
      await expect(verifySelfContained({
        name: `literal-receiver-${name}-computed-pack`,
        dir,
        manifest: {
          artifacts: [{ path: "adapter.mjs" }],
          metadata: { allowedBuiltins: [] }
        }
      })).rejects.toThrow(/computed member access rejected/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("keyword-named property computed access is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-keyword-property-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const F = ({ return() {} }).return[\"constructor\"];\nexport default F(\"return process\")();\n");
    await expect(verifySelfContained({
      name: "keyword-property-computed-pack",
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

test("unsafe-loader-looking string and regex literals are allowed", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-loader-literal-text-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const label = \"import.meta globalThis object.constructor process.getBuiltinModule\";\nconst regex = /globalThis|object\\.constructor|import\\.meta/;\nexport default regex.test(label);\n");
    await verifySelfContained({
      name: "loader-literal-text-pack",
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

test("array literals and with-named methods are not unsafe loaders", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-loader-syntax-context-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const name = \"world\";\nconst xs = [\"hello \" + name];\nconst items = [1, 2, 3];\nexport default { xs, changed: items.with(0, 0) };\n");
    await verifySelfContained({
      name: "loader-syntax-context-pack",
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

test("array and regex literals after await and yield are not unsafe loaders", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-loader-async-generator-literal-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "export async function asyncValues(value) {\n  const xs = await [value];\n  return await /process/.test(String(xs));\n}\nexport function* generatorValues(value) {\n  yield [value];\n  yield /process/.test(String(value));\n}\n");
    await verifySelfContained({
      name: "loader-async-generator-literal-pack",
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

test("top-level await before array and regex literals is allowed in ESM artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-loader-top-level-await-literal-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const value = \"safe\";\nconst xs = await [value];\nconst ok = await /process/.test(String(xs));\nconst req = await /require/.test(String(xs));\nexport default { xs, ok, req };\n");
    await verifySelfContained({
      name: "loader-top-level-await-literal-pack",
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

test("assignment destructured computed members are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-assignment-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"constructor\";\nlet F, target;\ntarget = { [key]: F } = function() {};\nexport default F(\"return process\")();\n");
    await expect(verifySelfContained({
      name: "assignment-computed-pack",
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

test("division before assignment destructured computed members does not hide them", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-division-assignment-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"constructor\";\nlet n = 1;\nlet F;\nn++ / ({ [key]: F } = function() {}) / 1;\nexport default F(\"return process\")();\n");
    await expect(verifySelfContained({
      name: "division-assignment-computed-pack",
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

test("identifier calls ending with control keywords before division do not hide computed members", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-identifier-control-call-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"constructor\";\nconst fn = function() {};\nconst $if = () => 1;\nlet F;\n$if() / ({ [key]: F } = fn) / 1;\nexport default F(\"return process\")();\n");
    await expect(verifySelfContained({
      name: "identifier-control-call-computed-pack",
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

test("keyword-like identifiers before sequence methods do not hide computed destructuring", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-keyword-identifier-sequence-method-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"constructor\";\nconst $extends = 1;\nlet leaked;\n($extends, class {}, { m({ [key]: F }) { leaked = F(\"return process\")(); } }).m(function() {});\nexport default leaked;\n");
    await expect(verifySelfContained({
      name: "keyword-identifier-sequence-method-pack",
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

test("nested destructured computed members are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-nested-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"constructor\";\nlet F;\n([{ [key]: F }] = [function() {}]);\nexport default F(\"return process\")();\n");
    await expect(verifySelfContained({
      name: "nested-computed-pack",
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

test("expression destructured computed members are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-expression-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"constructor\";\nlet F;\nexport default function run() {\n  return { [key]: F } = function() {}, F(\"return process\")();\n}\n");
    await expect(verifySelfContained({
      name: "expression-computed-pack",
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

test("parameter destructured computed members are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-parameter-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"constructor\";\nfunction extendsWrapper({ [key]: F }) { return F(\"return process\")(); }\nconst o = { for({ [key]: F }) { return F(\"return process\")(); } };\nclass C { if({ [key]: F }) { return F(\"return process\")(); } extends({ [key]: F }) { return F(\"return process\")(); } }\nexport default (({ [key]: F }) => F(\"return process\")())(function() {}) || extendsWrapper(function() {}) || o.for(function() {}) || new C().if(function() {}) || new C().extends(function() {});\n");
    await expect(verifySelfContained({
      name: "parameter-computed-pack",
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

test("array parameter destructured computed members are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-array-parameter-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"constructor\";\nexport default (([{ [key]: F }]) => F(\"return process\")())([function() {}]) || ((x, [{ [key]: F }]) => F(\"return process\")())(null, [function() {}]);\n");
    await expect(verifySelfContained({
      name: "array-parameter-computed-pack",
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

test("deep array destructured computed members are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-deep-array-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"constructor\";\nlet F, x;\n([[{ [key]: F }]] = [[function() {}]]);\n([x, [{ [key]: F }]] = [null, [function() {}]]);\nexport default F(\"return process\")();\n");
    await expect(verifySelfContained({
      name: "deep-array-computed-pack",
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

test("array rest target destructured computed members are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-array-rest-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"constructor\";\nlet F;\n[...{ [key]: F }] = [function() {}];\nexport default F(\"return process\")();\n");
    await expect(verifySelfContained({
      name: "array-rest-computed-pack",
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

test("for-await destructured computed members are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-for-await-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"constructor\";\nlet F;\nconst xs = [function() {}];\nfor await ({ [key]: F } of xs);\nexport default F(\"return process\")();\n");
    await expect(verifySelfContained({
      name: "for-await-computed-pack",
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

test("comma-list destructured computed members are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-comma-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"constructor\";\nlet F;\n((_, { [key]: G }) => { F = G; })(null, function() {});\n[_, { [key]: F }] = [null, function() {}];\nexport default F(\"return process\")();\n");
    await expect(verifySelfContained({
      name: "comma-computed-pack",
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

test("rest parameter array destructured computed members are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-rest-parameter-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"constructor\";\nlet F;\nfunction run(...[{ [key]: G }]) { F = G; }\nfunction runObjectRest(first, ...{ [key]: G }) { F = G; }\nfunction runArrayRest(first, ...[{ [key]: G }]) { F = G; }\nrun(function() {});\nrunObjectRest(null, function() {});\nrunArrayRest(null, function() {});\nexport default F(\"return process\")();\n");
    await expect(verifySelfContained({
      name: "rest-parameter-computed-pack",
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
    await writeFile(join(dir, "adapter.mjs"), "export const matrix = [[1], [2]];\nexport function values() {\n  for (const value of []) if (value) return [];\n  return [];\n}\n");
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

test("control-body array literals are not treated as computed member access", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-control-array-literal-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const value = \"a\";\nif (value) [\"a\"].includes(value);\nwhile (false) [\"b\"].includes(value);\nexport default value;\n");
    await verifySelfContained({
      name: "control-array-literal-pack",
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

test("array binding patterns are not treated as computed member access", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-array-binding-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const tuple = [1, 2];\nconst [first] = tuple;\nlet total = first;\nfor (const [row] of [[2]]) total += row;\nexport default total;\n");
    await verifySelfContained({
      name: "array-binding-pack",
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

test("contextual of computed member access is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-contextual-of-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"safe\";\nconst of = { safe: true };\nexport default of[key];\n");
    await expect(verifySelfContained({
      name: "contextual-of-computed-pack",
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

test("classic for initializer of computed member access is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-for-initializer-of-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"constructor\";\nconst of = function() {};\nfor (let x = of[key](\"return process\")(); false;) {}\nexport default true;\n");
    await expect(verifySelfContained({
      name: "for-initializer-of-computed-pack",
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

test("for-of RHS of computed member access is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-for-of-rhs-of-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"safe\";\nconst of = { safe: [] };\nfor (const value of of[key]) {}\nexport default true;\n");
    await expect(verifySelfContained({
      name: "for-of-rhs-of-computed-pack",
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

test("for-await RHS array literals are not treated as computed members", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-for-await-array-literal-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "let value = 0;\nfor await (const item of [Promise.resolve(1)]) value += item;\nexport default value;\n");
    await verifySelfContained({
      name: "for-await-array-literal-pack",
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

test("ternary array literals inside blocks are not treated as computed members", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-ternary-array-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "export function result(ok) {\n  return ok ? [\"ok\"] : [\"failed\"];\n}\n");
    await verifySelfContained({
      name: "ternary-array-pack",
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

test("deep nested safe blocks do not overflow computed object scanning", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-deep-safe-block-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    const depth = 2500;
    await writeFile(join(dir, "adapter.mjs"), `let ok = 0;\n${"{\n".repeat(depth)}ok += 1;\n${"}\n".repeat(depth)}export default ok;\n`);
    await verifySelfContained({
      name: "deep-safe-block-pack",
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

test("computed-key object literals in expression positions are allowed", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-computed-object-literal-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"label\";\nconst other = {};\nconst mixin = (value) => class { static value = value; };\nconst make = () => mixin;\nconst foo = () => ({ bar: mixin });\nfor ({ safe: 0, [key]: 11 }; false; ) {}\nexport const direct = { [key]: 1 };\nexport const fromCall = Object.freeze({ [key]: 2 });\nexport const fromArray = [{ [key]: 3 }];\nexport const fromDefault = (({ x = { [key]: 4 } } = {}) => x)();\nexport const fromTernaryDefault = (({ ok, x = ok ? null : { [key]: 5 } } = { ok: false }) => x)();\nexport const fromTernaryArrayDefault = (({ ok, x = ok ? null : [{ [key]: 12 }] } = { ok: false }) => x)();\nexport const same = ({ [key]: 6 } === other);\nexport const nestedCallDefault = ([x = make(null, { [key]: 10 })] = []) => x;\nexport class Mixed extends mixin({ [key]: 7 }) {}\nexport class ChainedMixed extends make()({ [key]: 8 }) {}\nexport class HeritageChainMixed extends foo({}).bar({ [key]: 9 }) {}\n");
    await verifySelfContained({
      name: "computed-object-literal-pack",
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

test("large comma-separated object literal lists scan without rescans", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-large-comma-object-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    const args = Array.from({ length: 2000 }, (_, index) => `({ value: ${index} })`).join(", ");
    await writeFile(join(dir, "adapter.mjs"), `const count = (...values) => values.length;\nexport default count(${args});\n`);
    await verifySelfContained({
      name: "large-comma-object-pack",
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

test("computed-key object literals in control conditions are allowed", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-control-condition-object-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"label\";\nexport function result(value) {\n  if ({ safe: 0, [key]: 1 }) {}\n  while (value && { safe: 1, [key]: 2 }) break;\n  switch ({ safe: 2, [key]: 3 }) { default: break; }\n  return true;\n}\n");
    await verifySelfContained({
      name: "control-condition-object-pack",
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

test("nested semicolons in extends expressions keep computed object literals allowed", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-extends-nested-semicolon-object-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"label\";\nconst mixin = (options) => class { static options = options; };\nexport class C extends (function() { const x = 1; return mixin; })()({ [key]: 1 }) {}\nexport class D extends (class { static { const y = 1; } static make() { return mixin; } }).make()({ [key]: 2 }) {}\n");
    await verifySelfContained({
      name: "extends-nested-semicolon-object-pack",
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

test("function parameters inside extends still reject destructured computed members", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-extends-function-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"constructor\";\nlet leaked;\nconst mixin = (value) => class {};\nexport class C extends (function({ [key]: F }) { leaked = F(\"return process\")(); return class {}; })(function() {}) {}\nexport class G extends (function* ({ [key]: F }) { leaked = F(\"return process\")(); yield class {}; })(function() {}).next().value {}\nexport class M extends mixin({ m({ [key]: F }) { leaked = F(\"return process\")(); } }) {}\nexport class AM extends mixin({ async m({ safe, [key]: F }) { leaked = F(\"return process\")(); }, *g({ [key]: G }) { leaked = G(\"return process\")(); }, [key]({ [key]: H }) { leaked = H(\"return process\")(); }, 0({ [key]: Z }) { leaked = Z(\"return process\")(); }, \"not id\"({ [key]: Q }) { leaked = Q(\"return process\")(); } }) {}\nexport class NM extends mixin([{ m({ [key]: F }) { leaked = F(\"return process\")(); } }, { nested: { async n({ [key]: N }) { leaked = N(\"return process\")(); } } }]) {}\nexport class S extends class {} { static { try { class D extends class {} {} } catch ({ [key]: F }) { leaked = F(\"return process\")(); } const o = { async m({ safe, [key]: F }) { leaked = F(\"return process\")(); }, *g({ [key]: G }) { leaked = G(\"return process\")(); }, [key]({ [key]: H }) { leaked = H(\"return process\")(); } }; void o; } }\nexport default leaked;\n");
    await expect(verifySelfContained({
      name: "extends-function-computed-pack",
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

test("unicode-named function parameters inside extends reject destructured computed members", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-extends-unicode-function-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"constructor\";\nlet leaked;\nexport class C extends (function π({ [key]: F }) { leaked = F(\"return process\")(); return class {}; })(function() {}) {}\nexport default leaked;\n");
    await expect(verifySelfContained({
      name: "extends-unicode-function-computed-pack",
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

test("nested class methods inside extends reject destructured computed members", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-extends-class-method-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"constructor\";\nlet leaked;\nconst mixin = (value) => class {};\nexport class C extends mixin(class { static async m({ [key]: F }) { leaked = F(\"return process\")(); } }) {}\nexport default leaked;\n");
    await expect(verifySelfContained({
      name: "extends-class-method-computed-pack",
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

test("unicode-named methods inside extends reject destructured computed members", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-extends-unicode-method-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"constructor\";\nlet leaked;\nconst mixin = (value) => class {};\nconst methods = { π({ [key]: F }) { leaked = F(\"return process\")(); } };\nexport class C extends mixin(methods.π(function() {})) {}\nexport default leaked;\n");
    await expect(verifySelfContained({
      name: "extends-unicode-method-computed-pack",
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

test("bigint-named methods inside extends reject destructured computed members", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-extends-bigint-method-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"constructor\";\nlet leaked;\nconst mixin = (value) => class {};\nconst run = (o) => { const { 1: m } = o; return m(function() {}); };\nexport class C extends mixin(run({ 1n({ [key]: F }) { leaked = F(\"return process\")(); } })) {}\nexport default leaked;\n");
    await expect(verifySelfContained({
      name: "extends-bigint-method-computed-pack",
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

test("private class methods inside extends reject destructured computed members", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-extends-private-method-computed-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "const key = \"constructor\";\nlet leaked;\nconst mixin = (value) => class {};\nexport class C extends mixin(class { #m({ [key]: F }) { leaked = F(\"return process\")(); } call(v) { return this.#m(v); } }) {}\nexport default leaked;\n");
    await expect(verifySelfContained({
      name: "extends-private-method-computed-pack",
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

test("bare global object recovery is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-bare-global-recovery-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(
      join(dir, "adapter.mjs"),
      "const descriptors = Object.values(Object.getOwnPropertyDescriptors(globalThis));\nexport default descriptors.find((d) => d.get?.()?.versions?.node || d.value?.versions?.node);\n"
    );
    await expect(verifySelfContained({
      name: "bare-global-recovery-pack",
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

test("plural descriptor Function recovery is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-plural-descriptor-function-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(
      join(dir, "adapter.mjs"),
      "const descriptors = Object.values(Object.getOwnPropertyDescriptors(function(){}.__proto__));\nconst F = descriptors.find((descriptor) => descriptor.value?.name === \"Function\").value;\nexport default F(\"return process\")();\n"
    );
    await expect(verifySelfContained({
      name: "plural-descriptor-function-pack",
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

test("CJS with-scope Function recovery is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-cjs-with-constructor-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(
      join(dir, "adapter.cjs"),
      "with (function(){}.__proto__) {\n  module.exports = constructor(\"return process\")();\n}\n"
    );
    await expect(verifySelfContained({
      name: "cjs-with-constructor-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.cjs" }],
        metadata: { allowedBuiltins: [] }
      }
    })).rejects.toThrow(/unsafe loader rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("security scans reject optimizer-folded environment branches", async () => {
  for (const [name, artifact, source, metadata] of [
    [
      "adapter",
      { path: "adapter.mjs", role: "adapter" },
      "if (process.env.NODE_ENV === \"production\") Function(\"return process\")().exit(7);\nexport default true;\n",
      { allowedBuiltins: [] }
    ],
    [
      "node-sidecar",
      { path: "sidecar.mts", role: "sidecar" },
      "type Handler = Function;\nif (process.env.NODE_ENV === \"production\") Function(\"return process\")().exit(7);\nprocess.stdout.write(\"ok\");\n",
      { allowedBuiltins: [], sidecar: { command: ["node", "sidecar.mts"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 } }
    ],
    [
      "node-sidecar-bracket-env",
      { path: "sidecar.mts", role: "sidecar" },
      "type Handler = Function;\nif (process['env'].NODE_ENV === \"production\") Function(\"return process\")().exit(7);\nprocess.stdout.write(\"ok\");\n",
      { allowedBuiltins: [], sidecar: { command: ["node", "sidecar.mts"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 } }
    ],
    [
      "node-sidecar-bracket-node-env",
      { path: "sidecar.mts", role: "sidecar" },
      "type Handler = Function;\nif (process.env[\"NODE_ENV\"] === \"production\") Function(\"return process\")().exit(7);\nprocess.stdout.write(\"ok\");\n",
      { allowedBuiltins: [], sidecar: { command: ["node", "sidecar.mts"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 } }
    ],
    [
      "node-sidecar-escaped-process-env",
      { path: "sidecar.mts", role: "sidecar" },
      "type Handler = Function;\nif (pro\\u0063ess.env.NODE_ENV === \"production\") Function(\"return process\")().exit(7);\nprocess.stdout.write(\"ok\");\n",
      { allowedBuiltins: [], sidecar: { command: ["node", "sidecar.mts"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 } }
    ],
    [
      "node-sidecar-commented-node-env",
      { path: "sidecar.mts", role: "sidecar" },
      "type Handler = Function;\nif (process.env/**/.NODE_ENV === \"production\") Function(\"return process\")().exit(7);\nprocess.stdout.write(\"ok\");\n",
      { allowedBuiltins: [], sidecar: { command: ["node", "sidecar.mts"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 } }
    ],
    [
      "node-sidecar-unicode-line-comment-node-env",
      { path: "sidecar.mts", role: "sidecar" },
      `type Handler = Function;\nif (process//${String.fromCharCode(0x2028)}.env.NODE_ENV === "production") Function("return process")().exit(7);\nprocess.stdout.write("ok");\n`,
      { allowedBuiltins: [], sidecar: { command: ["node", "sidecar.mts"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 } }
    ],
    [
      "node-sidecar-bun-env",
      { path: "sidecar.mts", role: "sidecar" },
      "type Handler = Function;\nif (process.env.BUN_ENV === \"production\") Function(\"return process\")().exit(7);\nprocess.stdout.write(\"ok\");\n",
      { allowedBuiltins: [], sidecar: { command: ["node", "sidecar.mts"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 } }
    ]
  ]) {
    const root = await mkdtemp(join(tmpdir(), "world-optimizer-env-pack-"));
    try {
      const dir = join(root, "pack");
      await mkdir(dir);
      await writeFile(join(dir, artifact.path), source);
      await expect(verifySelfContained({
        name: `optimizer-env-${name}-pack`,
        dir,
        manifest: {
          artifacts: [artifact],
          metadata
        }
      })).rejects.toThrow(/unsafe loader rejected|process access rejected/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("optimizer-resistant scans preserve Unicode escapes in literals and comments", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-optimizer-literal-escape-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), [
      "const diagnostic = \"\\u0022; process.exit(); //\";",
      "// \\u000a process.exit();",
      "export default diagnostic;",
      ""
    ].join("\n"));
    await verifySelfContained({
      name: "optimizer-literal-escape-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs", role: "adapter" }],
        metadata: { allowedBuiltins: [] }
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("template expression comments cannot hide optimizer-erased sidecar loaders", async () => {
  for (const [name, comment] of [
    ["line-comment", "// }}\n"],
    ["block-comment", "/* }} */\n"]
  ]) {
    const root = await mkdtemp(join(tmpdir(), "world-sidecar-template-comment-pack-"));
    try {
      const dir = join(root, "pack");
      await mkdir(dir);
      await writeFile(join(dir, "sidecar.mjs"), [
        `const value = \`${"${"}(() => { ${comment}`,
        "/* @__PURE__ */ Function(\"return process\")().exit(7);",
        "return \"ok\";",
        "})()}`;",
        "process.stdout.write(value);"
      ].join("\n"));
      await expect(verifySelfContained({
        name: `sidecar-template-${name}-pack`,
        dir,
        manifest: {
          artifacts: [{ path: "sidecar.mjs", role: "sidecar" }],
          metadata: {
            allowedBuiltins: [],
            sidecar: { command: ["node", "sidecar.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
          }
        }
      })).rejects.toThrow(/unsafe loader rejected|process access rejected/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

test("non-Bun sidecar scans reject optimizer-erased calls", async () => {
  for (const [name, source, reason] of [
    ["process-exit", "/* @__PURE__ */ process.exit(7);\n", /process access rejected/],
    [
      "string-key-constructor",
      "/* @__PURE__ */ (() => { const { \"constructor\": F } = function() {}; F(\"return process\")().exit(7); })();\nprocess.stdout.write(\"ok\");\n",
      /computed member access rejected|unsafe loader rejected|process access rejected/
    ]
  ]) {
    const root = await mkdtemp(join(tmpdir(), "world-sidecar-optimizer-pack-"));
    try {
      const dir = join(root, "pack");
      await mkdir(dir);
      await writeFile(join(dir, "sidecar.mjs"), source);
      await expect(verifySelfContained({
        name: `sidecar-optimizer-${name}-pack`,
        dir,
        manifest: {
          artifacts: [{ path: "sidecar.mjs", role: "sidecar" }],
          metadata: {
            allowedBuiltins: [],
            sidecar: { command: ["node", "sidecar.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
          }
        }
      })).rejects.toThrow(reason);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("non-Bun TypeScript sidecar type-only syntax is ignored by raw scans", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-sidecar-type-only-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(
      join(dir, "sidecar.mts"),
      "import type { Stats as FsStats } from \"node:fs\";\nexport type { Stats } from \"node:fs\";\ntype Handler = Function;\ntype ReadStats = import(\"node:fs\").Stats | FsStats;\nprocess.stdout.write(\"ok\");\n"
    );
    await verifySelfContained({
      name: "sidecar-type-only-pack",
      dir,
      manifest: {
        artifacts: [{ path: "sidecar.mts", role: "sidecar" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["node", "sidecar.mts"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Node ESM TypeScript sidecars cover inline type specifier imports", async () => {
  for (const [name, source] of [
    ["inline-type-import", "import{ type Helper }from \"./types.ts\";\nprocess.stdout.write(\"ok\");\n"],
    ["inline-type-export", "export { type Helper } from \"./types.ts\";\nprocess.stdout.write(\"ok\");\n"]
  ]) {
    const root = await mkdtemp(join(tmpdir(), "world-sidecar-inline-type-runtime-pack-"));
    try {
      const dir = join(root, "pack");
      await mkdir(dir);
      await writeFile(join(dir, "package.json"), "{\"type\":\"module\"}\n");
      await writeFile(join(dir, "sidecar.ts"), source);
      await writeFile(join(dir, "types.ts"), "console.log(\"runtime type module\");\nexport type Helper = string;\n");
      await expect(verifySelfContained({
        name: `sidecar-inline-type-runtime-${name}-pack`,
        dir,
        manifest: {
          artifacts: [{ path: "package.json" }, { path: "sidecar.ts", role: "sidecar" }],
          metadata: {
            allowedBuiltins: [],
            sidecar: { command: ["node", "sidecar.ts"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
          }
        }
      })).rejects.toThrow(/local import \.\/types\.ts not checksum-covered/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Node ESM TypeScript sidecars ignore ambient declaration type imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-sidecar-ambient-type-import-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "package.json"), "{\"type\":\"module\"}\n");
    await writeFile(
      join(dir, "sidecar.ts"),
      "declare module \"ambient\" {\n  import { type Missing } from \"./missing.ts\";\n  export { type Other } from \"./also-missing.ts\";\n}\nprocess.stdout.write(\"ok\");\n"
    );
    await verifySelfContained({
      name: "sidecar-ambient-type-import-pack",
      dir,
      manifest: {
        artifacts: [{ path: "package.json" }, { path: "sidecar.ts", role: "sidecar" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["node", "sidecar.ts"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Node ESM TypeScript sidecar type import scan stays within one clause", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-sidecar-inline-type-clause-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "package.json"), "{\"type\":\"module\"}\n");
    await writeFile(join(dir, "helper.ts"), "export const value = \"ok\";\n");
    await writeFile(
      join(dir, "sidecar.ts"),
      "import { value } from \"./helper.ts\";\nconst text = 'type Missing } from \"./missing.ts\"';\nprocess.stdout.write(value + text.length);\n"
    );
    await verifySelfContained({
      name: "sidecar-inline-type-clause-pack",
      dir,
      manifest: {
        artifacts: [{ path: "package.json" }, { path: "sidecar.ts", role: "sidecar" }, { path: "helper.ts" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["node", "sidecar.ts"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-Bun TypeScript sidecar multiline type aliases are ignored by raw scans", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-sidecar-multiline-type-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(
      join(dir, "sidecar.mts"),
      "type Handler = {\n  run: () => Function;\n  stats: import(\"node:fs\").Stats;\n};\nprocess.stdout.write(\"ok\");\n"
    );
    await verifySelfContained({
      name: "sidecar-multiline-type-pack",
      dir,
      manifest: {
        artifacts: [{ path: "sidecar.mts", role: "sidecar" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["node", "sidecar.mts"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-Bun TypeScript sidecar erased annotations are ignored by raw scans", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-sidecar-erased-annotations-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(
      join(dir, "sidecar.mts"),
      "function inspect(cb: Function): import(\"node:fs\").Stats | undefined {\n  void cb;\n  return undefined;\n}\nconst cast = ({}) as import(\"node:fs\").Stats;\nconst ok = cast satisfies import(\"node:fs\").Stats;\nvoid ok;\nprocess.stdout.write(\"ok\");\n"
    );
    await verifySelfContained({
      name: "sidecar-erased-annotations-pack",
      dir,
      manifest: {
        artifacts: [{ path: "sidecar.mts", role: "sidecar" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["node", "sidecar.mts"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Node TypeScript sidecar syntax checks ignore inert and erased text", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-sidecar-node-ts-inert-syntax-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(
      join(dir, "sidecar.mts"),
      [
        "declare const enum E { A }",
        "declare namespace Host { type File = string }",
        "declare global { enum Ambient { A } }",
        "import type File = Host.File;",
        "const text = \"enum Foo\";",
        "const pattern = /namespace Bar|constructor(public x: number)|import Foo = Bar.Baz/;",
        "// module Hidden { export const x = 1 }",
        "void pattern;",
        "process.stdout.write(text);"
      ].join("\n")
    );
    await verifySelfContained({
      name: "sidecar-node-ts-inert-syntax-pack",
      dir,
      manifest: {
        artifacts: [{ path: "sidecar.mts", role: "sidecar" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["node", "sidecar.mts"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Node cts sidecars allow await inside async functions", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-sidecar-node-cts-async-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(
      join(dir, "sidecar.cts"),
      "async function main(): Promise<void> { await Promise.resolve(); }\nasync function generic<T extends Promise<string>>(value: T): Promise<T> { await Promise.resolve(); return value; }\nconst alsoOk = async (): Promise<void> => await Promise.resolve();\nconst genericArrow = async <T extends Promise<string>>(value: T): Promise<T> => await Promise.resolve(value);\nvoid main();\nvoid generic;\nvoid alsoOk;\nvoid genericArrow;\nprocess.stdout.write(\"ok\");\n"
    );
    await verifySelfContained({
      name: "sidecar-node-cts-async-pack",
      dir,
      manifest: {
        artifacts: [{ path: "sidecar.cts", role: "sidecar" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["node", "sidecar.cts"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Node cts sidecar CJS scans ignore erased type-only await and arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-sidecar-node-cts-erased-cjs-scan-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(
      join(dir, "sidecar.cts"),
      "type T<U extends { await(): void }> = U;\nconst fn: (arguments: string) => void = () => {};\nvoid fn;\nprocess.stdout.write(\"ok\");\n"
    );
    await verifySelfContained({
      name: "sidecar-node-cts-erased-cjs-scan-pack",
      dir,
      manifest: {
        artifacts: [{ path: "sidecar.cts", role: "sidecar" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["node", "sidecar.cts"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Node TypeScript sidecar module checks ignore type-only syntax", async () => {
  for (const [name, artifactPath, source] of [
    ["cts-export-interface", "sidecar.cts", "export interface Msg { value: string }\nprocess.stdout.write(\"ok\");\n"],
    ["cts-export-declare-interface", "sidecar.cts", "export declare interface Msg { value: string }\nprocess.stdout.write(\"ok\");\n"],
    ["cts-export-declare-type", "sidecar.cts", "export declare type Msg = { value: string };\nprocess.stdout.write(\"ok\");\n"],
    ["cts-interface-await", "sidecar.cts", "interface AwaitShape { await(): void }\nprocess.stdout.write(\"ok\");\n"],
    ["cts-interface-generic-constraint-await", "sidecar.cts", "interface AwaitShape<T extends {}> { await(): void }\nprocess.stdout.write(\"ok\");\n"],
    ["ts-interface-generic-constraint-await", "sidecar.ts", "interface AwaitShape<T extends {}> { await(): void }\nprocess.stdout.write(\"ok\");\n"],
    ["cts-type-alias-await-member", "sidecar.cts", "type AwaitShape = { value: string; await(): void };\nprocess.stdout.write(\"ok\");\n"],
    ["mts-type-module-exports", "sidecar.mts", "type ExportsShape = typeof module.exports;\nprocess.stdout.write(\"ok\");\n"],
    ["mts-abstract-class", "sidecar.mts", "abstract class Base { abstract run(): void }\nprocess.stdout.write(\"ok\");\n"],
    ["cts-abstract-class", "sidecar.cts", "abstract class Base { abstract run(): void }\nprocess.stdout.write(\"ok\");\n"],
    ["mts-readonly-constructor-type", "sidecar.mts", "class Box { constructor(xs: readonly string[]) { void xs; } }\nnew Box([]);\nprocess.stdout.write(\"ok\");\n"],
    ["mts-generic-arrow", "sidecar.mts", "type Box<T> = { value: T };\nconst read = <T extends Box<string>>(x: T) => x.value;\nprocess.stdout.write(read({ value: \"ok\" }));\n"],
    ["cts-generic-arrow", "sidecar.cts", "type Box<T> = { value: T };\nconst read = <T extends Box<string>>(x: T) => x.value;\nprocess.stdout.write(read({ value: \"ok\" }));\n"],
    ["cts-async-nested-generic", "sidecar.cts", "async function f<T extends (x: string) => Promise<string>>(fn: T) { await fn(\"x\"); }\nvoid f;\nprocess.stdout.write(\"ok\");\n"],
    ["mts-method-return", "sidecar.mts", "const obj = { m() { return \"ok\"; } };\nprocess.stdout.write(obj.m());\n"],
    ["mts-return-property-names", "sidecar.mts", "const obj = { return: 1, nested: { return() { return \"ok\"; } } };\nprocess.stdout.write(obj.nested.return());\n"],
    ["mts-data-properties", "sidecar.mts", "const state = { export: 0, module: { value: 1 }, exports: 2 };\nstate.export = 1;\nstate.module.value += 1;\nstate.exports = 3;\nprocess.stdout.write(\"ok\");\n"]
  ]) {
    const root = await mkdtemp(join(tmpdir(), "world-sidecar-node-ts-type-module-pack-"));
    try {
      const dir = join(root, "pack");
      await mkdir(dir);
      await writeFile(join(dir, artifactPath), source);
      await verifySelfContained({
        name: `sidecar-node-ts-type-module-${name}-pack`,
        dir,
        manifest: {
          artifacts: [{ path: artifactPath, role: "sidecar" }],
          metadata: {
            allowedBuiltins: [],
            sidecar: { command: ["node", artifactPath], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
          }
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Node sidecar runtime checks ignore spoofed adapter roles", async () => {
  for (const [name, artifacts, files, command] of [
    [
      "entry-role-spoof",
      [{ path: "sidecar.mts", role: "adapter" }],
      [["sidecar.mts", "enum E { A }\nprocess.stdout.write(\"ok\");\n"]],
      ["node", "sidecar.mts"]
    ],
    [
      "helper-role-spoof",
      [{ path: "sidecar.mts", role: "sidecar" }, { path: "helper.ts", role: "adapter" }],
      [
        ["sidecar.mts", "import \"./helper.ts\";\nprocess.stdout.write(\"ok\");\n"],
        ["helper.ts", "enum E { A }\n"]
      ],
      ["node", "sidecar.mts"]
    ]
  ]) {
    const root = await mkdtemp(join(tmpdir(), "world-sidecar-role-spoof-pack-"));
    try {
      const dir = join(root, "pack");
      await mkdir(dir);
      for (const [path, source] of files) await writeFile(join(dir, path), source);
      await expect(verifySelfContained({
        name: `sidecar-role-spoof-${name}-pack`,
        dir,
        manifest: {
          artifacts,
          metadata: {
            allowedBuiltins: [],
            sidecar: { command, stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
          }
        }
      })).rejects.toThrow(/Node sidecar unsupported TypeScript syntax rejected/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Node TypeScript sidecars reject transform-only syntax", async () => {
  for (const [name, source] of [
    ["parameter-property", "class Box { constructor(public x: number) {} }\nprocess.stdout.write(\"ok\");\n"],
    ["unicode-parameter-property", "class Box { constructor(public \u03a9: number) {} }\nprocess.stdout.write(\"ok\");\n"],
    ["escaped-parameter-property", "class Box { constructor(publ\\u0069c x: number) {} }\nprocess.stdout.write(\"ok\");\n"],
    ["enum", "enum E { A }\nprocess.stdout.write(\"ok\");\n"],
    ["unicode-enum", "enum \u03a9 { A }\nprocess.stdout.write(\"ok\");\n"],
    ["escaped-enum", "enum \\u0045 { A }\nprocess.stdout.write(\"ok\");\n"],
    ["namespace", "namespace N { export const x = 1 }\nprocess.stdout.write(\"ok\");\n"],
    ["unicode-namespace", "namespace \u03a9 { export const x = 1 }\nprocess.stdout.write(\"ok\");\n"],
    ["angle-type-assertion", "const x = <number>1;\nprocess.stdout.write(String(x));\n"],
    ["operator-angle-type-assertion", "const value = 1;\nconst x = <number> +value;\nprocess.stdout.write(String(x));\n"],
    ["return-angle-type-assertion", "function value() { return <number>1; }\nprocess.stdout.write(String(value()));\n"],
    ["throw-angle-type-assertion", "function fail(err: unknown) { throw <Error>err; }\nvoid fail;\nprocess.stdout.write(\"ok\");\n"],
    ["semicolonless-type-alias-enum", "type A = string\nenum E { A }\nprocess.stdout.write(\"ok\");\n"],
    ["import-equals", "import Foo = require(\"node:fs\");\nprocess.stdout.write(\"ok\");\n"],
    ["unicode-import-equals", "import \u03a9 = require(\"node:fs\");\nprocess.stdout.write(\"ok\");\n"],
    ["export-assignment", "export = {};\nprocess.stdout.write(\"ok\");\n"],
    ["declare-export-assignment", "declare export = {};\nprocess.stdout.write(\"ok\");\n"],
    ["decorator", "function deco(value: unknown) { return value; }\n@deco\nclass Box {}\nprocess.stdout.write(\"ok\");\n"],
    ["parenthesized-decorator", "function deco(value: unknown) { return value; }\n@(deco)\nclass Box {}\nprocess.stdout.write(\"ok\");\n"],
    ["constructor-parameter-decorator", "function deco(value: unknown) { return value; }\nclass Box { constructor(@deco x: number) {} }\nprocess.stdout.write(\"ok\");\n"],
    ["override-parameter-property", "class Base { x = 0; }\nclass Box extends Base { constructor(override x: number) { super(); } }\nprocess.stdout.write(\"ok\");\n"]
  ]) {
    const root = await mkdtemp(join(tmpdir(), "world-sidecar-node-ts-transform-pack-"));
    try {
      const dir = join(root, "pack");
      await mkdir(dir);
      await writeFile(join(dir, "sidecar.mts"), source);
      await expect(verifySelfContained({
        name: `sidecar-node-ts-transform-${name}-pack`,
        dir,
        manifest: {
          artifacts: [{ path: "sidecar.mts", role: "sidecar" }],
          metadata: {
            allowedBuiltins: [],
            sidecar: { command: ["node", "sidecar.mts"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
          }
        }
      })).rejects.toThrow(/Node sidecar unsupported TypeScript syntax rejected/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Node TypeScript sidecars respect package module kind", async () => {
  for (const [name, packageJson, source] of [
    ["commonjs-export", "{\"type\":\"commonjs\"}\n", "export const value = 1;\nprocess.stdout.write(\"ok\");\n"],
    ["module-commonjs", "{\"type\":\"module\"}\n", "module.exports = {};\nprocess.stdout.write(\"ok\");\n"],
    ["syntax-esm-commonjs", null, "import \"./helper.cjs\";\nmodule.exports = {};\nprocess.stdout.write(\"ok\");\n"]
  ]) {
    const root = await mkdtemp(join(tmpdir(), "world-sidecar-node-ts-module-kind-pack-"));
    try {
      const dir = join(root, "pack");
      await mkdir(dir);
      if (packageJson) await writeFile(join(dir, "package.json"), packageJson);
      await writeFile(join(dir, "sidecar.ts"), source);
      await writeFile(join(dir, "helper.cjs"), "module.exports = true;\n");
      const artifacts = [{ path: "sidecar.ts", role: "sidecar" }, { path: "helper.cjs", role: "helper" }];
      if (packageJson) artifacts.push({ path: "package.json", role: "helper" });
      await expect(verifySelfContained({
        name: `sidecar-node-ts-module-kind-${name}-pack`,
        dir,
        manifest: {
          artifacts,
          metadata: {
            allowedBuiltins: [],
            sidecar: { command: ["node", "sidecar.ts"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
          }
        }
      })).rejects.toThrow(/Node sidecar unsupported module syntax rejected/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Node JavaScript sidecars respect package module kind", async () => {
  for (const [name, packageJson, source, helperPath, helperSource] of [
    ["commonjs-import", "{\"type\":\"commonjs\"}\n", "import \"./helper.cjs\";\nprocess.stdout.write(\"ok\");\n", "helper.cjs", "module.exports = true;\n"],
    ["commonjs-export", "{\"type\":\"commonjs\"}\n", "export const value = 1;\nprocess.stdout.write(\"ok\");\n", "helper.cjs", "module.exports = true;\n"],
    ["module-require", "{\"type\":\"module\"}\n", "require(\"./helper.cjs\");\nprocess.stdout.write(\"ok\");\n", "helper.cjs", "module.exports = true;\n"],
    ["module-commonjs", "{\"type\":\"module\"}\n", "module.exports = {};\nprocess.stdout.write(\"ok\");\n", "helper.cjs", "module.exports = true;\n"],
    ["module-exports-member", "{\"type\":\"module\"}\n", "exports.foo = 1;\nprocess.stdout.write(\"ok\");\n", "helper.cjs", "module.exports = true;\n"]
  ]) {
    const root = await mkdtemp(join(tmpdir(), "world-sidecar-node-js-module-kind-pack-"));
    try {
      const dir = join(root, "pack");
      await mkdir(dir);
      await writeFile(join(dir, "package.json"), packageJson);
      await writeFile(join(dir, "sidecar.js"), source);
      await writeFile(join(dir, helperPath), helperSource);
      await expect(verifySelfContained({
        name: `sidecar-node-js-module-kind-${name}-pack`,
        dir,
        manifest: {
          artifacts: [
            { path: "sidecar.js", role: "sidecar" },
            { path: helperPath, role: "helper" },
            { path: "package.json", role: "helper" }
          ],
          metadata: {
            allowedBuiltins: [],
            sidecar: { command: ["node", "sidecar.js"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
          }
        }
      })).rejects.toThrow(/Node sidecar unsupported module syntax rejected/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Node JavaScript sidecars infer ESM from side-effect imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-sidecar-node-js-side-effect-import-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "sidecar.js"), "import \"./helper.cjs\";\nprocess.stdout.write(\"ok\");\n");
    await writeFile(join(dir, "helper.cjs"), "module.exports = true;\n");
    await verifySelfContained({
      name: "sidecar-node-js-side-effect-import-pack",
      dir,
      manifest: {
        artifacts: [
          { path: "sidecar.js", role: "sidecar" },
          { path: "helper.cjs", role: "helper" }
        ],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["node", "sidecar.js"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Node ESM sidecar syntax scans allow top-level await regex literals", async () => {
  for (const [name, artifactPath, source] of [
    ["mjs-module-require", "sidecar.mjs", "const ok = await /module.require/.test(\"safe\");\nprocess.stdout.write(String(ok));\n"],
    ["mts-typescript-keyword", "sidecar.mts", "const ok = await /enum Foo/.test(\"safe\");\nprocess.stdout.write(String(ok));\n"]
  ]) {
    const root = await mkdtemp(join(tmpdir(), "world-sidecar-node-esm-await-regex-pack-"));
    try {
      const dir = join(root, "pack");
      await mkdir(dir);
      await writeFile(join(dir, artifactPath), source);
      await verifySelfContained({
        name: `sidecar-node-esm-await-regex-${name}-pack`,
        dir,
        manifest: {
          artifacts: [{ path: artifactPath, role: "sidecar" }],
          metadata: {
            allowedBuiltins: [],
            sidecar: { command: ["node", artifactPath], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
          }
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Node CommonJS JavaScript sidecars reject top-level await", async () => {
  for (const [name, artifactPath, packageJson] of [
    ["cjs", "sidecar.cjs", null],
    ["commonjs-js", "sidecar.js", "{\"type\":\"commonjs\"}\n"]
  ]) {
    const root = await mkdtemp(join(tmpdir(), "world-sidecar-node-js-await-pack-"));
    try {
      const dir = join(root, "pack");
      await mkdir(dir);
      if (packageJson) await writeFile(join(dir, "package.json"), packageJson);
      await writeFile(join(dir, artifactPath), "await Promise.resolve();\nprocess.stdout.write(\"ok\");\n");
      const artifacts = [{ path: artifactPath, role: "sidecar" }];
      if (packageJson) artifacts.push({ path: "package.json", role: "helper" });
      await expect(verifySelfContained({
        name: `sidecar-node-js-await-${name}-pack`,
        dir,
        manifest: {
          artifacts,
          metadata: {
            allowedBuiltins: [],
            sidecar: { command: ["node", artifactPath], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
          }
        }
      })).rejects.toThrow(/Node sidecar unsupported module syntax rejected/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Node CommonJS sidecars reject lexical wrapper redeclarations", async () => {
  for (const [name, artifactPath, packageJson, source] of [
    ["cjs-exports", "sidecar.cjs", null, "const exports = {};\nprocess.stdout.write(\"ok\");\n"],
    ["cjs-require", "sidecar.cjs", null, "let require = () => {};\nprocess.stdout.write(\"ok\");\n"],
    ["commonjs-js-module", "sidecar.js", "{\"type\":\"commonjs\"}\n", "class module {}\nprocess.stdout.write(\"ok\");\n"],
    ["cts-dirname", "sidecar.cts", null, "const __dirname: string = \"\";\nprocess.stdout.write(\"ok\");\n"]
  ]) {
    const root = await mkdtemp(join(tmpdir(), "world-sidecar-node-cjs-wrapper-pack-"));
    try {
      const dir = join(root, "pack");
      await mkdir(dir);
      if (packageJson) await writeFile(join(dir, "package.json"), packageJson);
      await writeFile(join(dir, artifactPath), source);
      const artifacts = [{ path: artifactPath, role: "sidecar" }];
      if (packageJson) artifacts.push({ path: "package.json", role: "helper" });
      await expect(verifySelfContained({
        name: `sidecar-node-cjs-wrapper-${name}-pack`,
        dir,
        manifest: {
          artifacts,
          metadata: {
            allowedBuiltins: [],
            sidecar: { command: ["node", artifactPath], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
          }
        }
      })).rejects.toThrow(/Node sidecar unsupported module syntax rejected/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Node TypeScript sidecars reject incompatible module syntax", async () => {
  for (const [name, artifactPath, source, helperPath, helperSource] of [
    ["cts-esm-import", "sidecar.cts", "import \"./helper.cjs\";\nprocess.stdout.write(\"ok\");\n", "helper.cjs", "module.exports = true;\n"],
    ["cts-inline-type-import", "sidecar.cts", "import { type Helper } from \"./helper.cts\";\nprocess.stdout.write(\"ok\");\n", "helper.cts", "export interface Helper { value: string }\n"],
    ["cts-compact-inline-type-import", "sidecar.cts", "import{ type Helper }from \"./helper.cts\";\nprocess.stdout.write(\"ok\");\n", "helper.cts", "export interface Helper { value: string }\n"],
    ["ts-inline-type-import", "sidecar.ts", "import { type Helper } from \"./helper.cts\";\nprocess.stdout.write(\"ok\");\n", "helper.cts", "export interface Helper { value: string }\n"],
    ["cts-inline-type-export", "sidecar.cts", "interface Helper { value: string }\nexport { type Helper };\nprocess.stdout.write(\"ok\");\n", "helper.cjs", "module.exports = true;\n"],
    ["ts-compact-inline-type-export", "sidecar.ts", "export{ type Helper }from \"./helper.cts\";\nprocess.stdout.write(\"ok\");\n", "helper.cts", "export interface Helper { value: string }\n"],
    ["ts-inline-type-export", "sidecar.ts", "interface Helper { value: string }\nexport { type Helper };\nprocess.stdout.write(\"ok\");\n", "helper.cjs", "module.exports = true;\n"],
    ["cts-top-level-await", "sidecar.cts", "await Promise.resolve();\nprocess.stdout.write(\"ok\");\n", "helper.cjs", "module.exports = true;\n"],
    ["cts-dead-top-level-await", "sidecar.cts", "if (false) await Promise.resolve();\nprocess.stdout.write(\"ok\");\n", "helper.cjs", "module.exports = true;\n"],
    ["mts-top-level-return", "sidecar.mts", "return;\nprocess.stdout.write(\"ok\");\n", "helper.cjs", "module.exports = true;\n"],
    ["mts-commonjs-require", "sidecar.mts", "require(\"./helper.cjs\");\nprocess.stdout.write(\"ok\");\n", "helper.cjs", "module.exports = true;\n"],
    ["mts-commonjs-export", "sidecar.mts", "module.exports = {};\nprocess.stdout.write(\"ok\");\n", "helper.cjs", "module.exports = true;\n"],
    ["mts-commonjs-optional-module", "sidecar.mts", "void module?.exports;\nprocess.stdout.write(\"ok\");\n", "helper.cjs", "module.exports = true;\n"],
    ["mts-commonjs-bare-exports", "sidecar.mts", "exports = {};\nprocess.stdout.write(\"ok\");\n", "helper.cjs", "module.exports = true;\n"],
    ["mts-commonjs-exports-member", "sidecar.mts", "exports.foo = 1;\nexports[\"bar\"] = 2;\nprocess.stdout.write(\"ok\");\n", "helper.cjs", "module.exports = true;\n"],
    ["mts-commonjs-exports-value", "sidecar.mts", "Object.defineProperty(exports, \"__esModule\", { value: true });\nprocess.stdout.write(\"ok\");\n", "helper.cjs", "module.exports = true;\n"]
  ]) {
    const root = await mkdtemp(join(tmpdir(), "world-sidecar-node-ts-module-pack-"));
    try {
      const dir = join(root, "pack");
      await mkdir(dir);
      await writeFile(join(dir, artifactPath), source);
      await writeFile(join(dir, helperPath), helperSource);
      await expect(verifySelfContained({
        name: `sidecar-node-ts-module-${name}-pack`,
        dir,
        manifest: {
          artifacts: [{ path: artifactPath, role: "sidecar" }, { path: helperPath, role: "helper" }],
          metadata: {
            allowedBuiltins: [],
            sidecar: { command: ["node", artifactPath], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
          }
        }
      })).rejects.toThrow(/Node sidecar unsupported module syntax rejected/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("non-Bun TypeScript sidecar scans still reject optimizer-erased runtime calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-sidecar-ts-optimizer-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "sidecar.mts"), "type Handler = Function;\n/* @__PURE__ */ process.exit(7);\n");
    await expect(verifySelfContained({
      name: "sidecar-ts-optimizer-pack",
      dir,
      manifest: {
        artifacts: [{ path: "sidecar.mts", role: "sidecar" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["node", "sidecar.mts"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    })).rejects.toThrow(/process access rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-Bun sidecar raw scans normalize escaped runtime identifiers", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-sidecar-escaped-runtime-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "sidecar.mjs"), "/* @__PURE__ */ pro\\u0063ess.exit(7);\n");
    await expect(verifySelfContained({
      name: "sidecar-escaped-runtime-pack",
      dir,
      manifest: {
        artifacts: [{ path: "sidecar.mjs", role: "sidecar" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["node", "sidecar.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    })).rejects.toThrow(/process access rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-Bun sidecar helper scans reject optimizer-erased calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-sidecar-helper-optimizer-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "sidecar.mjs"), "import \"./helper.mjs\";\n");
    await writeFile(join(dir, "helper.mjs"), "/* @__PURE__ */ process.getBuiltinModule(\"node:fs\");\n");
    await expect(verifySelfContained({
      name: "sidecar-helper-optimizer-pack",
      dir,
      manifest: {
        artifacts: [
          { path: "sidecar.mjs", role: "sidecar" },
          { path: "helper.mjs", role: "helper" }
        ],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["node", "sidecar.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    })).rejects.toThrow(/unsafe loader rejected|process access rejected/);
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

test("Bun and Deno TypeScript sidecars allow top-level await regex literals", async () => {
  for (const [name, runtime, command, source] of [
    ["bun", "bun", ["bun", "sidecar.ts"], "const ok = await /process/.test(\"safe\");\nprocess.stdout.write(String(ok));\n"],
    ["deno", "deno", ["deno", "run", "sidecar.ts"], "const ok = await /Deno/.test(\"safe\");\nawait Deno.stdout.write(new Uint8Array());\n"]
  ]) {
    const root = await mkdtemp(join(tmpdir(), `world-sidecar-${name}-ts-await-regex-pack-`));
    try {
      const dir = join(root, "pack");
      await mkdir(dir);
      await writeFile(join(dir, "sidecar.ts"), source);
      await verifySelfContained({
        name: `${runtime}-sidecar-ts-await-regex-pack`,
        dir,
        manifest: {
          artifacts: [{ path: "sidecar.ts", role: "sidecar" }],
          metadata: {
            allowedBuiltins: [],
            sidecar: { command, stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
          }
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

test("sidecar IO allowance cannot apply to the adapter artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-sidecar-adapter-entrypoint-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "process.stdout.write(\"not a sidecar\");\nexport const manifest = () => ({});\n");
    await expect(verifySelfContained({
      name: "sidecar-adapter-entrypoint-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs", role: "sidecar" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["bun", "adapter.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    })).rejects.toThrow(/process access rejected|sidecar entrypoint missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sidecar IO allowance rejects adapter path aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-sidecar-adapter-alias-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "process.stdout.write(\"not a sidecar\");\nexport const manifest = () => ({});\n");
    await expect(verifySelfContained({
      name: "sidecar-adapter-dot-entrypoint-pack",
      dir,
      manifest: {
        artifacts: [{ path: "./adapter.mjs", role: "sidecar" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["bun", "./adapter.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    })).rejects.toThrow(/process access rejected/);

    await symlink(join(dir, "adapter.mjs"), join(dir, "adapter-link.mjs"));
    await expect(verifySelfContained({
      name: "sidecar-adapter-symlink-entrypoint-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter-link.mjs", role: "sidecar" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["bun", "adapter-link.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    })).rejects.toThrow(/symlinked executable artifact rejected|process access rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adapter imports cannot execute sidecar entrypoints in-process", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-sidecar-import-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "import \"./sidecar.mjs\";\nexport const manifest = () => ({});\n");
    await writeFile(join(dir, "sidecar.mjs"), "process.stdout.write(\"sidecar only\");\n");
    await expect(verifySelfContained({
      name: "sidecar-import-pack",
      dir,
      manifest: {
        artifacts: [{ path: "adapter.mjs", role: "adapter" }, { path: "sidecar.mjs", role: "sidecar" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["bun", "sidecar.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    })).rejects.toThrow(/sidecar entrypoint import rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adapter imports cannot hide sidecar entrypoints behind URL suffixes", async () => {
  for (const [name, suffix] of [["query", "?x"], ["fragment", "#x"]]) {
    const root = await mkdtemp(join(tmpdir(), "world-sidecar-suffixed-import-pack-"));
    try {
      const dir = join(root, "pack");
      await mkdir(dir);
      await writeFile(join(dir, "adapter.mjs"), `import "./sidecar.mjs${suffix}";\nexport const manifest = () => ({});\n`);
      await writeFile(join(dir, "sidecar.mjs"), "process.stdout.write(\"sidecar only\");\n");
      await writeFile(join(dir, `sidecar.mjs${suffix}.mjs`), "export default true;\n");
      await expect(verifySelfContained({
        name: `sidecar-${name}-suffixed-import-pack`,
        dir,
        manifest: {
          artifacts: [
            { path: "adapter.mjs", role: "adapter" },
            { path: "sidecar.mjs", role: "sidecar" },
            { path: `sidecar.mjs${suffix}.mjs`, role: "helper" }
          ],
          metadata: {
            allowedBuiltins: [],
            sidecar: { command: ["bun", "sidecar.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
          }
        }
      })).rejects.toThrow(/URL-suffixed local import/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("local imports cannot hide runtime targets behind percent-encoded aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-percent-import-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "sidecar.mjs"), "import \"./helper%2e.mjs\";\nprocess.stdout.write(\"ok\");\n");
    await writeFile(join(dir, "helper%2e.mjs"), "export default true;\n");
    await writeFile(join(dir, "helper..mjs"), "process.exit(7);\n");
    await expect(verifySelfContained({
      name: "percent-import-pack",
      dir,
      manifest: {
        artifacts: [
          { path: "sidecar.mjs", role: "sidecar" },
          { path: "helper%2e.mjs", role: "helper" }
        ],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["node", "sidecar.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    })).rejects.toThrow(/percent-encoded local import/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local imports cannot hide runtime targets behind backslash aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-backslash-import-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(join(dir, "subdir"), { recursive: true });
    await writeFile(join(dir, "sidecar.mjs"), "import \"./subdir\\\\helper.mjs\";\nprocess.stdout.write(\"ok\");\n");
    await writeFile(join(dir, "subdir\\helper.mjs"), "export default true;\n");
    await writeFile(join(dir, "subdir", "helper.mjs"), "process.exit(7);\n");
    await expect(verifySelfContained({
      name: "backslash-import-pack",
      dir,
      manifest: {
        artifacts: [{ path: "sidecar.mjs", role: "sidecar" }, { path: "subdir\\helper.mjs", role: "helper" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["bun", "sidecar.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    })).rejects.toThrow(/backslash local import/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adapter imports cannot execute hard-linked sidecar entrypoints in-process", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-sidecar-hardlink-import-pack-"));
  try {
    const dir = join(root, "pack");
    await mkdir(dir);
    await writeFile(join(dir, "adapter.mjs"), "import \"./sidecar-link.mjs\";\nexport const manifest = () => ({});\n");
    await writeFile(join(dir, "sidecar.mjs"), "process.stdout.write(\"sidecar only\");\n");
    await link(join(dir, "sidecar.mjs"), join(dir, "sidecar-link.mjs"));
    await expect(verifySelfContained({
      name: "sidecar-hardlink-import-pack",
      dir,
      manifest: {
        artifacts: [
          { path: "adapter.mjs", role: "adapter" },
          { path: "sidecar.mjs", role: "sidecar" },
          { path: "sidecar-link.mjs", role: "helper" }
        ],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["bun", "sidecar.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    })).rejects.toThrow(/sidecar entrypoint import rejected/);
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

test("sidecar command allows script option arguments after entrypoint", async () => {
  for (const [name, artifactPath, source, command] of [
    ["node", "sidecar.mjs", "process.stdout.write(\"ok\");\n", ["node", "sidecar.mjs", "--mode=test"]],
    ["bun", "sidecar.mjs", "process.stdout.write(\"ok\");\n", ["bun", "sidecar.mjs", "--mode=test"]],
    ["deno", "sidecar.mts", "console.log(\"ok\");\n", ["deno", "run", "sidecar.mts", "--mode=test"]]
  ]) {
    const root = await mkdtemp(join(tmpdir(), "world-sidecar-script-argv-pack-"));
    try {
      const dir = join(root, "pack");
      await mkdir(dir);
      await writeFile(join(dir, artifactPath), source);
      await verifySelfContained({
        name: `sidecar-script-argv-${name}-pack`,
        dir,
        manifest: {
          artifacts: [{ path: artifactPath, role: "sidecar" }],
          metadata: {
            allowedBuiltins: [],
            sidecar: { command, stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
          }
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

test("sidecar command rejects option-like arguments before entrypoint selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-sidecar-option-pack-"));
  try {
    for (const [name, command, optionArtifact] of [
      ["node-conditions", ["node", "--conditions=sidecar.jsx", "../evil.mjs"], "--conditions=sidecar.jsx"],
      ["deno-allow-read", ["deno", "run", "--allow-read=sidecar.mts", "unchecked.mjs"], "--allow-read=sidecar.mts"]
    ]) {
      const dir = join(root, name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, optionArtifact), "export default true;\n");
      await expect(verifySelfContained({
        name: `${name}-pack`,
        dir,
        manifest: {
          artifacts: [{ path: optionArtifact, role: "sidecar" }],
          metadata: {
            allowedBuiltins: [],
            sidecar: { command, stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
          }
        }
      })).rejects.toThrow(/sidecar option argument rejected/);
    }
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

test("symlinked executable artifacts are rejected before import coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-pack-executable-symlink-"));
  try {
    const packDir = join(root, "pack");
    const subDir = join(packDir, "sub");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "sidecar.mjs"), "import \"./helper.mjs\";\nprocess.stdout.write(\"ok\");\n");
    await writeFile(join(subDir, "helper.mjs"), "process.exit(7);\n");
    await writeFile(join(packDir, "helper.mjs"), "export const helper = true;\n");
    await symlink(join(subDir, "sidecar.mjs"), join(packDir, "sidecar.mjs"));
    await expect(verifySelfContained({
      name: "executable-symlink-pack",
      dir: packDir,
      manifest: {
        artifacts: [{ path: "sidecar.mjs", role: "sidecar" }, { path: "helper.mjs", role: "helper" }],
        metadata: {
          allowedBuiltins: [],
          sidecar: { command: ["node", "sidecar.mjs"], stdoutBytes: 1024, stderrBytes: 1024, timeoutMs: 1000 }
        }
      }
    })).rejects.toThrow(/symlinked executable artifact rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
