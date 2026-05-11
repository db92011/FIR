import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { runAppTester } from "./appTester.mjs";
import { readJson } from "./utils.mjs";

function maybeRun(command = "") {
  if (!command) return { ran: false, status: "skipped" };
  try {
    execSync(command, { stdio: "pipe", encoding: "utf8", shell: "/bin/zsh" });
    return { ran: true, status: "ok" };
  } catch (error) {
    return {
      ran: true,
      status: "nonzero",
      code: error.status ?? 1,
      stdout: String(error.stdout || ""),
      stderr: String(error.stderr || ""),
    };
  }
}

function latestRunPathFromPointer(latestPointerPath) {
  const latest = readJson(latestPointerPath, null);
  return latest?.report_path || null;
}

function latestRunPathFromVoltmeter(latestVoltmeterPath, fallbackRunsDir) {
  const latest = readJson(latestVoltmeterPath, null);
  if (latest?.latest?.run_path) return latest.latest.run_path;
  if (latest?.latest?.report_path) return latest.latest.report_path;
  if (latest?.latest?.artifact_path) return latest.latest.artifact_path;
  if (latest?.run_path) return latest.run_path;
  if (latest?.report_path) return latest.report_path;
  if (latest?.artifact_path) return latest.artifact_path;
  if (fallbackRunsDir && fs.existsSync(fallbackRunsDir)) {
    const entries = fs.readdirSync(fallbackRunsDir).sort();
    const last = entries.at(-1);
    return last ? path.join(fallbackRunsDir, last) : null;
  }
  return null;
}

function latestCaptureManifest(captureRoot, prefix = "") {
  if (!captureRoot || !fs.existsSync(captureRoot)) return null;
  const entries = fs
    .readdirSync(captureRoot)
    .filter((entry) => {
      const full = path.join(captureRoot, entry);
      return fs.statSync(full).isDirectory() && (!prefix || entry.startsWith(prefix));
    })
    .sort();
  const last = entries.at(-1);
  if (!last) return null;
  const manifestPath = path.join(captureRoot, last, "capture.json");
  return fs.existsSync(manifestPath) ? manifestPath : null;
}

function loadCaptureBundle(captureRoot, prefix) {
  const manifestPath = latestCaptureManifest(captureRoot, prefix);
  if (!manifestPath) return null;
  return readJson(manifestPath, null);
}

export function loadPointerResult(config = {}) {
  if (config.enabled === false) return { disabled: true, findings: [] };
  if (config.command && config.mode !== "read_latest") maybeRun(config.command);
  const reportPath = latestRunPathFromPointer(config.latest_run);
  return reportPath ? readJson(reportPath, null) : null;
}

export function loadScreenGenieResult(config = {}) {
  if (config.enabled === false) {
    return {
      disabled: true,
      manifest: { status: "passed", flow: "disabled_by_target_contract" },
      scenes: [],
    };
  }
  if (Array.isArray(config.commands) && config.mode !== "read_latest") {
    for (const command of config.commands) maybeRun(command);
  } else if (config.command && config.mode !== "read_latest") {
    maybeRun(config.command);
  }
  if (config.mode === "capture_latest") {
    const captures = Array.isArray(config.capture_prefixes)
      ? config.capture_prefixes.map((prefix) => loadCaptureBundle(config.capture_root, prefix)).filter(Boolean)
      : [loadCaptureBundle(config.capture_root, config.capture_prefix || "")].filter(Boolean);
    const manifest = captures[0];
    if (!manifest) return null;
    return {
      capture: true,
      captures,
      manifest,
      scenes: [],
    };
  }
  if (config.mode === "flows_latest") {
    const latestPointers = Array.isArray(config.latest_runs)
      ? config.latest_runs.map((pointerPath) => readJson(pointerPath, null)).filter(Boolean)
      : [];
    const manifests = latestPointers
      .map((latest) => {
        if (!latest?.manifest) return null;
        const manifest = readJson(latest.manifest, null);
        if (!manifest) return null;
        return {
          latest,
          manifest,
        };
      })
      .filter(Boolean);
    if (manifests.length === 0) return null;
    return {
      flowsLatest: true,
      manifests,
      manifest: manifests[0].manifest,
      scenes: manifests.flatMap(({ latest, manifest }) => {
        const runDir = latest.runDir || manifest.runDir;
        return (manifest.scenes || []).map((scene) => {
          const sceneFile = path.join(runDir, scene.scenePath);
          const sceneJson = readJson(sceneFile, null);
          const balance = readJson(path.join(path.dirname(sceneFile), "balance.json"), null);
          const beautify = readJson(path.join(path.dirname(sceneFile), "beautify.json"), null);
        return {
          ...scene,
          scene: sceneJson,
          balance,
          beautify,
          layoutReport: readJson(path.join(path.dirname(sceneFile), "layout-report.json"), null),
          manifestName: manifest.flow,
        };
      });
      }),
    };
  }
  const latest = readJson(config.latest_run, null);
  if (!latest?.manifest) return null;
  const manifest = readJson(latest.manifest, null);
  if (!manifest) return null;
  const runDir = latest.runDir || manifest.runDir;
  const scenes = (manifest.scenes || []).map((scene) => {
    const sceneFile = path.join(runDir, scene.scenePath);
    const sceneJson = readJson(sceneFile, null);
    const balance = readJson(path.join(path.dirname(sceneFile), "balance.json"), null);
    const beautify = readJson(path.join(path.dirname(sceneFile), "beautify.json"), null);
    return {
      ...scene,
      scene: sceneJson,
      balance,
      beautify,
      layoutReport: readJson(path.join(path.dirname(sceneFile), "layout-report.json"), null),
    };
  });
  return {
    latest,
    manifest,
    scenes,
  };
}

