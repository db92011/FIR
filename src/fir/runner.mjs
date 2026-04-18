import path from "node:path";
import { loadPointerResult, loadScreenGenieResult, loadVoltmeterResult } from "../adapters.mjs";
import { buildRemediationPlan, normalizeAll, repairPacketsFromFailures } from "../normalize.mjs";
import { cleanObject, ensureDir, nowStamp, writeJson } from "../utils.mjs";
import { runCorrectionLoop } from "./correctionLoop.mjs";
import { buildJourneyPlan, renderJourneySummary } from "./journeys.mjs";
import { buildHammerPlan, renderHammerSummary, runHammer } from "./hammer.mjs";
import { runPreflight } from "./preflight.mjs";
import fs from "node:fs";

export async function runIntegrity({ rootDir, target, args = {} }) {
  const timestamp = nowStamp();
  const artifactDir = path.join(rootDir, "artifacts", "fir", timestamp);
  ensureDir(artifactDir);
  const journeyPlan = buildJourneyPlan({ target, args });
  writeJson(path.join(artifactDir, "journey-plan.json"), journeyPlan);
  fs.writeFileSync(path.join(artifactDir, "journey-summary.txt"), renderJourneySummary(journeyPlan), "utf8");
  const hammerPlan = buildHammerPlan({ target, args });
  writeJson(path.join(artifactDir, "hammer-plan.json"), hammerPlan);
  fs.writeFileSync(path.join(artifactDir, "hammer-summary.txt"), renderHammerSummary(hammerPlan), "utf8");

  const preflight = await runPreflight({ target });
  writeJson(path.join(artifactDir, "preflight-report.json"), preflight);

  if (args.preflightOnly) {
    const finalState = cleanObject({
      run_id: `fir_${target.id}_${timestamp}`,
      target_id: target.id,
      target_type: target.type || null,
      entry: target.entry || null,
      journey_status: journeyPlan.status,
      journey_total: journeyPlan.selected_journey_count,
      journey_ids: journeyPlan.selected_journey_ids,
      hammer_status: hammerPlan.status,
      hammer_routes: hammerPlan.selected_route_ids,
      preflight_status: preflight.overall,
      should_continue: false,
      next_action: preflight.next_action,
      success: preflight.overall === "ready",
    });
    writeJson(path.join(artifactDir, "pointer-report.json"), {});
    writeJson(path.join(artifactDir, "screen-report.json"), {});
    writeJson(path.join(artifactDir, "voltmeter-report.json"), {});
    writeJson(path.join(artifactDir, "hammer-report.json"), {});
    writeJson(path.join(artifactDir, "aggregated-failures.json"), []);
    writeJson(path.join(artifactDir, "repair-packets.json"), []);
    writeJson(path.join(artifactDir, "correction-history.json"), []);
    writeJson(path.join(artifactDir, "final-state.json"), finalState);
    return {
      artifactDir,
      preflight,
      pointer: {},
      screen: {},
      voltmeter: {},
      journeys: journeyPlan,
      hammer: { plan: hammerPlan, report: null },
      failures: [],
      repairPackets: [],
      correction: null,
      finalState,
    };
  }

  if (preflight.overall !== "ready" && !args.forceRun) {
    const finalState = cleanObject({
      run_id: `fir_${target.id}_${timestamp}`,
      target_id: target.id,
      target_type: target.type || null,
      entry: target.entry || null,
      journey_status: journeyPlan.status,
      journey_total: journeyPlan.selected_journey_count,
      journey_ids: journeyPlan.selected_journey_ids,
      hammer_status: hammerPlan.status,
      hammer_routes: hammerPlan.selected_route_ids,
      preflight_status: preflight.overall,
      correction_state: "blocked_requires_human",
      should_continue: false,
      next_action: preflight.next_action,
      preflight_blocked: true,
      success: false,
    });
    writeJson(path.join(artifactDir, "pointer-report.json"), {});
    writeJson(path.join(artifactDir, "screen-report.json"), {});
    writeJson(path.join(artifactDir, "voltmeter-report.json"), {});
    writeJson(path.join(artifactDir, "hammer-report.json"), {});
    writeJson(path.join(artifactDir, "aggregated-failures.json"), []);
    writeJson(path.join(artifactDir, "repair-packets.json"), []);
    writeJson(path.join(artifactDir, "correction-history.json"), []);
    writeJson(path.join(artifactDir, "final-state.json"), finalState);
    return {
      artifactDir,
      preflight,
      pointer: {},
      screen: {},
      voltmeter: {},
      journeys: journeyPlan,
      hammer: { plan: hammerPlan, report: null },
      failures: [],
      repairPackets: [],
      correction: null,
      finalState,
    };
  }

  if (journeyPlan.status !== "ready") {
    const finalState = cleanObject({
      run_id: `fir_${target.id}_${timestamp}`,
      target_id: target.id,
      target_type: target.type || null,
      entry: target.entry || null,
      journey_status: journeyPlan.status,
      journey_total: journeyPlan.selected_journey_count,
      journey_ids: journeyPlan.selected_journey_ids,
      hammer_status: hammerPlan.status,
      hammer_routes: hammerPlan.selected_route_ids,
      preflight_status: preflight.overall,
      correction_state: "blocked_requires_human",
      should_continue: false,
      next_action:
        journeyPlan.missing_journey_ids?.length > 0
          ? `define_missing_journeys:${journeyPlan.missing_journey_ids.join(",")}`
          : `repair_invalid_journeys:${(journeyPlan.invalid_journey_ids || []).join(",")}`,
      journey_blocked: true,
      success: false,
    });
    writeJson(path.join(artifactDir, "pointer-report.json"), {});
    writeJson(path.join(artifactDir, "screen-report.json"), {});
    writeJson(path.join(artifactDir, "voltmeter-report.json"), {});
    writeJson(path.join(artifactDir, "hammer-report.json"), {});
    writeJson(path.join(artifactDir, "aggregated-failures.json"), []);
    writeJson(path.join(artifactDir, "repair-packets.json"), []);
    writeJson(path.join(artifactDir, "correction-history.json"), []);
    writeJson(path.join(artifactDir, "final-state.json"), finalState);
    return {
      artifactDir,
      preflight,
      pointer: {},
      screen: {},
      voltmeter: {},
      journeys: journeyPlan,
      hammer: { plan: hammerPlan, report: null },
      failures: [],
      repairPackets: [],
      correction: null,
      finalState,
    };
  }

  if (args.hammerOnly) {
    const hammerReport = await runHammer({ plan: hammerPlan });
    writeJson(path.join(artifactDir, "pointer-report.json"), {});
    writeJson(path.join(artifactDir, "screen-report.json"), {});
    writeJson(path.join(artifactDir, "voltmeter-report.json"), {});
    writeJson(path.join(artifactDir, "hammer-report.json"), hammerReport || {});
    fs.writeFileSync(path.join(artifactDir, "hammer-summary.txt"), renderHammerSummary(hammerPlan, hammerReport), "utf8");

    const finalState = cleanObject({
      run_id: `fir_${target.id}_${timestamp}`,
      target_id: target.id,
      target_type: target.type || null,
      entry: target.entry || null,
      journey_status: journeyPlan.status,
      journey_total: journeyPlan.selected_journey_count,
      journey_ids: journeyPlan.selected_journey_ids,
      hammer_status: hammerPlan.status,
      hammer_routes: hammerPlan.selected_route_ids,
      hammer_verdict: hammerReport.verdict,
      hammer_total_requests: hammerReport.summary?.total_requests,
      hammer_error_count: hammerReport.summary?.error_count,
      preflight_status: preflight.overall,
      correction_state: hammerReport.verdict === "passed" ? "corrected" : "blocked_requires_human",
      should_continue: hammerReport.verdict !== "passed",
      next_action: hammerReport.verdict === "passed" ? "none" : "harden_capacity_lane",
      success: hammerReport.verdict === "passed",
    });
    writeJson(path.join(artifactDir, "aggregated-failures.json"), []);
    writeJson(path.join(artifactDir, "repair-packets.json"), []);
    writeJson(path.join(artifactDir, "correction-history.json"), []);
    writeJson(path.join(artifactDir, "final-state.json"), finalState);
    return {
      artifactDir,
      preflight,
      pointer: {},
      screen: {},
      voltmeter: {},
      journeys: journeyPlan,
      hammer: { plan: hammerPlan, report: hammerReport },
      failures: [],
      repairPackets: [],
      correction: null,
      finalState,
    };
  }

  const pointer = loadPointerResult(target.pointer || {});
  const screen = loadScreenGenieResult(target.screenGenie || {});
  const voltmeter = loadVoltmeterResult(target.voltmeter || {});
  const hammerReport = args.hammer || args.hammerOnly ? await runHammer({ plan: hammerPlan }) : { verdict: "skipped", summary: { total_requests: 0, error_count: 0, mean_ms: 0, p95_ms: 0 }, routes: [] };

  writeJson(path.join(artifactDir, "pointer-report.json"), pointer || {});
  writeJson(path.join(artifactDir, "screen-report.json"), screen || {});
  writeJson(path.join(artifactDir, "voltmeter-report.json"), voltmeter || {});
  writeJson(path.join(artifactDir, "hammer-report.json"), hammerReport || {});
  fs.writeFileSync(path.join(artifactDir, "hammer-summary.txt"), renderHammerSummary(hammerPlan, hammerReport), "utf8");

  const failures = normalizeAll({ pointer, screen, voltmeter });
  const remediationPlan = buildRemediationPlan(failures);
  const repairPackets = repairPacketsFromFailures(remediationPlan.active_failures);
  const correction = runCorrectionLoop({
    rootDir,
    runId: `fir_${target.id}_${timestamp}`,
    target,
    failures,
    remediationPlan,
    args,
  });

  const finalState = cleanObject({
    run_id: `fir_${target.id}_${timestamp}`,
    target_id: target.id,
    target_type: target.type || null,
    entry: target.entry || null,
    journey_status: journeyPlan.status,
    journey_total: journeyPlan.selected_journey_count,
    journey_ids: journeyPlan.selected_journey_ids,
    hammer_status: hammerPlan.status,
    hammer_routes: hammerPlan.selected_route_ids,
    hammer_verdict: hammerReport.verdict,
    hammer_total_requests: hammerReport.summary?.total_requests,
    hammer_error_count: hammerReport.summary?.error_count,
    preflight_status: preflight.overall,
    flow_count: (target.flows || []).length,
    failure_total: failures.length,
    active_source: remediationPlan.active_source,
    active_failure_total: remediationPlan.active_failures.length,
    deferred_failure_total: remediationPlan.deferred_failures.length,
    source_summary: remediationPlan.source_summary,
    correction_state: correction.state,
    should_continue: correction.should_continue,
    next_action: correction.next_action,
    comparison: correction.comparison,
    critical_remaining: remediationPlan.active_failures.filter((item) => String(item.severity).toLowerCase() === "critical").length,
    high_remaining: remediationPlan.active_failures.filter((item) => String(item.severity).toLowerCase() === "high").length,
    success:
      failures.filter((item) => ["critical", "high"].includes(String(item.severity).toLowerCase())).length === 0 &&
      correction.state === "corrected",
  });

  writeJson(path.join(artifactDir, "aggregated-failures.json"), failures);
  writeJson(path.join(artifactDir, "active-failures.json"), remediationPlan.active_failures);
  writeJson(path.join(artifactDir, "deferred-failures.json"), remediationPlan.deferred_failures);
  writeJson(path.join(artifactDir, "repair-packets.json"), repairPackets);
  writeJson(path.join(artifactDir, "correction-history.json"), correction.history || []);
  writeJson(path.join(artifactDir, "final-state.json"), finalState);

  return {
      artifactDir,
      preflight,
      pointer,
      screen,
      voltmeter,
    journeys: journeyPlan,
    hammer: { plan: hammerPlan, report: hammerReport },
    failures,
    repairPackets,
    correction,
    finalState,
  };
}
