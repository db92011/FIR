import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
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
  if (config.command && config.mode !== "read_latest") maybeRun(config.command);
  const reportPath = latestRunPathFromPointer(config.latest_run);
  return reportPath ? readJson(reportPath, null) : null;
}

export function loadScreenGenieResult(config = {}) {
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
  return runPath ? readJson(runPath, null) : null;
}