export function loadVoltmeterResult(config = {}) {
  if (config.command && config.mode !== "read_latest") maybeRun(config.command);
  const runPath = latestRunPathFromVoltmeter(config.latest_run, config.fallback_runs_dir);
  const report = runPath ? readJson(runPath, null) : null;
  const nerveWalk = runVoltmeterNerveWalk(config.nerve_walk || config.nerveWalk || {});
  if (!nerveWalk) return report;
  return {
    ...(report || {}),
    nerve_walk: nerveWalk,
  };
}

export async function loadAppTesterResult(config = {}) {
  return runAppTester(config);
}

function getPath(source = {}, pathExpression = "") {
  if (!pathExpression) return source;
  return String(pathExpression)
    .split(".")
    .filter(Boolean)
    .reduce((current, part) => {
      if (current == null) return undefined;
      if (/^\d+$/.test(part) && Array.isArray(current)) return current[Number(part)];
      return current?.[part];
    }, source);
}

function runVoltmeterCommandProbe(probe = {}) {
  const started = Date.now();
  try {
    const stdout = execSync(probe.command, {
      cwd: probe.cwd || undefined,
      stdio: "pipe",
      encoding: "utf8",
      shell: "/bin/zsh",
      timeout: Number(probe.timeout_ms || probe.timeoutMs || 120000),
    });
    let parsed = null;
    try {
      parsed = stdout.trim() ? JSON.parse(stdout) : null;
    } catch {}
    return {
      id: probe.id || "command_probe",
      ok: true,
      duration_ms: Date.now() - started,
      stdout: parsed ? undefined : stdout.slice(0, 4000),
      result: parsed || null,
    };
  } catch (error) {
    let parsed = null;
    try {
      parsed = error.stdout ? JSON.parse(String(error.stdout)) : null;
    } catch {}
    return {
      id: probe.id || "command_probe",
      ok: false,
      duration_ms: Date.now() - started,
      code: error.status ?? 1,
      stdout: parsed ? undefined : String(error.stdout || "").slice(0, 4000),
      stderr: String(error.stderr || "").slice(0, 4000),
      result: parsed || null,
      error: error.message,
    };
  }
}

function evaluateNerveExpectation(result = {}, expectation = {}) {
  const actual = getPath(result, expectation.path || "");
  let pass = true;
  if (Object.prototype.hasOwnProperty.call(expectation, "equals")) pass = actual === expectation.equals;
  if (expectation.exists === true) pass = actual !== undefined && actual !== null;
  if (expectation.truthy === true) pass = !!actual;
  if (Object.prototype.hasOwnProperty.call(expectation, "min")) pass = Number(actual) >= Number(expectation.min);
  if (Object.prototype.hasOwnProperty.call(expectation, "max")) pass = Number(actual) <= Number(expectation.max);
  if (Object.prototype.hasOwnProperty.call(expectation, "length_min")) {
    pass = Array.isArray(actual) || typeof actual === "string" ? actual.length >= Number(expectation.length_min) : false;
  }
  if (Array.isArray(expectation.includes)) {
    pass = Array.isArray(actual)
      ? expectation.includes.every((item) => actual.includes(item))
      : expectation.includes.every((item) => String(actual || "").includes(String(item)));
  }
  return {
    path: expectation.path || "",
    pass,
    expected: {
      equals: expectation.equals,
      exists: expectation.exists,
      truthy: expectation.truthy,
      min: expectation.min,
      max: expectation.max,
      length_min: expectation.length_min,
      includes: expectation.includes,
    },
    actual,
    detail: expectation.detail || null,
  };
}

