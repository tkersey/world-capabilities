export function fixtureResolution(input) {
  return {
    requestId: input?.requestId ?? "sidecar",
    status: "ok",
    payload: { sidecar: true, helperChecked: true }
  };
}
