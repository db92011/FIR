function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function validateStep(step = {}, journeyId, index) {
  const errors = [];
  if (!step.action) errors.push(`Journey ${journeyId} step ${index + 1} is missing action.`);
  if (!step.label) errors.push(`Journey ${journeyId} step ${index + 1} is missing label.`);
  return {
    ...step,
    status: errors.length === 0 ? "ready" : "invalid",
    errors,
  };
}

function validateJourney(journey = {}) {
  const errors = [];
  if (!journey.id) errors.push("Journey is missing id.");
  if (!journey.title) errors.push(`Journey ${journey.id || "unknown"} is missing title.`);
  if (!journey.surface) errors.push(`Journey ${journey.id || "unknown"} is missing surface.`);
  if (!journey.runtime) errors.push(`Journey ${journey.id || "unknown"} is missing runtime.`);
  const steps = asArray(journey.steps).map((step, index) => validateStep(step, journey.id || "unknown", index));
  for (const step of steps) {
    errors.push(...step.errors);
  }

  const assertions = {
    ui: asArray(journey.assertions?.ui),
    runtime: asArray(journey.assertions?.runtime),
    persistence: asArray(journey.assertions?.persistence),
    openai: asArray(journey.assertions?.openai),
  };
  const cleanup = {
    mode: journey.cleanup?.mode || "strict",
    actions: asArray(journey.cleanup?.actions),
    verify: asArray(journey.cleanup?.verify),
  };

  return {
    ...journey,
    steps,
    assertions,
    cleanup,
    status: errors.length === 0 ? "ready" : "invalid",
    errors,
    step_count: steps.length,
    assertion_count:
      assertions.ui.length +
      assertions.runtime.length +
      assertions.persistence.length +
      assertions.openai.length,
    cleanup_action_count: cleanup.actions.length,
    cleanup_verify_count: cleanup.verify.length,
  };
}

function selectedIdsFromArgs(args = {}) {
  const raw = String(args.journeys || args.journey || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return new Set(raw);
}

export function buildJourneyPlan({ target = {}, args = {} } = {}) {
  const declared = asArray(target.journeys).map(validateJourney);
  const selectedIds = selectedIdsFromArgs(args);
  const selected = selectedIds.size > 0 ? declared.filter((journey) => selectedIds.has(journey.id)) : declared;
  const missing = selectedIds.size > 0 ? [...selectedIds].filter((id) => !declared.find((journey) => journey.id === id)) : [];
  const invalid = selected.filter((journey) => journey.status !== "ready");
  const coverage = {
    surface_count: new Set(selected.map((journey) => journey.surface).filter(Boolean)).size,
    runtime_count: new Set(selected.map((journey) => journey.runtime).filter(Boolean)).size,
    cleanup_strict_count: selected.filter((journey) => journey.cleanup.mode === "strict").length,
  };

  return {
    target_id: target.id || null,
    status: invalid.length === 0 && missing.length === 0 ? "ready" : "blocked",
    selected_journey_count: selected.length,
    selected_journey_ids: selected.map((journey) => journey.id),
    missing_journey_ids: missing,
    invalid_journey_ids: invalid.map((journey) => journey.id),
    coverage,
    journeys: selected,
  };
}

export function renderJourneySummary(plan = {}) {
  const lines = [];
  lines.push(`Journey status: ${plan.status || "unknown"}`);
  lines.push(`Journeys selected: ${plan.selected_journey_count || 0}`);
  if (plan.selected_journey_ids?.length) {
    lines.push(`Journey ids: ${plan.selected_journey_ids.join(", ")}`);
  }
  if (plan.missing_journey_ids?.length) {
    lines.push(`Missing journey ids: ${plan.missing_journey_ids.join(", ")}`);
  }
  if (plan.invalid_journey_ids?.length) {
    lines.push(`Invalid journey ids: ${plan.invalid_journey_ids.join(", ")}`);
  }
  if (plan.coverage) {
    lines.push(
      `Coverage: ${plan.coverage.surface_count || 0} surfaces, ${plan.coverage.runtime_count || 0} runtimes, ${plan.coverage.cleanup_strict_count || 0} strict cleanup journeys`,
    );
  }
  for (const journey of plan.journeys || []) {
    lines.push("");
    lines.push(`[${journey.id}] ${journey.title}`);
    lines.push(`Surface: ${journey.surface}`);
    lines.push(`Runtime: ${journey.runtime}`);
    lines.push(`Steps: ${journey.step_count}`);
    lines.push(`Assertions: ${journey.assertion_count}`);
    lines.push(`Cleanup: ${journey.cleanup.mode} (${journey.cleanup_action_count} actions, ${journey.cleanup_verify_count} verifies)`);
  }
  return `${lines.join("\n")}\n`;
}
