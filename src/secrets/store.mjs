import { execFileSync } from "node:child_process";

const SERVICE_PREFIX = "FIR";
const KEYMASTER_SERVICE_NAME = "KeyMaster Local Lockbox";

function serviceName(secretName) {
  return `${SERVICE_PREFIX}::${secretName}`;
}

function runSecurity(args = []) {
  return execFileSync("security", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function getStoredSecret(secretName) {
  try {
    const value = runSecurity(["find-generic-password", "-a", process.env.USER || "codex", "-s", serviceName(secretName), "-w"]);
    return value || null;
  } catch {
    try {
      const value = runSecurity(["find-generic-password", "-s", KEYMASTER_SERVICE_NAME, "-a", secretName, "-w"]);
      return value || null;
    } catch {
      return null;
    }
  }
}

export function storeSecret(secretName, rawValue) {
  runSecurity([
    "add-generic-password",
    "-U",
    "-a",
    process.env.USER || "codex",
    "-s",
    serviceName(secretName),
    "-w",
    rawValue,
  ]);
  return {
    secret_name: secretName,
    storage: "keychain",
    status: "stored",
  };
}

export function deleteStoredSecret(secretName) {
  try {
    runSecurity(["delete-generic-password", "-a", process.env.USER || "codex", "-s", serviceName(secretName)]);
    return true;
  } catch {
    return false;
  }
}
