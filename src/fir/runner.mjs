import path from "node:path";
import { loadAppTesterResult, loadClogAuditResult, loadPointerResult, loadScreenGenieResult, loadVoltmeterResult } from "../adapters.mjs";
import { buildRemediationPlan, normalizeAll, normalizeAppTester, repairPacketsFromFailures } from "../normalize.mjs";
import { cleanObject, ensureDir, nowStamp, writeJson } from "../utils.mjs";
import { runCorrectionLoop } from "./correctionLoop.mjs";
import { buildJourneyPlan, renderJourneySummary } from "./journeys.mjs";
import { buildHammerPlan, renderHammerSummary, runHammer } from "./hammer.mjs";
import { runPreflight } from "./preflight.mjs";
import fs from "node:fs";

function declaredAppSurface(target = {}) {
  const type = String(target.type || "").toLowerCase();
  const flows = (target.flows || []).map((flow) => String(flow).toLowerCase());
  const tags = (target.tags || []).map((tag) => String(tag).toLowerCase());
  const pointerKind = String(
    target.pointer?.surface_kind ||
      target.pointer?.surfaceKind ||
      target.pointer?.surface?.kind ||
      ""
  ).toLowerCase();
  return (
    type.includes("pwa") ||
    pointerKind.includes("pwa") ||
    pointerKind.includes("app") ||
    flows.some((flow) => ["app-surface", "public-app", "pwa"].includes(flow)) ||
    tags.some((tag) => ["app-surface", "public-app", "pwa"].includes(tag))
  );
}

function resolveAppTesterConfig(target = {}) {
  const declared = target.appTester || {};
  if (declared.enabled === false) return declared;
  if (!declared.enabled && !declaredAppSurface(target)) return declared;
  return {
    kind: "pwa",
    url: target.entry,
    declared_by: declared.enabled ? "target.appTester" : "pointer_surface_contract",
    ...declared,
    enabled: true,
  };
}

function resolveAirConfig(target = {}) {
  const declared = target.appTester || {};
  const air = target.air || target.applicationIntegrity || target.application_integrity || {};
  return {
    kind: "pwa",
    url: target.entry,
    declared_by: "air_run",
    ...resolveAppTesterConfig(target),
    ...declared,
    ...air,
    enabled: true,
  };
}

