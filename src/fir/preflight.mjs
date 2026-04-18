import { fileExists, readText } from "../utils.mjs";
import { installSecretValue } from "../secrets/installers.mjs";
import { getStoredSecret } from "../secrets/store.mjs";

function summarizeChecks(checks = []) {
  const blocked = checks.filter((check) => check.status === "blocked");
  const ready = checks.every((check) => check.status === "ready");
  return {
    status: ready ? "ready" : "blocked",
    checks,
    blocked_count: blocked.length,
  };
}

function parseEnvFile(filePath) {
  const content = readText(filePath, "");
  const values = {};
  for (const line of content.split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    values[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
  return values;
}

function resolveEnvVars(requirement = {}) {
  const envFiles = Array.isArray(requirement.env_files) ? requirement.env_files : [];
  const merged = {};
  for (const envFile of envFiles) {
    Object.assign(merged, parseEnvFile(envFile));
  }
  return merged;
}

async function checkUrl(url) {
  if (!url) {
    return { status: "blocked", kind: "url", message: "No URL was configured for this check." };
  }
  try {
    const response = await fetch(url, { method: "GET", redirect: "manual" });
    return {
      status: response.ok || [301, 302, 303, 307, 308, 401, 403].includes(response.status) ? "ready" : "blocked",
      kind: "url",
      url,
      http_status: response.status,
      message: `Reachability check returned HTTP ${response.status}.`,
    };
  } catch (error) {
    return {
      status: "blocked",
      kind: "url",
      url,
      message: `Reachability check failed: ${error.message || String(error)}`,
    };
  }
}

async function checkHttpRequirement(requirement = {}) {
  const merged = resolveEnvVars(requirement);
  const baseUrl = merged[requirement.url_env] || process.env[requirement.url_env] || requirement.url || requirement.fallback_url || "";
  const normalizedBase = String(baseUrl || "").trim().replace(/\/+$/g, "");
  const path = String(requirement.path || "").trim();
  const url = normalizedBase ? `${normalizedBase}${path}` : "";
  if (!url) {
    return {
      status: "blocked",
      kind: "http",
      message: "No URL was configured for this HTTP preflight check.",
    };
  }

  const method = String(requirement.method || "GET").toUpperCase();
  const headers = {};
  const headerMap = requirement.header_map || {};
  for (const [envName, headerName] of Object.entries(headerMap)) {
    const value = merged[envName] || process.env[envName];
    if (value) headers[headerName] = value;
  }

  try {
    const response = await fetch(url, { method, headers, redirect: "manual" });
    const expected = Array.isArray(requirement.expected_status) ? requirement.expected_status.map((item) => Number(item)) : [];
    const ok = expected.length > 0 ? expected.includes(response.status) : response.ok;
    return {
      status: ok ? "ready" : "blocked",
      kind: "http",
      method,
      url,
      http_status: response.status,
      message: `HTTP preflight returned ${response.status} for ${url}.`,
    };
  } catch (error) {
    return {
      status: "blocked",
      kind: "http",
      method,
      url,
      message: `HTTP preflight failed for ${url}: ${error.message || String(error)}`,
    };
  }
}

function checkEnvRequirement(requirement = {}) {
  const merged = resolveEnvVars(requirement);
  const vars = Array.isArray(requirement.vars) ? requirement.vars : [];
  const missing = vars.filter((name) => !merged[name] && !process.env[name]);
  return {
    status: missing.length === 0 ? "ready" : "blocked",
    kind: "env",
    env_files: requirement.env_files || [],
    vars,
    missing,
    message:
      missing.length === 0
        ? "All required environment variables are present."
        : `Missing required environment variables: ${missing.join(", ")}`,
  };
}

function checkFilesRequirement(requirement = {}) {
  const paths = Array.isArray(requirement.paths) ? requirement.paths : [];
  const missing = paths.filter((filePath) => !fileExists(filePath));
  return {
    status: missing.length === 0 ? "ready" : "blocked",
    kind: "files",
    paths,
    missing,
    message:
      missing.length === 0
        ? "All required files are present."
        : `Missing required files: ${missing.join(", ")}`,
  };
}

async function inferPointerChecks(target = {}) {
  const config = target.pointer || {};
  const checks = [];
  if (config.latest_run) {
    checks.push(checkFilesRequirement({ paths: [config.latest_run] }));
  }
  for (const requirement of target.preflight?.pointer?.requirements || []) {
    if (requirement.type === "env") checks.push(checkEnvRequirement(requirement));
    if (requirement.type === "files") checks.push(checkFilesRequirement(requirement));
    if (requirement.type === "http") checks.push(await checkHttpRequirement(requirement));
  }
  return summarizeChecks(checks);
}

async function inferScreenChecks(target = {}) {
  const config = target.screenGenie || {};
  const checks = [];
  if (Array.isArray(config.latest_runs) && config.latest_runs.length > 0) {
    checks.push(checkFilesRequirement({ paths: config.latest_runs }));
  } else if (config.latest_run) {
    checks.push(checkFilesRequirement({ paths: [config.latest_run] }));
  }
  for (const requirement of target.preflight?.screenGenie?.requirements || []) {
    if (requirement.type === "env") checks.push(checkEnvRequirement(requirement));
    if (requirement.type === "files") checks.push(checkFilesRequirement(requirement));
    if (requirement.type === "http") checks.push(await checkHttpRequirement(requirement));
  }
  return summarizeChecks(checks);
}

async function inferVoltmeterChecks(target = {}) {
  const config = target.voltmeter || {};
  const checks = [];
  if (config.latest_run) {
    checks.push(checkFilesRequirement({ paths: [config.latest_run] }));
  }
  for (const requirement of target.preflight?.voltmeter?.requirements || []) {
    if (requirement.type === "env") checks.push(checkEnvRequirement(requirement));
    if (requirement.type === "files") checks.push(checkFilesRequirement(requirement));
    if (requirement.type === "http") checks.push(await checkHttpRequirement(requirement));
  }
  return summarizeChecks(checks);
}

function summarizeToolAccess(tools = {}) {
  const entries = Object.entries(tools);
  const blocked = entries.filter(([, value]) => value.status !== "ready");
  return {
    overall: blocked.length === 0 ? "ready" : "not_ready",
    tools,
    next_action: blocked.at(0)?.[1]?.checks?.find((check) => check.status === "blocked")?.message || "run_fir",
  };
}

function hydrateTargetSecrets(target = {}) {
  const secrets = Array.isArray(target.requiredSecrets) ? target.requiredSecrets : [];
  const secretResults = [];
  for (const secretSpec of secrets) {
    const secretName = secretSpec.name;
    const storedValue = getStoredSecret(secretName);
    if (!storedValue) {
      secretResults.push({
        name: secretName,
        status: "missing",
        tool: secretSpec.tool || null,
        source_url: secretSpec.source_url || null,
        instructions: secretSpec.instructions || null,
        message: `Missing locally stored secret: ${secretName}`,
      });
      continue;
    }
    const installs = Array.isArray(secretSpec.installs) ? secretSpec.installs : [];
    const installResults = installs.map((install) => installSecretValue(install, storedValue));
    secretResults.push({
      name: secretName,
      status: "ready",
      tool: secretSpec.tool || null,
      source_url: secretSpec.source_url || null,
      instructions: secretSpec.instructions || null,
      installs: installResults,
      message: `Loaded ${secretName} from local secure storage.`,
    });
  }
  return {
    status: secretResults.every((result) => result.status === "ready") ? "ready" : "blocked",
    checks: secretResults,
    blocked_count: secretResults.filter((result) => result.status !== "ready").length,
  };
}

export async function runPreflight({ target }) {
  const secrets = hydrateTargetSecrets(target);
  const entryCheck = await checkUrl(target.entry || "");
  const pointer = await inferPointerChecks(target);
  const screenGenie = await inferScreenChecks(target);
  const voltmeter = await inferVoltmeterChecks(target);

  const tools = {
    pointer,
    screenGenie,
    voltmeter,
  };
  const summary = summarizeToolAccess(tools);
  const targetCheck = {
    status: entryCheck.status,
    checks: [entryCheck],
  };
  const allGreen =
    secrets.status === "ready" &&
    entryCheck.status === "ready" &&
    Object.values(tools).every((tool) => tool.status === "ready");

  return {
    target_id: target.id,
    entry: target.entry || null,
    checked_at: new Date().toISOString(),
    secrets,
    target_check: targetCheck,
    tools,
    overall: allGreen ? "ready" : "not_ready",
    next_action:
      allGreen
        ? "run_fir"
        : secrets.status !== "ready"
          ? secrets.checks.find((check) => check.status !== "ready")?.message || "Provide the missing local FIR secret."
        : entryCheck.status !== "ready"
          ? entryCheck.message
          : summary.next_action,
  };
}
