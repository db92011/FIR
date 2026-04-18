import path from "node:path";
import { hashStable } from "./utils.mjs";

export const FIR_SOURCE_ORDER = ["pointer", "screen", "voltmeter"];

function makeFailure({
  source,
  lane,
  severity,
  confidence,
  expected,
  observed,
  evidence = {},
  ownership = {},
  suggestedStrategy = {},
  asset = null,
}) {
  return {
    failure_id: `fir_${source}_${lane}_${hashStable({ severity, expected, observed, asset, evidence })}`,
    source,
    lane,
    severity,
    confidence,
    expected,
    observed,
    asset,
    evidence,
    ownership,
    suggested_strategy: suggestedStrategy,
    attempt_count: 0,
  };
}

export function normalizePointer(report) {
  if (!report) {
    return [
      makeFailure({
        source: "pointer",
        lane: "security",
        severity: "high",
        confidence: 0.95,
        expected: "Pointer should produce a boundary audit report.",
        observed: "No Pointer report could be loaded.",
        suggestedStrategy: {
          type: "restore_pointer_input",
          description: "Run Pointer or restore the latest run pointer before retrying FIR.",
          priority: "high",
        },
      }),
    ];
  }
  return (report.findings || [])
    .filter((finding) => finding?.finding !== "no_findings_generated")
    .map((finding) =>
    makeFailure({
      source: "pointer",
      lane: String(finding.surface || "Cloudflare").toLowerCase().includes("linux") ? "runtime" : "security",
      severity: finding.severity || "medium",
      confidence: finding.confidence || 0.75,
      expected: finding.expected,
      observed: finding.observed,
      evidence: finding.evidence || {},
      ownership: finding.ownership || {},
      suggestedStrategy: finding.recommended_fix || {},
      asset: finding.asset || finding.route || null,
    }),
  );
}

export function normalizeScreenGenie(payload) {
  if (!payload?.manifest) {
    return [
      makeFailure({
        source: "screen",
        lane: "surface",
        severity: "high",
        confidence: 0.93,
        expected: "Screen Genie should provide a scene-based manifest.",
        observed: "No Screen Genie manifest could be loaded.",
        suggestedStrategy: {
          type: "restore_screen_run",
          description: "Run Screen Genie for the target flow or restore the latest manifest pointer.",
          priority: "high",
        },
      }),
    ];
  }

  const failures = [];
  if (payload.flowsLatest) {
    for (const bundle of payload.manifests || []) {
      if (bundle.manifest.status && bundle.manifest.status !== "passed") {
        failures.push(
          makeFailure({
            source: "screen",
            lane: "surface",
            severity: "high",
            confidence: 0.9,
            expected: "The Hopper111 protected flow should complete successfully.",
            observed: `Screen Genie flow ${bundle.manifest.flow} status is ${bundle.manifest.status}.`,
            evidence: { manifest: bundle.manifest },
            suggestedStrategy: {
              type: "repair_ui_flow",
              description: "Inspect the failing Hopper111 flow and restore the broken protected page path.",
              priority: "high",
            },
            asset: bundle.manifest.startUrl || bundle.manifest.baseUrl || null,
          }),
        );
      }
    }
  }
  if (payload.capture) {
    const captures = Array.isArray(payload.captures) ? payload.captures : [payload.manifest].filter(Boolean);
    failures.push(
      makeFailure({
        source: "screen",
        lane: "surface",
        severity: "medium",
        confidence: 0.68,
        expected: "A full Screen Genie flow should be available for richer UI truth checks.",
        observed: "Only live capture manifests are available for this target, so surface coverage is screenshot-only.",
        evidence: { captures },
        suggestedStrategy: {
          type: "add_screen_flow",
          description: "Create a Hopper111 Screen Genie flow so FIR can inspect interactive scenes instead of single captures.",
          priority: "medium",
        },
        asset: captures.map((capture) => capture.url).filter(Boolean).join(", ") || payload.manifest.url || null,
      }),
    );
    return failures;
  }
  if (!payload.flowsLatest && payload.manifest.status && payload.manifest.status !== "passed") {
    failures.push(
      makeFailure({
        source: "screen",
        lane: "surface",
        severity: "high",
        confidence: 0.9,
        expected: "The UI flow should complete successfully.",
        observed: `Screen Genie flow status is ${payload.manifest.status}.`,
        evidence: { manifest: payload.manifest },
        suggestedStrategy: {
          type: "repair_ui_flow",
          description: "Inspect the failing scene and restore the broken UI path before rerunning FIR.",
          priority: "high",
        },
      }),
    );
  }

  for (const entry of payload.scenes || []) {
    const hasLayoutReport = !!entry.layoutReport;
    const layoutFindings = Array.isArray(entry.layoutReport?.findings) ? entry.layoutReport.findings : [];
    if (hasLayoutReport) {
      for (const finding of layoutFindings) {
        failures.push(
          makeFailure({
            source: "screen",
            lane: "surface",
            severity: finding.severity || "medium",
            confidence: finding.confidence || 0.82,
            expected: finding.expected || "The rendered layout should stay balanced, clear, and visually trustworthy.",
            observed: finding.observed || finding.message || "A Screen Genie layout finding was reported.",
            evidence: {
              scene_id: entry.sceneId,
              scene_path: entry.scenePath,
              layout_report: entry.layoutReport,
            },
            ownership: {
              zone: "surface",
              likely_files: [],
              suspected_modules: ["ui-layout", "spacing", "visual-balance"],
            },
            suggestedStrategy: {
              type: "tighten_surface_layout",
              description:
                (Array.isArray(finding.suggested_patch_hints) && finding.suggested_patch_hints[0]) ||
                entry.beautify?.summary ||
                "Use the layout report guidance to tighten the screen.",
              priority: finding.severity === "high" ? "high" : "medium",
            },
            asset: entry.scene?.url || entry.sceneId,
          }),
        );
      }
      continue;
    }

    const balanceIssues = entry.balance?.issues || [];
    for (const issue of balanceIssues) {
      failures.push(
        makeFailure({
          source: "screen",
          lane: "surface",
          severity: issue.severity || "medium",
          confidence: 0.78,
          expected: "The rendered layout should stay balanced, clear, and visually trustworthy.",
          observed: issue.message,
          evidence: {
            scene_id: entry.sceneId,
            scene_path: entry.scenePath,
            balance: entry.balance,
          },
          ownership: {
            zone: "surface",
            likely_files: [],
            suspected_modules: ["ui-layout", "spacing", "visual-balance"],
          },
          suggestedStrategy: {
            type: "tighten_surface_layout",
            description: entry.beautify?.summary || "Use the balance and beautify guidance to tighten the screen.",
            priority: issue.severity === "high" ? "high" : "medium",
          },
          asset: entry.scene?.url || entry.sceneId,
        }),
      );
    }
  }
  return failures;
}