export async function runIntegrity({ rootDir, target, args = {} }) {
  const timestamp = nowStamp();
  const artifactDir = path.join(rootDir, "artifacts", "fir", timestamp);
  ensureDir(artifactDir);
  const airMode = args.air || args.airOnly;
  const journeyPlan = buildJourneyPlan({ target, args });
  writeJson(path.join(artifactDir, "journey-plan.json"), journeyPlan);
  fs.writeFileSync(path.join(artifactDir, "journey-summary.txt"), renderJourneySummary(journeyPlan), "utf8");
  const hammerPlan = buildHammerPlan({ target, args });
  writeJson(path.join(artifactDir, "hammer-plan.json"), hammerPlan);
  fs.writeFileSync(path.join(artifactDir, "hammer-summary.txt"), renderHammerSummary(hammerPlan), "utf8");

  const preflight = await runPreflight({ target });
  writeJson(path.join(artifactDir, "preflight-report.json"), preflight);

  if (airMode) {
    const runId = `air_${target.id}_${timestamp}`;
    const appTester = await loadAppTesterResult(resolveAirConfig(target));
    const findings = normalizeAppTester(appTester);
    const blockingFailures = findings.filter((failure) => ["critical", "high"].includes(String(failure.severity || "").toLowerCase()));
    const recommendationFailures = findings.filter((failure) => !["critical", "high"].includes(String(failure.severity || "").toLowerCase()));
    const remediationPlan = buildRemediationPlan(blockingFailures);
    const repairPackets = repairPacketsFromFailures(remediationPlan.active_failures);
    const correction = runCorrectionLoop({
      rootDir,
      runId,
      target,
      failures: blockingFailures,
      remediationPlan,
      args,
    });
    const finalState = cleanObject({
      run_id: runId,
      mode: "air",
      target_id: target.id,
      target_type: target.type || null,
      entry: target.entry || null,
      air_status: appTester?.application_integrity_run?.status || appTester?.status || "unknown",
      app_tester_status: appTester?.status || null,
      package_readiness: appTester?.package_readiness || null,
      installed_icon_start_url: appTester?.application_integrity_run?.installed_icon_start_url || null,
      expected_app_runtime_url: appTester?.application_integrity_run?.expected_app_runtime_url || null,
      preflight_status: "not_required_for_air",
      preflight_observed_status: preflight.overall,
      correction_state: correction?.state || (blockingFailures.length === 0 ? "corrected" : "repair_needed"),
      should_continue: blockingFailures.length > 0,
      next_action: blockingFailures.length > 0 ? "repair_air_install_integrity" : (recommendationFailures.length > 0 ? "review_air_recommendations" : "none"),
      failure_total: findings.length,
      blocking_failure_total: blockingFailures.length,
      recommendation_total: recommendationFailures.length,
      success: blockingFailures.length === 0,
    });
    writeJson(path.join(artifactDir, "pointer-report.json"), {});
    writeJson(path.join(artifactDir, "screen-report.json"), {});
    writeJson(path.join(artifactDir, "app-tester-report.json"), appTester || {});
    writeJson(path.join(artifactDir, "voltmeter-report.json"), {});
    writeJson(path.join(artifactDir, "clog-report.json"), {});
    writeJson(path.join(artifactDir, "hammer-report.json"), {});
    writeJson(path.join(artifactDir, "aggregated-failures.json"), findings);
    writeJson(path.join(artifactDir, "repair-packets.json"), repairPackets);
    writeJson(path.join(artifactDir, "correction-history.json"), correction?.history || []);
    writeJson(path.join(artifactDir, "final-state.json"), finalState);
    return {
      artifactDir,
      preflight,
      pointer: {},
      screen: {},
      appTester,
      voltmeter: {},
      clog: {},
      journeys: journeyPlan,
      hammer: { plan: hammerPlan, report: null },
      failures: findings,
      repairPackets,
      correction,
      finalState,
    };
  }

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
    writeJson(path.join(artifactDir, "app-tester-report.json"), {});
    writeJson(path.join(artifactDir, "voltmeter-report.json"), {});
    writeJson(path.join(artifactDir, "clog-report.json"), {});
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
      appTester: {},
      voltmeter: {},
      clog: {},
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
    writeJson(path.join(artifactDir, "app-tester-report.json"), {});
    writeJson(path.join(artifactDir, "voltmeter-report.json"), {});
    writeJson(path.join(artifactDir, "clog-report.json"), {});
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
      appTester: {},
      voltmeter: {},
      clog: {},
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
    writeJson(path.join(artifactDir, "app-tester-report.json"), {});
    writeJson(path.join(artifactDir, "voltmeter-report.json"), {});
    writeJson(path.join(artifactDir, "clog-report.json"), {});
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
      appTester: {},
      voltmeter: {},
      clog: {},
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
    writeJson(path.join(artifactDir, "app-tester-report.json"), {});
    writeJson(path.join(artifactDir, "voltmeter-report.json"), {});
    writeJson(path.join(artifactDir, "clog-report.json"), {});
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
      appTester: {},
      voltmeter: {},
      clog: {},
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
  const appTester = await loadAppTesterResult(resolveAppTesterConfig(target));
  const voltmeter = loadVoltmeterResult(target.voltmeter || {});
  const clog = loadClogAuditResult(target.clog || {});
  const hammerReport = args.hammer || args.hammerOnly ? await runHammer({ plan: hammerPlan }) : { verdict: "skipped", summary: { total_requests: 0, error_count: 0, mean_ms: 0, p95_ms: 0 }, routes: [] };

  writeJson(path.join(artifactDir, "pointer-report.json"), pointer || {});
  writeJson(path.join(artifactDir, "screen-report.json"), screen || {});
  writeJson(path.join(artifactDir, "app-tester-report.json"), appTester || {});
  writeJson(path.join(artifactDir, "voltmeter-report.json"), voltmeter || {});
  writeJson(path.join(artifactDir, "clog-report.json"), clog || {});
  writeJson(path.join(artifactDir, "hammer-report.json"), hammerReport || {});
  fs.writeFileSync(path.join(artifactDir, "hammer-summary.txt"), renderHammerSummary(hammerPlan, hammerReport), "utf8");

  const failures = normalizeAll({ pointer, screen, appTester, voltmeter, clog });
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
    app_tester_status: appTester?.status,
    app_tester_score: appTester?.score,
    app_tester_package_status: appTester?.package_readiness?.status,
    failure_total: failures.length,
    active_source: remediationPlan.active_source,
    active_failure_total: remediationPlan.active_failures.length,
    deferred_failure_total: remediationPlan.deferred_failures.length,
    clog_issue_total: clog?.summary?.issue_total,
    clog_workspace_total: clog?.summary?.workspace_total,
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
      appTester,
      voltmeter,
      clog,
    journeys: journeyPlan,
    hammer: { plan: hammerPlan, report: hammerReport },
    failures,
    repairPackets,
    correction,
    finalState,
  };
}
