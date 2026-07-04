#!/usr/bin/env bun
import { checkAllPacks } from "../harness/check-pack.mjs";

const count = await checkAllPacks();
console.log(`verified ${count} capability packs`);
