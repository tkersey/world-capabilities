const packManifest = {
  driverId: "__DRIVER_ID__",
  packageName: "__PACKAGE_NAME__",
  authorityLabels: ["__AUTHORITY_LABEL__"],
  supportedActuationClasses: ["__ACTUATION_CLASS__"],
  supportedActuatorRefs: ["__ACTUATOR_REF__"],
  supportedDescriptorFingerprints: ["__DESCRIPTOR_FINGERPRINT__"],
  supportedResponseStatuses: ["ok", "rejected", "failed"],
  secretRequirements: []
};

export function manifest() {
  return structuredClone(packManifest);
}

export async function preflight(_context, hostRequest) {
  return {
    requestId: hostRequest?.requestId ?? "unknown",
    status: "rejected",
    payload: { reason: "template_not_configured" }
  };
}

export async function resolve(context, hostRequest) {
  return preflight(context, hostRequest);
}

export async function dryRun(context, hostRequest) {
  return preflight(context, hostRequest);
}

export async function recover() {
  return { status: "failed", payload: { reason: "recover_unsupported" } };
}

export async function shadow() {
  return { status: "failed", payload: { reason: "shadow_unsupported" } };
}