function runVoltmeterNerveWalk(config = {}) {
  if (!config || config.enabled === false) return null;
  const probes = Array.isArray(config.probes) ? config.probes : [];
  const results = probes.map((probe) => {
    const raw = probe.type === "command" || probe.command
      ? runVoltmeterCommandProbe(probe)
      : {
          id: probe.id || "unsupported_probe",
          ok: false,
          error: `Unsupported nerve probe type: ${probe.type || "unknown"}`,
          result: null,
        };
    const assertions = (probe.expect || probe.expectations || []).map((expectation) =>
      evaluateNerveExpectation(raw.result || raw, expectation)
    );
    const assertionPass = assertions.every((assertion) => assertion.pass);
    return {
      ...raw,
      nerve: probe.nerve || probe.id || raw.id,
      source: probe.source || null,
      outcome: probe.outcome || null,
      pass: raw.ok && assertionPass,
      assertions,
    };
  });
  const passed = results.filter((probe) => probe.pass).length;
  const failed = results.length - passed;
  return {
    enabled: true,
    runner: "fir_voltmeter_nerve_walk",
    posture: "stimulate_trace_assert_learn",
    summary: {
      total: results.length,
      passed,
      failed,
      mean_duration_ms: Math.round(results.reduce((sum, probe) => sum + Number(probe.duration_ms || 0), 0) / Math.max(1, results.length)),
    },
    probes: results,
    training_events: results.flatMap((probe) => {
      const nested = Array.isArray(probe.result?.training_events) ? probe.result.training_events : [];
      return [
        ...nested,
        {
          id: `fir_nerve_walk:${probe.id}`,
          signal: probe.nerve || probe.id,
          outcome: probe.pass ? "pass" : "fail",
          weight: probe.pass ? 0.7 : 0.95,
          interpretation: probe.pass
            ? `${probe.nerve || probe.id} reached a verified outcome.`
            : `${probe.nerve || probe.id} did not reach a verified outcome.`,
        },
      ];
    }),
  };
}

function runKnipWorkspace(workspace = {}, defaults = {}) {
  const cwd = workspace.cwd || defaults.cwd;
  if (!cwd || !fs.existsSync(cwd)) {
    return {
      id: workspace.id || cwd || "unknown",
      cwd,
      ok: false,
      skipped: true,
      error: "Knip workspace cwd is missing or does not exist.",
      issues: [],
    };
  }
  const include = workspace.include || defaults.include || "files,dependencies,exports";
  const config = workspace.config ? ` --config ${JSON.stringify(workspace.config)}` : "";
  const command = `npx knip@6.12.1 --reporter json --no-exit-code --no-progress --include ${JSON.stringify(include)}${config}`;
  try {
    const stdout = execSync(command, { cwd, stdio: "pipe", encoding: "utf8", shell: "/bin/zsh" });
    const parsed = stdout.trim() ? JSON.parse(stdout) : { issues: [] };
    return {
      id: workspace.id || path.basename(cwd),
      cwd,
      ok: true,
      command,
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      counters: parsed.counters || null,
    };
  } catch (error) {
    let parsed = null;
    try {
      parsed = error.stdout ? JSON.parse(String(error.stdout)) : null;
    } catch {}
    return {
      id: workspace.id || path.basename(cwd),
      cwd,
      ok: false,
      command,
      code: error.status ?? 1,
      stdout: String(error.stdout || ""),
      stderr: String(error.stderr || ""),
      issues: Array.isArray(parsed?.issues) ? parsed.issues : [],
      counters: parsed?.counters || null,
    };
  }
}

function loadBodyRegistry(registryPath = "") {
  const registry = readJson(registryPath, null);
  return registry && typeof registry === "object" ? registry : null;
}

function annotateIssueWithBody(workspace = {}, issue = {}, registry = null) {
  if (!registry?.modules || !issue?.file) return issue;
  const key = `${workspace.id || path.basename(workspace.cwd || "")}:${issue.file}`;
  return {
    ...issue,
    body_registry_key: key,
    body_registry: registry.modules[key] || null,
  };
}

export function loadClogAuditResult(config = {}) {
  if (!config || config.enabled === false) {
    return {
      enabled: false,
      workspaces: [],
      summary: { workspace_total: 0, issue_total: 0 },
    };
  }
  const workspaces = Array.isArray(config.workspaces) ? config.workspaces : [];
  const bodyRegistry = loadBodyRegistry(config.body_registry || config.bodyRegistry || "");
  const results = workspaces.map((workspace) => {
    const result = runKnipWorkspace(workspace, config);
    return {
      ...result,
      issues: (result.issues || []).map((issue) => annotateIssueWithBody(workspace, issue, bodyRegistry)),
    };
  });
  const issueTotal = results.reduce((sum, result) => sum + (result.issues || []).length, 0);
  return {
    enabled: true,
    tool: "knip",
    posture: "report_only",
    body_registry: bodyRegistry
      ? {
          path: config.body_registry || config.bodyRegistry,
          schema_version: bodyRegistry.schema_version || null,
          doctrine: bodyRegistry.doctrine || null,
        }
      : null,
    workspaces: results,
    summary: {
      workspace_total: results.length,
      issue_total: issueTotal,
      failed_workspace_total: results.filter((result) => !result.ok && !result.skipped).length,
    },
  };
}
