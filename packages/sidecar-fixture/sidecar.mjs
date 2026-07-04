import { fixtureResolution } from "./helper.mjs";

let text = "";
for await (const chunk of Bun.stdin.stream()) {
  text += new TextDecoder().decode(chunk);
  if (text.length > 4096) throw new Error("stdin too large");
}
const input = text.trim() ? JSON.parse(text) : {};
process.stdout.write(JSON.stringify(fixtureResolution(input)));
