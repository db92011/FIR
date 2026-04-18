function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function percentile(values = [], fraction = 0.95) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function statusFromStage(stage = {}, thresholds = {}) {
  if (stage.error_count > 0) return "failed";
  if (thresholds.maxErrorRate !== undefined && stage.error_rate > thresholds.maxErrorRate) return "failed";
  if (thresholds.maxP95Ms !== undefined && stage.p95_ms > thresholds.maxP95Ms) return "failed";
  if (thresholds.maxMeanMs !== undefined && stage.mean_ms > thresholds.maxMeanMs) return "failed";
  return "passed";
}

function validateRoute(route = {}, index) {
  const errors = [];
  if (!route.id) errors.push(`Hammer route ${index + 1} is missing id.`);
  if (!route.label) errors.push(`Hammer route ${route.id || index + 1} is missing label.`);
  if (!route.url) errors.push(`Hammer route ${route.id || index + 1} is missing url.`);
  return {
    ...route,
    method: String(route.method || "GET").toUpperCase(),
    headers: route.headers && typeof route.headers === "object" ? route.headers : {},
    body: route.body ?? null,
    expected_statuses: asArray(route.expected_statuses || route.expectedStatuses).map(Number).filter(Number.isFinite),
    errors,
    status: errors.length === 0 ? "ready" : "invalid",
  };
}