export function normalizeVoltmeter(report) {
  if (!report) {
    return [
      makeFailure({
        source: "voltmeter",
        lane: "runtime",
        severity: "high",
        confidence: 0.95,
        expected: "Voltmeter should provide a continuity or doctrine report.",
        observed: "No Voltmeter report could be loaded.",
        suggestedStrategy: {
          type: "restore_voltmeter_input",
          description: "Run Voltmeter or restore the latest run pointer before retrying FIR.",
          priority: "high",
        },
      }),
    ];
  }
  const failures = [];
  for (const check of report.truth_map || []) {
    if (check.pass === false) {
      failures.push(
        makeFailure({
          source: "voltmeter",
          lane: "runtime",
          severity: "high",
          confidence: 0.9,
          expected: `${check.name} should pass.`,
          observed: check.detail || `${check.name} failed.`,
          evidence: check.artifacts || {},
          ownership: {
            zone: "runtime",
            likely_files: report.profile?.path ? [report.profile.path] : [],
            suspected_modules: ["continuity", "truth-map"],
          },
          suggestedStrategy: {
            type: "repair_runtime_truth",
            description: "Repair the first failing continuity or truth-map branch before rerunning FIR.",
            priority: "high",
          },
          asset: report.profile?.id || null,
        }),
      );
    }
  }
  if ((report.verdicts?.truth_verdict && report.verdicts.truth_verdict !== "pass") || failures.length === 0 && report.run?.runner_mode) {
    // If verdicts exist but truth failed without explicit failed checks surfacing first, add a summary failure.
  }
  return failures;
}

export function normalizeAll({ pointer, screen, voltmeter }) {
  return [...normalizePointer(pointer), ...normalizeScreenGenie(screen), ...normalizeVoltmeter(voltmeter)];
}

export function buildRemediationPlan(failures = []) {
  const grouped = Object.fromEntries(
    FIR_SOURCE_ORDER.map((source) => [source, failures.filter((failure) => failure.source === source)]),
  );
  const activeSource = FIR_SOURCE_ORDER.find((source) => grouped[source].length > 0) || null;
  const activeFailures = activeSource ? grouped[activeSource] : [];
  const deferredFailures = failures.filter((failure) => failure.source !== activeSource);
  const sourceSummary = FIR_SOURCE_ORDER.map((source) => ({
    source,
    status: grouped[source].length === 0 ? "green" : source === activeSource ? "active" : "queued",
    failure_total: grouped[source].length,
    critical_total: grouped[source].filter((item) => String(item.severity).toLowerCase() === "critical").length,
    high_total: grouped[source].filter((item) => String(item.severity).toLowerCase() === "high").length,
  }));

  return {
    active_source: activeSource,
    active_failures: activeFailures,
    deferred_failures: deferredFailures,
    source_summary: sourceSummary,
    pointer_green: grouped.pointer.length === 0,
    screen_green: grouped.screen.length === 0,
    voltmeter_green: grouped.voltmeter.length === 0,
  };
}

export function repairPacketsFromFailures(failures = []) {
  return failures.map((failure) => ({
    failure_id: failure.failure_id,
    source: failure.source,
    lane: failure.lane,
    severity: failure.severity,
    expected: failure.expected,
    observed: failure.observed,
    evidence: failure.evidence || {},
    ownership: failure.ownership || {},
    suggested_strategy: failure.suggested_strategy || {},
    attempt_count: failure.attempt_count || 0,
  }));
}

export function compareFailureSets(previous = [], current = []) {
  const prevIds = new Set(previous.map((item) => item.failure_id));
  const currentIds = new Set(current.map((item) => item.failure_id));
  const resolved = previous.filter((item) => !currentIds.has(item.failure_id));
  const introduced = current.filter((item) => !prevIds.has(item.failure_id));
  if (current.length === 0) {
    return { status: "corrected", delta_summary: "No failures remain.", confidence: 0.96, resolved, introduced };
  }
  if (introduced.some((item) => ["critical", "high"].includes(String(item.severity).toLowerCase()))) {
    return {
      status: "regressed",
      delta_summary: "New high-risk failures were introduced.",
      confidence: 0.83,
      resolved,
      introduced,
    };
  }
  if (resolved.length > 0 && introduced.length === 0) {
    return {
      status: "improved",
      delta_summary: `${resolved.length} failures were resolved and no new failures appeared.`,
      confidence: 0.79,
      resolved,
      introduced,
    };
  }
  return {
    status: "unchanged",
    delta_summary: "The active failure set did not materially improve.",
    confidence: 0.74,
    resolved,
    introduced,
  };
}
