import path from "node:path";
import { readJson, writeJson, hashStable } from "../utils.mjs";
import { compareFailureSets, FIR_SOURCE_ORDER } from "../normalize.mjs";

const DEFAULT_MAX_ATTEMPTS = 5;
const HARD_STOP_STATES = new Set([
  "corrected",
  "max_attempts_reached",
  "blocked_requires_human",
  "blocked_ownership_conflict",
  "blocked_truth_ambiguity",
]);

function patchFingerprint({ patchFingerprint = "", patchSummary = "", patchFiles = [] } = {}) {
  if (patchFingerprint) return patchFingerprint;
  return `patch_${hashStable({ summary: patchSummary, files: patchFiles })}`;
}

function sourceIndex(source) {
  return Math.max(FIR_SOURCE_ORDER.indexOf(source), -1);
}

function normalizeLoopState({ comparisonStatus, failures, attemptCount, maxAttempts, duplicatePatch }) {
  if (failures.length === 0) return "corrected";
  if (attemptCount >= maxAttempts) return "max_attempts_reached";
  if (duplicatePatch) return "blocked_truth_ambiguity";
  if (comparisonStatus === "advanced") return "source_cleared_advance";
  if (comparisonStatus === "improved") return "improved_not_resolved";
  if (comparisonStatus === "regressed") return "regressed";
  if (comparisonStatus === "corrected") return "corrected";
  return "unchanged";
}

function nextActionForState({ state, mode, activeSource, nextSource }) {
  if (state === "corrected") return "complete";
  if (state === "max_attempts_reached") return "stop_max_attempts";
  if (state === "blocked_truth_ambiguity") return "review_truth_ambiguity";
  if (state === "blocked_requires_human") return "human_intervention_required";
  if (state === "blocked_ownership_conflict") return "resolve_ownership_conflict";
  if (state === "source_cleared_advance") return nextSource ? `advance_to_${nextSource}` : "complete";
  if (state === "regressed") return mode === "fix" ? "review_or_rollback_then_continue" : "tighten_diagnosis";
  if (state === "improved_not_resolved") return mode === "fix" ? `rerun_${activeSource}_after_patch` : `codex_fix_${activeSource}`;
  return mode === "fix" ? `prepare_next_${activeSource}_patch` : `codex_fix_${activeSource}`;
}

function compareStage({ previousSession, activeSource, activeFailures, allFailures }) {
  if (!previousSession) {
    return compareFailureSets([], activeFailures);
  }

  const previousActiveSource = previousSession.active_source || null;
  const previousActiveFailures = previousSession.active_failures || previousSession.failures || [];

  if (previousActiveSource && activeSource && previousActiveSource !== activeSource) {
    if (sourceIndex(activeSource) > sourceIndex(previousActiveSource)) {
      return {
        status: "advanced",
        delta_summary: `${previousActiveSource} is green. Advance to ${activeSource}.`,
        confidence: 0.94,
        resolved: previousActiveFailures,
        introduced: activeFailures,
      };
    }
  }

  if (previousActiveSource && !activeSource && allFailures.length === 0) {
    return {
      status: "corrected",
      delta_summary: `${previousActiveSource} is green and no failures remain.`,
      confidence: 0.97,
      resolved: previousActiveFailures,
      introduced: [],
    };
  }

  return compareFailureSets(previousActiveFailures, activeFailures);
}

export function runCorrectionLoop({
  rootDir,
  runId,
  target,
  failures,
  remediationPlan,
  args = {},
}) {
  const correctionsDir = path.join(rootDir, "state", "corrections");
  const latestPath = path.join(correctionsDir, "latest.json");
  const previous = readJson(latestPath, null);
  const activeSource = remediationPlan?.active_source || null;
  const activeFailures = remediationPlan?.active_failures || failures;
  const comparison = compareStage({
    previousSession: previous,
    activeSource,
    activeFailures,
    allFailures: failures,
  });
  const mode = String(args.loopMode || "diagnose");
  const attemptCount = Number(previous?.attempt_count || 0) + (mode === "fix" ? 1 : 0);
  const maxAttempts = Number(target.max_attempts || DEFAULT_MAX_ATTEMPTS);
  const fingerprint = patchFingerprint({
    patchFingerprint: args.patchFingerprint,
    patchSummary: args.patchSummary,
    patchFiles: String(args.patchFiles || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  });

  const duplicatePatch =
    mode === "fix" && previous?.last_patch_fingerprint && previous.last_patch_fingerprint === fingerprint;
  const state = normalizeLoopState({
    comparisonStatus: comparison.status,
    failures: activeFailures,
    attemptCount,
    maxAttempts,
    duplicatePatch,
  });
  const nextSource = remediationPlan?.source_summary?.find((item) => item.status === "queued")?.source || null;
  const shouldContinue = failures.length > 0 && !HARD_STOP_STATES.has(state);
  const nextAction = nextActionForState({ state, mode, activeSource, nextSource });

  const history = [...(previous?.history || [])];
  history.push({
    run_id: runId,
    mode,
    active_source: activeSource,
    active_failure_total: activeFailures.length,
    state,
    should_continue: shouldContinue,
    next_action: nextAction,
    comparison,
    patch_summary: args.patchSummary || null,
    patch_files: String(args.patchFiles || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    patch_fingerprint: mode === "fix" ? fingerprint : null,
    recorded_at: new Date().toISOString(),
  });

  const session = {
    run_id: runId,
    target_id: target.id,
    attempt_count: attemptCount,
    max_attempts: maxAttempts,
    active_source: activeSource,
    active_failures: activeFailures,
    deferred_failures: remediationPlan?.deferred_failures || [],
    source_summary: remediationPlan?.source_summary || [],
    state,
    loop_mode: mode,
    comparison,
    should_continue: shouldContinue,
    next_action: nextAction,
    failures,
    history,
    last_patch_fingerprint: mode === "fix" ? fingerprint : previous?.last_patch_fingerprint || null,
  };

  writeJson(latestPath, session);
  return session;
}