export function buildHammerPlan({ target = {}, args = {} } = {}) {
  const raw = target.hammer || {};
  const routes = asArray(raw.routes).map(validateRoute);
  const requestedIds = String(args.hammerRoutes || args.hammerRoute || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const selected = requestedIds.length > 0 ? routes.filter((route) => requestedIds.includes(route.id)) : routes;
  const missingRouteIds = requestedIds.filter((id) => !routes.find((route) => route.id === id));
  const invalidRouteIds = selected.filter((route) => route.status !== "ready").map((route) => route.id);

  const defaultStages = asArray(raw.stages).map((stage, index) => ({
    label: stage.label || `stage_${index + 1}`,
    concurrency: toNumber(stage.concurrency, 1),
    total_requests: toNumber(stage.total_requests ?? stage.totalRequests, toNumber(stage.concurrency, 1)),
    pause_ms: toNumber(stage.pause_ms ?? stage.pauseMs, 0),
  }));

  const stages = defaultStages.length > 0
    ? defaultStages
    : [
        { label: "warmup", concurrency: 10, total_requests: 10, pause_ms: 0 },
        { label: "load", concurrency: 50, total_requests: 50, pause_ms: 0 },
      ];

  const thresholds = {
    maxErrorRate: toNumber(raw.thresholds?.max_error_rate ?? raw.thresholds?.maxErrorRate, 0),
    maxP95Ms: toNumber(raw.thresholds?.max_p95_ms ?? raw.thresholds?.maxP95Ms, 2000),
    maxMeanMs: toNumber(raw.thresholds?.max_mean_ms ?? raw.thresholds?.maxMeanMs, 1200),
  };

  const plan = {
    enabled: raw.enabled !== false,
    mode: raw.mode || "public_live",
    target_id: target.id || null,
    route_count: selected.length,
    selected_route_ids: selected.map((route) => route.id),
    missing_route_ids: missingRouteIds,
    invalid_route_ids: invalidRouteIds,
    stop_on_failure: raw.stop_on_failure !== false,
    cooldown_ms: toNumber(raw.cooldown_ms ?? raw.cooldownMs, 1000),
    thresholds,
    stages,
    routes: selected,
  };

  plan.status =
    !plan.enabled
      ? "disabled"
      : missingRouteIds.length === 0 && invalidRouteIds.length === 0
        ? "ready"
        : "blocked";

  return plan;
}

export function renderHammerSummary(plan = {}, report = null) {
  const lines = [];
  lines.push(`Hammer status: ${plan.status || "unknown"}`);
  lines.push(`Hammer enabled: ${plan.enabled ? "yes" : "no"}`);
  lines.push(`Routes selected: ${plan.route_count || 0}`);
  if (plan.selected_route_ids?.length) lines.push(`Route ids: ${plan.selected_route_ids.join(", ")}`);
  if (plan.missing_route_ids?.length) lines.push(`Missing route ids: ${plan.missing_route_ids.join(", ")}`);
  if (plan.invalid_route_ids?.length) lines.push(`Invalid route ids: ${plan.invalid_route_ids.join(", ")}`);
  lines.push(`Stages: ${(plan.stages || []).map((stage) => `${stage.label}:${stage.concurrency}x${stage.total_requests}`).join(", ") || "none"}`);
  lines.push(`Thresholds: error<=${plan.thresholds?.maxErrorRate ?? "n/a"}, p95<=${plan.thresholds?.maxP95Ms ?? "n/a"}ms, mean<=${plan.thresholds?.maxMeanMs ?? "n/a"}ms`);

  if (report) {
    lines.push("");
    lines.push(`Report verdict: ${report.verdict || "unknown"}`);
    lines.push(`Requests: ${report.summary?.total_requests ?? 0}`);
    lines.push(`Errors: ${report.summary?.error_count ?? 0}`);
    lines.push(`Mean: ${report.summary?.mean_ms ?? 0}ms`);
    lines.push(`P95: ${report.summary?.p95_ms ?? 0}ms`);
  }

  return `${lines.join("\n")}\n`;
}

async function sleep(ms) {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runRouteStage(route = {}, stage = {}, thresholds = {}) {
  const totalRequests = Math.max(1, toNumber(stage.total_requests, stage.concurrency || 1));
  const concurrency = Math.max(1, Math.min(totalRequests, toNumber(stage.concurrency, 1)));
  let started = 0;
  const latencies = [];
  const statuses = {};
  const errors = [];

  async function runOne() {
    while (started < totalRequests) {
      const current = started;
      started += 1;
      const began = Date.now();
      try {
        const response = await fetch(route.url, {
          method: route.method,
          headers: route.headers,
          body: route.body === null || route.body === undefined ? undefined : JSON.stringify(route.body),
        });
        const elapsed = Date.now() - began;
        latencies.push(elapsed);
        statuses[response.status] = (statuses[response.status] || 0) + 1;
        const expected = route.expected_statuses.length === 0 || route.expected_statuses.includes(response.status);
        if (!expected) {
          let bodyPreview = "";
          try {
            bodyPreview = (await response.text()).slice(0, 200);
          } catch {}
          errors.push({
            request_index: current,
            kind: "unexpected_status",
            status: response.status,
            body_preview: bodyPreview,
          });
        } else {
          try {
            await response.arrayBuffer();
          } catch {}
        }
      } catch (error) {
        const elapsed = Date.now() - began;
        latencies.push(elapsed);
        errors.push({
          request_index: current,
          kind: "fetch_error",
          message: error.message || String(error),
        });
      }
      await sleep(stage.pause_ms || 0);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => runOne()));

  const total = latencies.length;
  const mean = total > 0 ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / total) : 0;
  const p95 = Math.round(percentile(latencies, 0.95));
  const errorCount = errors.length;
  const errorRate = total > 0 ? Number((errorCount / total).toFixed(4)) : 0;

  const result = {
    label: stage.label,
    concurrency,
    total_requests: totalRequests,
    completed_requests: total,
    statuses,
    error_count: errorCount,
    error_rate: errorRate,
    mean_ms: mean,
    p95_ms: p95,
    sample_errors: errors.slice(0, 5),
  };
  result.status = statusFromStage(result, thresholds);
  return result;
}

export async function runHammer({ plan = {} } = {}) {
  if (plan.status !== "ready") {
    return {
      verdict: plan.status === "disabled" ? "skipped" : "blocked",
      summary: {
        total_requests: 0,
        error_count: 0,
        mean_ms: 0,
        p95_ms: 0,
      },
      routes: [],
    };
  }

  const routeReports = [];
  let totalRequests = 0;
  let totalErrors = 0;
  let allLatencies = [];

  for (const route of plan.routes || []) {
    const stages = [];
    let stopped = false;
    for (const stage of plan.stages || []) {
      const result = await runRouteStage(route, stage, plan.thresholds);
      stages.push(result);
      totalRequests += result.completed_requests;
      totalErrors += result.error_count;
      allLatencies = allLatencies.concat(
        Array.from({ length: result.completed_requests }, (_, index) => (index === 0 ? result.p95_ms : result.mean_ms)),
      );
      if (plan.stop_on_failure && result.status === "failed") {
        stopped = true;
        break;
      }
      await sleep(plan.cooldown_ms || 0);
    }
    routeReports.push({
      id: route.id,
      label: route.label,
      url: route.url,
      method: route.method,
      expected_statuses: route.expected_statuses,
      stages,
      stopped_early: stopped,
      verdict: stages.every((stage) => stage.status === "passed") ? "passed" : "failed",
    });
    if (plan.stop_on_failure && stopped) break;
  }

  const mean = totalRequests > 0 ? Math.round(allLatencies.reduce((sum, value) => sum + value, 0) / allLatencies.length) : 0;
  const p95 = Math.round(percentile(allLatencies, 0.95));
  const summary = {
    total_requests: totalRequests,
    error_count: totalErrors,
    error_rate: totalRequests > 0 ? Number((totalErrors / totalRequests).toFixed(4)) : 0,
    mean_ms: mean,
    p95_ms: p95,
  };

  const verdict = routeReports.every((route) => route.verdict === "passed") ? "passed" : "failed";
  return {
    executed_at: new Date().toISOString(),
    verdict,
    thresholds: plan.thresholds,
    summary,
    routes: routeReports,
  };
}
