function text(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function absoluteUrl(value = "", base = "") {
  try {
    return new URL(value, base).toString();
  } catch {
    return "";
  }
}

function check(id, label, pass, severity = "high", detail = "", evidence = {}) {
  return {
    id,
    label,
    pass: pass === true,
    severity,
    detail,
    evidence,
  };
}

async function fetchText(url, { timeoutMs = 20000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "FIR-AppTester/1.0",
        accept: "text/html,application/json,*/*",
        ...headers,
      },
      signal: controller.signal,
      redirect: "follow",
    });
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    };
  } finally {
    clearTimeout(timer);
  }
}

function findManifestUrl(html = "", baseUrl = "") {
  const match = html.match(/<link\b[^>]*rel=["'][^"']*\bmanifest\b[^"']*["'][^>]*>/i);
  if (!match) return "";
  const href = match[0].match(/\bhref=["']([^"']+)["']/i)?.[1];
  return href ? absoluteUrl(href, baseUrl) : "";
}

function findServiceWorkerHints(html = "", baseUrl = "") {
  const hints = [];
  const registerMatches = html.matchAll(/serviceWorker\s*\.\s*register\s*\(\s*["'`]([^"'`]+)["'`]/gi);
  for (const match of registerMatches) hints.push(absoluteUrl(match[1], baseUrl));
  for (const candidate of ["/sw.js", "/service-worker.js", "/serviceworker.js"]) {
    const url = absoluteUrl(candidate, baseUrl);
    if (html.includes(candidate) && !hints.includes(url)) hints.push(url);
  }
  return hints.filter(Boolean);
}

function findScriptUrls(html = "", baseUrl = "") {
  const urls = [];
  const matches = html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi);
  for (const match of matches) {
    const url = absoluteUrl(match[1], baseUrl);
    if (url) urls.push(url);
  }
  return [...new Set(urls)];
}

function hasAnyPattern(value = "", patterns = []) {
  return patterns.some((pattern) => {
    if (pattern instanceof RegExp) return pattern.test(value);
    return value.toLowerCase().includes(String(pattern).toLowerCase());
  });
}

function sameUrlOrPath(actual = "", expected = "") {
  if (!actual || !expected) return false;
  try {
    const actualUrl = new URL(actual);
    const expectedUrl = new URL(expected);
    if (actualUrl.href === expectedUrl.href) return true;
    return actualUrl.origin === expectedUrl.origin && actualUrl.pathname.replace(/\/$/, "") === expectedUrl.pathname.replace(/\/$/, "");
  } catch {
    return actual === expected;
  }
}

function pathLooksLegacyInstall(url = "") {
  try {
    return /\/(?:install|download)(?:\/|$)/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function iconSizeSet(manifest = {}) {
  const sizes = new Set();
  for (const icon of asArray(manifest.icons)) {
    for (const size of String(icon.sizes || "").split(/\s+/).filter(Boolean)) sizes.add(size.toLowerCase());
  }
  return sizes;
}

function hasIconAtLeast(manifest = {}, size) {
  const sizes = iconSizeSet(manifest);
  if (sizes.has(`${size}x${size}`)) return true;
  for (const item of sizes) {
    const [w, h] = item.split("x").map((part) => Number.parseInt(part, 10));
    if (Number.isFinite(w) && Number.isFinite(h) && w >= size && h >= size) return true;
  }
  return false;
}

function displayReady(manifest = {}) {
  const display = text(manifest.display).toLowerCase();
  const overrides = asArray(manifest.display_override).map((item) => text(item).toLowerCase());
  return ["standalone", "fullscreen", "minimal-ui", "window-controls-overlay"].includes(display) ||
    overrides.some((item) => ["standalone", "fullscreen", "minimal-ui", "window-controls-overlay"].includes(item));
}

function mixedContentHints(html = "") {
  return [...html.matchAll(/\b(?:src|href)=["'](http:\/\/[^"']+)["']/gi)].map((match) => match[1]).slice(0, 20);
}

function metaContent(html = "", selector = "") {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<meta\\b(?=[^>]*(?:name|property)=["']${escaped}["'])[^>]*content=["']([^"']*)["'][^>]*>`, "i");
  return text(html.match(pattern)?.[1]);
}

function hasLinkRel(html = "", rel = "") {
  const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<link\\b(?=[^>]*rel=["'][^"']*\\b${escaped}\\b[^"']*["'])[^>]*>`, "i").test(html);
}

function urlWithinScope(url = "", scope = "") {
  if (!url || !scope) return false;
  try {
    return new URL(url).href.startsWith(new URL(scope).href);
  } catch {
    return false;
  }
}

function scoreChecks(checks = []) {
  if (!checks.length) return 0;
  return Number((checks.filter((item) => item.pass).length / checks.length).toFixed(3));
}

function stackStatus(requiredFailures = [], recommendedFailures = []) {
  if (requiredFailures.length > 0) return "blocked";
  if (recommendedFailures.length > 0) return "recommendations";
  return "green";
}

function buildIntegrityStack({ checks, requiredFailures, recommendedFailures, config = {} }) {
  const engineConfig = config.engines || {};
  return {
    name: "application_integrity_run",
    status: stackStatus(requiredFailures, recommendedFailures),
    external_engines: {
      playwright: engineConfig.playwright ? "configured" : "available_contract_not_configured",
      lighthouse: engineConfig.lighthouse ? "configured" : "available_contract_not_configured",
      playwright_lighthouse: engineConfig.playwright_lighthouse || engineConfig.playwrightLighthouse ? "configured" : "available_contract_not_configured",
      backstop: engineConfig.backstop || engineConfig.backstopjs ? "configured" : "available_contract_not_configured",
      sentry: engineConfig.sentry ? "configured" : "available_contract_not_configured",
      web_page_test: engineConfig.web_page_test || engineConfig.webPageTest ? "configured" : "available_contract_not_configured",
    },
    layers: [
      {
        id: "functional_integrity",
        owned_by: "Playwright flow packs + FIR journeys",
        current_signal: "delegated",
        purpose: "navigation, touch, auth, broken flows, standalone launch behavior",
      },
      {
        id: "install_integrity",
        owned_by: "FIR AIR",
        current_signal: scoreChecks(checks.install_shell || []),
        purpose: "marketing-page install action, native prompt/manual install fallback, and installed icon start URL",
      },
      {
        id: "pwa_compliance",
        owned_by: "FIR App Tester + Lighthouse/PWABuilder-style rules",
        current_signal: scoreChecks([...(checks.manifest || []), ...(checks.service_worker || []), ...(checks.security || [])]),
        purpose: "installability, manifest, service worker, HTTPS, start URL, route scope",
      },
      {
        id: "platform_integrity",
        owned_by: "FIR App Tester + Playwright WebKit/Chromium profiles",
        current_signal: scoreChecks(checks.platform || []),
        purpose: "iOS metadata, Android icon posture, standalone mode, viewport correctness",
      },
      {
        id: "visual_integrity",
        owned_by: "ScreenGenie today, BackstopJS/Percy-style comparison later",
        current_signal: "delegated",
        purpose: "layout drift, responsive breakage, emotional polish, screenshot regression",
      },
      {
        id: "performance_integrity",
        owned_by: "Hammer/Voltmeter today, Lighthouse/WebPageTest later",
        current_signal: "delegated",
        purpose: "startup behavior, latency, cache posture, weak-device readiness",
      },
      {
        id: "social_metadata_integrity",
        owned_by: "FIR App Tester",
        current_signal: scoreChecks(checks.social_metadata || []),
        purpose: "OpenGraph/Twitter metadata and share-card correctness",
      },
      {
        id: "runtime_observability",
        owned_by: "Sentry or equivalent when configured",
        current_signal: engineConfig.sentry ? "configured" : "not_configured",
        purpose: "production crashes, browser-specific errors, mobile runtime weirdness",
      },
    ],
  };
}

export async function runAppTester(config = {}) {
  if (!config?.enabled) {
    return {
      enabled: false,
      status: "skipped",
      reason: "appTester is not enabled for this target.",
    };
  }

  const url = text(config.url || config.entry || config.start_url || config.startUrl);
  const kind = text(config.kind || config.target_kind || config.targetKind, "pwa");
  if (!url) {
    return {
      enabled: true,
      status: "failed",
      kind,
      url,
      checks: [check("entry_url", "App Tester needs an app/PWA URL.", false, "high")],
      findings: [],
    };
  }

  const timeoutMs = Number(config.timeout_ms || config.timeoutMs || 20000);
  const htmlResult = await fetchText(url, { timeoutMs, headers: config.headers || {} });
  const finalUrl = htmlResult.url || url;
  const explicitScriptUrls = asArray(config.script_urls || config.scriptUrls).map((item) => absoluteUrl(item, finalUrl));
  const scriptUrls = [...new Set([...explicitScriptUrls, ...findScriptUrls(htmlResult.body, finalUrl)])].filter(Boolean);
  const scriptResults = [];
  for (const scriptUrl of scriptUrls.slice(0, 10)) {
    try {
      scriptResults.push({ url: scriptUrl, ...(await fetchText(scriptUrl, { timeoutMs, headers: { accept: "application/javascript,*/*" } })) });
    } catch (error) {
      scriptResults.push({ url: scriptUrl, ok: false, status: 0, error: error.message, body: "" });
    }
  }
  const scriptSource = scriptResults.map((result) => result.body || "").join("\n");
  const combinedSource = `${htmlResult.body}\n${scriptSource}`;
  const manifestUrl = text(config.manifest_url || config.manifestUrl || findManifestUrl(htmlResult.body, finalUrl));
  const swHints = findServiceWorkerHints(combinedSource, finalUrl);
  let manifest = null;
  let manifestResult = null;
  if (manifestUrl) {
    try {
      manifestResult = await fetchText(manifestUrl, { timeoutMs, headers: { accept: "application/manifest+json,application/json,*/*" } });
      try {
        manifest = JSON.parse(manifestResult.body);
      } catch {
        manifest = null;
      }
    } catch (error) {
      manifestResult = { ok: false, status: 0, error: error.message, body: "" };
      manifest = null;
    }
  }
  const startUrl = manifest ? absoluteUrl(manifest.start_url || ".", manifestUrl || finalUrl) : "";
  const scopeUrl = manifest ? absoluteUrl(manifest.scope || ".", manifestUrl || finalUrl) : "";
  let startResult = null;
  if (startUrl) {
    try {
      startResult = await fetchText(startUrl, { timeoutMs, headers: config.headers || {} });
    } catch (error) {
      startResult = { ok: false, status: 0, error: error.message, url: startUrl, body: "" };
    }
  }
  const explicitSwUrls = asArray(config.service_worker_urls || config.serviceWorkerUrls).map((item) => absoluteUrl(item, finalUrl));
  const swUrls = [...new Set([...explicitSwUrls, ...swHints])].filter(Boolean);
  const swResults = [];
  for (const swUrl of swUrls.slice(0, 4)) {
    try {
      swResults.push({ url: swUrl, ...(await fetchText(swUrl, { timeoutMs, headers: { accept: "application/javascript,*/*" } })) });
    } catch (error) {
      swResults.push({ url: swUrl, ok: false, status: 0, error: error.message });
    }
  }

  const mixed = mixedContentHints(htmlResult.body);
  const installContract = config.install_contract || config.installContract || {};
  const expectedStartUrl = absoluteUrl(
    installContract.expected_start_url || installContract.expectedStartUrl || installContract.app_runtime_url || installContract.appRuntimeUrl || "",
    finalUrl
  );
  const appRuntimeUrl = absoluteUrl(installContract.app_runtime_url || installContract.appRuntimeUrl || expectedStartUrl || "", finalUrl);
  const installActionPatterns = [
    /\bdata-install-action\b/i,
    /\bid=["']installAction["']/i,
    /\bid=["']nativeInstallButton["']/i,
    /\bdata-[a-z0-9-]*install[a-z0-9-]*\b/i,
    ...(asArray(installContract.install_action_patterns || installContract.installActionPatterns).map((pattern) => new RegExp(pattern, "i"))),
  ];
  const manualInstallPatterns = [
    /add to home screen/i,
    /add to dock/i,
    /install icon/i,
    /browser install control/i,
    /install this site as an app/i,
  ];
  const hasInstallAction = hasAnyPattern(combinedSource, installActionPatterns);
  const hasNativePromptHandler = /beforeinstallprompt/i.test(combinedSource);
  const hasManualInstallFallback = hasAnyPattern(combinedSource, manualInstallPatterns);
  const desktopIconStartsApp = Boolean(startUrl) &&
    !sameUrlOrPath(startUrl, finalUrl) &&
    (!expectedStartUrl || sameUrlOrPath(startUrl, expectedStartUrl));
  const installShellChecks = [
    check(
      "install_shell_marketing_entry",
      "AIR entry is the app marketing shell, not a legacy install/download route.",
      !pathLooksLegacyInstall(finalUrl),
      "high",
      finalUrl
    ),
    check(
      "install_shell_action_present",
      "Marketing shell exposes an install action instead of only an open-app link.",
      hasInstallAction,
      "high",
      hasInstallAction ? "Install action marker found." : "No install action marker found."
    ),
    check(
      "install_shell_prompt_or_manual_fallback",
      "Install action can trigger a native install prompt or platform-specific install guidance.",
      hasNativePromptHandler || hasManualInstallFallback,
      "high",
      `beforeinstallprompt=${hasNativePromptHandler}; manual_steps=${hasManualInstallFallback}`
    ),
    check(
      "desktop_icon_start_url",
      "Installed desktop/Home Screen icon opens the app runtime, not the marketing page.",
      desktopIconStartsApp,
      "high",
      `entry=${finalUrl}; start_url=${startUrl || "missing"}; expected=${expectedStartUrl || appRuntimeUrl || "configured-by-manifest"}`
    ),
    check(
      "install_source_script_fetch",
      "AIR can inspect the install shell JavaScript.",
      scriptResults.length === 0 || scriptResults.some((result) => result.ok),
      "medium",
      scriptResults.map((result) => `${result.url}:${result.status || 0}`).join(", ") || "No external scripts."
    ),
  ];
  const manifestChecks = [
    check("manifest_link", "HTML links to a web app manifest.", Boolean(manifestUrl), "high", manifestUrl || "No manifest link found."),
    check("manifest_fetch", "Manifest is fetchable and valid JSON.", Boolean(manifest), "high", manifestResult ? (manifestResult.error || `HTTP ${manifestResult.status}`) : "No manifest fetched."),
    check("manifest_name", "Manifest has name or short_name.", Boolean(text(manifest?.name || manifest?.short_name)), "high"),
    check("manifest_start_url", "Manifest has a start_url.", Boolean(text(manifest?.start_url)), "high"),
    check("manifest_display", "Manifest launches like an app.", displayReady(manifest || {}), "high", `display=${manifest?.display || ""}`),
    check("manifest_192_icon", "Manifest has a 192px icon.", hasIconAtLeast(manifest || {}, 192), "high"),
    check("manifest_512_icon", "Manifest has a 512px icon.", hasIconAtLeast(manifest || {}, 512), "high"),
    check("manifest_related_apps", "Manifest does not prefer related native apps.", manifest?.prefer_related_applications !== true, "high"),
    check("manifest_theme_color", "Manifest declares theme_color.", Boolean(text(manifest?.theme_color)), "medium"),
    check("manifest_background_color", "Manifest declares background_color.", Boolean(text(manifest?.background_color)), "medium"),
    check("manifest_description", "Manifest includes a description.", Boolean(text(manifest?.description)), "medium"),
    check("manifest_screenshots", "Manifest includes screenshots for richer install prompts.", asArray(manifest?.screenshots).length > 0, "low"),
  ];
  const serviceWorkerChecks = [
    check("service_worker_registration", "App registers a service worker or declares one for testing.", swUrls.length > 0, "high"),
    check(
      "service_worker_fetchable",
      "At least one service worker URL is fetchable.",
      swResults.some((result) => result.ok),
      "high",
      swResults.map((result) => `${result.url}:${result.status || 0}`).join(", ") || "No service worker URL found."
    ),
    check(
      "offline_handler_hint",
      "Service worker appears to handle fetch/offline/cache behavior.",
      swResults.some((result) => /\b(fetch|caches|cache|workbox|offline)\b/i.test(result.body || "")),
      "medium"
    ),
  ];
  const securityChecks = [
    check("https", "App is served over HTTPS or localhost.", /^https:\/\//i.test(finalUrl) || /^http:\/\/(localhost|127\.0\.0\.1)/i.test(finalUrl), "high", finalUrl),
    check("html_ok", "Entry URL returns a successful response.", htmlResult.ok, "high", `HTTP ${htmlResult.status}`),
    check("start_url_ok", "Manifest start_url returns a successful response.", startResult ? startResult.ok : false, "high", startResult ? (startResult.error || `HTTP ${startResult.status}`) : "No start_url."),
    check("no_mixed_content", "Entry HTML does not reference insecure http:// subresources.", mixed.length === 0, "high", mixed.length ? `${mixed.length} mixed-content hints.` : ""),
  ];
  const appExperienceChecks = [
    check("viewport", "Entry page has a viewport meta tag.", /<meta\b[^>]*name=["']viewport["']/i.test(htmlResult.body), "medium"),
    check("install_prompt_hint", "Entry has install prompt or app-install language.", /beforeinstallprompt|install app|add to home|pwa-install/i.test(combinedSource), "low"),
    check("scope_present", "Manifest defines or implies scope.", Boolean(scopeUrl), "medium", scopeUrl),
    check("route_scope", "Manifest start_url is inside the declared app scope.", urlWithinScope(startUrl, scopeUrl), "high", `start_url=${startUrl} scope=${scopeUrl}`),
  ];
  const platformChecks = [
    check("apple_capable", "Entry includes iOS app-capable metadata.", /apple-mobile-web-app-capable/i.test(htmlResult.body), "low"),
    check("apple_touch_icon", "Entry includes an Apple touch icon.", hasLinkRel(htmlResult.body, "apple-touch-icon"), "low"),
    check("theme_color_meta", "Entry includes browser theme-color metadata.", Boolean(metaContent(htmlResult.body, "theme-color") || text(manifest?.theme_color)), "medium"),
    check("maskable_icon", "Manifest includes at least one maskable icon for Android surfaces.", asArray(manifest?.icons).some((icon) => String(icon.purpose || "").includes("maskable")), "low"),
  ];
  const socialMetadataChecks = [
    check("og_title", "Entry includes OpenGraph title.", Boolean(metaContent(htmlResult.body, "og:title")), "medium"),
    check("og_description", "Entry includes OpenGraph description.", Boolean(metaContent(htmlResult.body, "og:description")), "medium"),
    check("og_image", "Entry includes OpenGraph image.", Boolean(metaContent(htmlResult.body, "og:image")), "medium"),
    check("twitter_card", "Entry includes Twitter/X card metadata.", Boolean(metaContent(htmlResult.body, "twitter:card")), "low"),
  ];
  const checks = {
    install_shell: installShellChecks,
    manifest: manifestChecks,
    service_worker: serviceWorkerChecks,
    security: securityChecks,
    app_experience: appExperienceChecks,
    platform: platformChecks,
    social_metadata: socialMetadataChecks,
  };
  const allChecks = Object.values(checks).flat();
  const requiredFailures = allChecks.filter((item) => !item.pass && item.severity === "high");
  const recommendedFailures = allChecks.filter((item) => !item.pass && item.severity !== "high");
  const score = Number((
    scoreChecks(installShellChecks) * 0.25 +
    scoreChecks(manifestChecks) * 0.22 +
    scoreChecks(serviceWorkerChecks) * 0.18 +
    scoreChecks(securityChecks) * 0.15 +
    scoreChecks(appExperienceChecks) * 0.08 +
    scoreChecks(platformChecks) * 0.07 +
    scoreChecks(socialMetadataChecks) * 0.05
  ).toFixed(3));
  const integrityStack = buildIntegrityStack({ checks, requiredFailures, recommendedFailures, config });

  return {
    enabled: true,
    runner: "fir_app_tester",
    version: "air-pwa-install-report-card-v2",
    kind,
    url,
    final_url: finalUrl,
    status: requiredFailures.length === 0 ? "passed" : "failed",
    score,
    package_readiness: {
      status: requiredFailures.length === 0
        ? recommendedFailures.length === 0 ? "store_ready" : "packageable_with_recommendations"
        : "blocked",
      required_blockers: requiredFailures.length,
      recommended_items: recommendedFailures.length,
    },
    integrity_stack: integrityStack,
    app_preview: {
      name: manifest?.name || manifest?.short_name || null,
      short_name: manifest?.short_name || null,
      description: manifest?.description || null,
      start_url: startUrl || null,
      scope: scopeUrl || null,
      display: manifest?.display || null,
      theme_color: manifest?.theme_color || null,
      background_color: manifest?.background_color || null,
      manifest_url: manifestUrl || null,
      service_worker_urls: swUrls,
      script_urls: scriptUrls,
    },
    application_integrity_run: {
      acronym: "AIR",
      status: requiredFailures.length === 0 ? "passed" : "failed",
      install_entry_url: finalUrl,
      expected_app_runtime_url: expectedStartUrl || appRuntimeUrl || null,
      installed_icon_start_url: startUrl || null,
      safety_rule:
        "The marketing page must install the PWA or show platform install steps; the installed icon must open the app runtime.",
    },
    checks,
    findings: [...requiredFailures, ...recommendedFailures],
  };
}
