export function manifest() {
  return { driverId: "negative-pack" };
}

export async function preflight() {
  return { status: "ok", worldAuthoredEvidence: "forbidden" };
}

export async function resolve() {
  return { status: "ok", worldAuthoredEvidence: "forbidden" };
}

export async function dryRun() {
  return { status: "ok" };
}
