#!/usr/bin/env bun
import { access } from "node:fs/promises";
import { join } from "node:path";

const checkout = process.env.WORLD_HOST_CHECKOUT;
if (!checkout) {
  console.log("WORLD_HOST_CHECKOUT not set; provisional compatibility check skipped");
  process.exit(0);
}

await access(checkout);
console.log(`world-host provisional checkout present: ${join(checkout)}`);
