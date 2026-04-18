import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, readJson, writeJson } from "./utils.mjs";
import { runIntegrity } from "./fir/runner.mjs";
import { installSecretValue } from "./secrets/installers.mjs";
import { storeSecret } from "./secrets/store.mjs";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");

function usage() {
  console.log(`FIR

Usage:
  node src/cli.mjs --target workspace-demo
  node src/cli.mjs --target hopper111-live --preflight-only
  node src/cli.mjs --target hopper111-live --journey contacts:create-contact
  node src/cli.mjs --target finch-live --hammer
  node src/cli.mjs --target finch-live --hammer --hammer-route finch-core
  node src/cli.mjs --target hopper111-live --install-secret POINTER_CF_API_TOKEN --from-env POINTER_CF_API_TOKEN
  node src/cli.mjs --target workspace-demo --loop-mode fix --patch-summary "..."
  node src/cli.mjs --target hopper111-live --force-run
  node src/cli.mjs --history 10
`);
}

function resolveTarget(targetId) {
  const targetPath = path.join(rootDir, "targets", `${targetId}.json`);
  return readJson(targetPath, null);
}

function findSecretSpec(target = {}, secretName) {
  return (target.requiredSecrets || []).find((secret) => secret.name === secretName) || null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (args.history) {
    const history = readJson(path.join(rootDir, "state", "run-index.json"), []);
    console.log(JSON.stringify(history.slice(0, Number(args.history || 10)), null, 2));
    return;
  }

  const target = resolveTarget(String(args.target || "workspace-demo"));
  if (!target) {
    throw new Error(`Unknown target: ${args.target || "workspace-demo"}`);
  }

  if (args.installSecret) {
    const secretName = String(args.installSecret);
    const fromEnvName = String(args.fromEnv || args.installSecret);
    const rawValue = process.env[fromEnvName];
    if (!rawValue) {
      throw new Error(`Missing source environment variable for secret install: ${fromEnvName}`);
    }
    const secretSpec = findSecretSpec(target, secretName);
    if (!secretSpec) {
      throw new Error(`Target ${target.id} does not define required secret ${secretName}`);
    }
    const stored = storeSecret(secretName, rawValue);
    const installs = (secretSpec.installs || []).map((install) => installSecretValue(install, rawValue));
    console.log(
      JSON.stringify(
        {
          target_id: target.id,
          secret_name: secretName,
          status: "stored_and_installed",
          storage: stored.storage,
          installs,
          redacted: true,
        },
        null,
        2,
      ),
    );
    return;
  }

  const result = await runIntegrity({ rootDir, target, args });
  const latestRunPath = path.join(rootDir, "state", "latest-run.json");
  const historyPath = path.join(rootDir, "state", "run-index.json");
  writeJson(latestRunPath, {
    run_id: result.finalState.run_id,
    artifact_dir: result.artifactDir,
    final_state_path: path.join(result.artifactDir, "final-state.json"),
    recorded_at: new Date().toISOString(),
  });
  const history = readJson(historyPath, []);
  history.unshift({
    run_id: result.finalState.run_id,
    target_id: target.id,
    artifact_dir: result.artifactDir,
    correction_state: result.correction?.state || result.finalState.correction_state || "not_started",
    failure_total: result.failures.length,
    recorded_at: new Date().toISOString(),
  });
  writeJson(historyPath, history.slice(0, 50));

  console.log(`FIR run: ${result.finalState.run_id}`);
  console.log(`Artifacts: ${result.artifactDir}`);
  console.log(`Journeys: ${result.journeys?.selected_journey_count || 0} (${(result.journeys?.selected_journey_ids || []).join(", ") || "none"})`);
  console.log(`Hammer: ${result.hammer?.plan?.status || result.finalState.hammer_status || "unknown"} (${(result.hammer?.plan?.selected_route_ids || result.finalState.hammer_routes || []).join(", ") || "none"})`);
  console.log(`Preflight: ${result.preflight?.overall || result.finalState.preflight_status || "unknown"}`);
  if (result.correction) {
    console.log(`Correction state: ${result.correction.state}`);
    console.log(`Should continue: ${result.correction.should_continue ? "yes" : "no"}`);
    console.log(`Next action: ${result.correction.next_action}`);
  } else {
    console.log(`Correction state: ${result.finalState.correction_state || "not_started"}`);
    console.log(`Should continue: ${result.finalState.should_continue ? "yes" : "no"}`);
    console.log(`Next action: ${result.finalState.next_action}`);
  }
  if (result.hammer?.report) {
    console.log(`Hammer verdict: ${result.hammer.report.verdict}`);
    console.log(
      `Hammer requests: ${result.hammer.report.summary?.total_requests || 0}, errors: ${result.hammer.report.summary?.error_count || 0}, p95: ${result.hammer.report.summary?.p95_ms || 0}ms`,
    );
  }
  console.log(`Failures: ${result.failures.length}`);
  for (const failure of result.failures.slice(0, 12)) {
    console.log(
      `- [${String(failure.severity).toUpperCase()}] ${failure.source}/${failure.lane}: ${failure.observed}`.trim(),
    );
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
