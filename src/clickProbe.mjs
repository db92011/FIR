import { chromium } from "playwright";

function text(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
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

function urlMatchesRuntime(url = "", runtimeUrls = []) {
  return runtimeUrls.filter(Boolean).some((runtimeUrl) => sameUrlOrPath(url, runtimeUrl));
}

function defaultSelectors() {
  return [
    "[data-install-action]",
    "#installAction",
    "#nativeInstallButton",
    "[data-ctp-install-trigger]",
    "[data-pwa-install]",
    "[data-install]",
  ];
}

function defaultRoleCandidates() {
  const name = /install|add to home|add to dock|get app|download/i;
  return [
    { role: "button", name },
    { role: "link", name },
  ];
}

async function elementMeta(locator, selector = "") {
  return locator.evaluate((element, selectorArg) => {
    const rect = element.getBoundingClientRect();
    return {
      selector: selectorArg,
      tag: element.tagName.toLowerCase(),
      id: element.id || null,
      classes: element.className ? String(element.className).slice(0, 200) : null,
      text: (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 240),
      href: element.href || element.getAttribute("href") || null,
      download: element.getAttribute("download") || null,
      aria_label: element.getAttribute("aria-label") || null,
      role: element.getAttribute("role") || null,
      rect: {
        x: Number(rect.x.toFixed(1)),
        y: Number(rect.y.toFixed(1)),
        width: Number(rect.width.toFixed(1)),
        height: Number(rect.height.toFixed(1)),
      },
    };
  }, selector);
}

async function findClickTarget(page, selectors = []) {
  for (const selector of selectors) {
    try {
      const matches = page.locator(selector);
      const count = Math.min(await matches.count(), 10);
      for (let index = 0; index < count; index += 1) {
        const locator = matches.nth(index);
        if (await locator.isVisible().catch(() => false)) {
          return {
            locator,
            strategy: "selector",
            selector,
            visible: true,
            meta: await elementMeta(locator, selector).catch(() => ({ selector })),
          };
        }
      }
    } catch {
      // Ignore invalid optional selectors and keep looking.
    }
  }

  for (const candidate of defaultRoleCandidates()) {
    try {
      const matches = page.getByRole(candidate.role, { name: candidate.name });
      const count = Math.min(await matches.count(), 10);
      for (let index = 0; index < count; index += 1) {
        const locator = matches.nth(index);
        if (await locator.isVisible().catch(() => false)) {
          return {
            locator,
            strategy: "role",
            selector: `${candidate.role}:${candidate.name}`,
            visible: true,
            meta: await elementMeta(locator, `${candidate.role}:${candidate.name}`).catch(() => ({})),
          };
        }
      }
    } catch {
      // Role lookup can fail on unusual markup; selector lookup already covered the normal path.
    }
  }

  return null;
}

async function bodyText(page) {
  return page.locator("body").innerText({ timeout: 1500 }).catch(() => "");
}

function hasManualInstallGuidance(value = "") {
  return /add to home screen|add to dock|install this site as an app|browser install control|install icon|share button|chrome menu|edge menu|safari/i.test(value);
}

function extensionFrom(value = "") {
  const clean = String(value).split(/[?#]/)[0].toLowerCase();
  const match = clean.match(/\.([a-z0-9]+)$/i);
  return match ? `.${match[1]}` : "";
}

function classifyDownload(download = {}) {
  const ext = extensionFrom(download.suggested_filename) || extensionFrom(download.url);
  if ([".html", ".htm", ".xhtml"].includes(ext)) return "web_page";
  if ([".dmg", ".pkg", ".exe", ".msi", ".apk", ".ipa", ".appx", ".deb", ".rpm"].includes(ext)) return "native_package";
  if ([".zip", ".tar", ".gz", ".tgz"].includes(ext)) return "archive";
  if (ext) return "file";
  return "unknown_file";
}

function downloadAllowed(download = {}, config = {}) {
  if (config.allow_download !== true && config.allowDownload !== true) return false;
  const extensions = asArray(config.expected_download_extensions || config.expectedDownloadExtensions)
    .map((item) => String(item).trim().toLowerCase())
    .filter(Boolean)
    .map((item) => item.startsWith(".") ? item : `.${item}`);
  if (!extensions.length) return true;
  const ext = extensionFrom(download.suggested_filename) || extensionFrom(download.url);
  return extensions.includes(ext);
}

function resultStatus(outcome = "") {
  return ["pwa_install_prompt", "manual_install_guidance", "allowed_download"].includes(outcome) ? "passed" : "failed";
}

export async function runInstallClickProbe({
  url,
  expectedStartUrl = "",
  appRuntimeUrl = "",
  config = {},
} = {}) {
  if (config.enabled === false) {
    return {
      enabled: false,
      status: "skipped",
      reason: "Install click probe disabled for this target.",
    };
  }

  const timeoutMs = Number(config.timeout_ms || config.timeoutMs || 15000);
  const clickTimeoutMs = Number(config.click_timeout_ms || config.clickTimeoutMs || 5000);
  const settleMs = Number(config.settle_ms || config.settleMs || 1200);
  const selectors = [
    ...asArray(config.selectors),
    ...asArray(config.click_selectors || config.clickSelectors),
    ...defaultSelectors(),
  ];
  const runtimeUrls = [expectedStartUrl, appRuntimeUrl].filter(Boolean);
  const desiredResult = config.allow_download === true || config.allowDownload === true
    ? "Only the declared app package download is acceptable."
    : "No file download. The click should trigger PWA install or platform install guidance.";

  let browser;
  try {
    browser = await chromium.launch({ headless: config.headed === true ? false : true });
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: Number(config.width || 1280), height: Number(config.height || 900) },
    });
    const page = await context.newPage();
    const dialogs = [];
    page.on("dialog", async (dialog) => {
      dialogs.push({ type: dialog.type(), message: dialog.message() });
      await dialog.dismiss().catch(() => {});
    });
    await page.addInitScript(() => {
      window.__AIR_CLICK_PROBE__ = {
        beforeinstallprompt: false,
        prompt_called: false,
        appinstalled: false,
      };
      window.addEventListener("beforeinstallprompt", (event) => {
        window.__AIR_CLICK_PROBE__.beforeinstallprompt = true;
        const originalPrompt = typeof event.prompt === "function" ? event.prompt.bind(event) : null;
        if (!originalPrompt) return;
        try {
          Object.defineProperty(event, "prompt", {
            configurable: true,
            value: async () => {
              window.__AIR_CLICK_PROBE__.prompt_called = true;
              return originalPrompt();
            },
          });
        } catch {
          window.__AIR_CLICK_PROBE__.prompt_wrapped = false;
        }
      }, true);
      window.addEventListener("appinstalled", () => {
        window.__AIR_CLICK_PROBE__.appinstalled = true;
      });
    });

    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    const beforeUrl = page.url();
    const target = await findClickTarget(page, selectors);
    const beforeText = await bodyText(page);

    if (!target) {
      return {
        enabled: true,
        status: "failed",
        outcome: "no_visible_click_target",
        desired_result: desiredResult,
        entry_url: url,
        final_url: beforeUrl,
        response_status: response?.status() || null,
        target: { visible: false },
        clicked: false,
      };
    }

    const downloadPromise = page.waitForEvent("download", { timeout: clickTimeoutMs })
      .then((download) => ({
        url: download.url(),
        suggested_filename: download.suggestedFilename(),
      }))
      .catch(() => null);
    const popupPromise = page.waitForEvent("popup", { timeout: clickTimeoutMs })
      .then(async (popup) => {
        await popup.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
        return { url: popup.url() };
      })
      .catch(() => null);

    await target.locator.click({ timeout: clickTimeoutMs });
    await page.waitForTimeout(settleMs);

    const [downloadEvent, popup] = await Promise.all([downloadPromise, popupPromise]);
    const afterUrl = page.url();
    const afterText = await bodyText(page);
    const promptState = await page.evaluate(() => window.__AIR_CLICK_PROBE__ || {}).catch(() => ({}));
    const manualGuidanceVisible = hasManualInstallGuidance(afterText);
    const navigated = !sameUrlOrPath(afterUrl, beforeUrl);
    const openedAppRuntime = urlMatchesRuntime(afterUrl, runtimeUrls);
    const popupOpenedAppRuntime = popup?.url ? urlMatchesRuntime(popup.url, runtimeUrls) : false;
    const download = downloadEvent
      ? {
          ...downloadEvent,
          kind: classifyDownload(downloadEvent),
          allowed: downloadAllowed(downloadEvent, config),
        }
      : null;

    let outcome = "no_confirmed_install_result";
    if (download) {
      outcome = download.allowed ? "allowed_download" : "unexpected_download";
    } else if (promptState.prompt_called || promptState.beforeinstallprompt || promptState.appinstalled) {
      outcome = "pwa_install_prompt";
    } else if (manualGuidanceVisible) {
      outcome = "manual_install_guidance";
    } else if (openedAppRuntime) {
      outcome = "app_runtime_navigation";
    } else if (popupOpenedAppRuntime) {
      outcome = "popup_app_runtime_navigation";
    } else if (popup?.url) {
      outcome = "popup_other";
    } else if (navigated) {
      outcome = "navigation_other";
    }

    return {
      enabled: true,
      status: resultStatus(outcome),
      outcome,
      desired_result: desiredResult,
      entry_url: url,
      before_url: beforeUrl,
      after_url: afterUrl,
      expected_runtime_urls: runtimeUrls,
      response_status: response?.status() || null,
      target: {
        visible: true,
        strategy: target.strategy,
        selector: target.selector,
        meta: target.meta,
      },
      clicked: true,
      prompt_state: promptState,
      manual_guidance_visible: manualGuidanceVisible,
      body_text_changed: beforeText !== afterText,
      download,
      popup,
      dialogs,
    };
  } catch (error) {
    return {
      enabled: true,
      status: "failed",
      outcome: "probe_error",
      desired_result: desiredResult,
      entry_url: url,
      expected_runtime_urls: runtimeUrls,
      error: error.message || String(error),
      clicked: false,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function exactUrl(actual = "", expected = "") {
  try {
    return new URL(actual).href === new URL(expected).href;
  } catch {
    return actual === expected;
  }
}

async function findHandoffTarget(page, step = {}) {
  if (step.selector) {
    const locator = page.locator(step.selector).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  if (step.name) {
    const role = step.role || "link";
    const locator = page.getByRole(role, { name: step.exact === false ? new RegExp(step.name, "i") : step.name }).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  if (step.text) {
    const locator = page.getByText(step.exact === false ? new RegExp(step.text, "i") : step.text).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

export async function runUrlHandoffProbe(config = {}) {
  if (config.enabled === false || !config.start_url && !config.startUrl) {
    return {
      enabled: false,
      status: "skipped",
      reason: "No URL handoff contract configured.",
    };
  }

  const startUrl = config.start_url || config.startUrl;
  const steps = asArray(config.steps);
  const timeoutMs = Number(config.timeout_ms || config.timeoutMs || 15000);
  let browser;
  try {
    browser = await chromium.launch({ headless: config.headed === true ? false : true });
    const page = await browser.newPage({
      viewport: { width: Number(config.width || 1280), height: Number(config.height || 900) },
    });
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});

    const results = [];
    for (const step of steps) {
      const beforeUrl = page.url();
      const locator = await findHandoffTarget(page, step);
      if (!locator) {
        results.push({
          label: step.label || step.name || step.selector || "handoff_step",
          status: "failed",
          reason: "click_target_not_visible",
          before_url: beforeUrl,
          expected_url: step.expected_url || step.expectedUrl || null,
        });
        continue;
      }

      const targetMeta = await elementMeta(locator, step.selector || step.name || step.text || "").catch(() => ({}));
      await Promise.all([
        page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {}),
        locator.click({ timeout: 5000 }),
      ]);
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      const afterUrl = page.url();
      const expectedUrl = step.expected_url || step.expectedUrl || "";
      results.push({
        label: step.label || step.name || step.selector || "handoff_step",
        status: expectedUrl ? (exactUrl(afterUrl, expectedUrl) ? "passed" : "failed") : "passed",
        before_url: beforeUrl,
        after_url: afterUrl,
        expected_url: expectedUrl || null,
        target: targetMeta,
      });
    }

    return {
      enabled: true,
      status: results.every((result) => result.status === "passed") ? "passed" : "failed",
      start_url: startUrl,
      final_url: page.url(),
      steps: results,
    };
  } catch (error) {
    return {
      enabled: true,
      status: "failed",
      start_url: startUrl,
      error: error.message || String(error),
      steps: [],
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

export async function runRuntimeRenderProbe({
  url,
  config = {},
} = {}) {
  if (config.enabled === false || !url) {
    return {
      enabled: false,
      status: "skipped",
      reason: url ? "Runtime render probe disabled for this target." : "No runtime URL configured.",
    };
  }

  const timeoutMs = Number(config.timeout_ms || config.timeoutMs || 15000);
  const settleMs = Number(config.settle_ms || config.settleMs || 2500);
  const minBodyTextLength = Number(config.min_body_text_length || config.minBodyTextLength || 20);
  let browser;
  try {
    browser = await chromium.launch({ headless: config.headed === true ? false : true });
    const page = await browser.newPage({
      viewport: { width: Number(config.width || 1280), height: Number(config.height || 900) },
    });
    const logs = [];
    const failedRequests = [];
    page.on("console", (message) => {
      logs.push({ type: message.type(), text: message.text() });
    });
    page.on("pageerror", (error) => {
      logs.push({ type: "pageerror", text: error.message || String(error) });
    });
    page.on("requestfailed", (request) => {
      failedRequests.push({
        url: request.url(),
        failure: request.failure()?.errorText || "request failed",
      });
    });

    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(settleMs);

    const bodyText = await bodyTextProbe(page);
    const rootHtmlLength = await page.locator("#root").evaluate((element) => element.innerHTML.length).catch(() => null);
    const title = await page.title().catch(() => "");
    const blockingErrors = logs.filter((entry) =>
      entry.type === "pageerror" ||
      /mime type|failed to load module script|refused to apply style|uncaught|referenceerror|syntaxerror|typeerror/i.test(entry.text)
    );
    const rendered = bodyText.trim().length >= minBodyTextLength || Number(rootHtmlLength || 0) > 50;

    return {
      enabled: true,
      status: response?.ok() && rendered && blockingErrors.length === 0 ? "passed" : "failed",
      url,
      final_url: page.url(),
      response_status: response?.status() || null,
      title,
      rendered,
      body_text_length: bodyText.trim().length,
      body_text_sample: bodyText.trim().slice(0, 500),
      root_html_length: rootHtmlLength,
      blocking_errors: blockingErrors,
      logs: logs.slice(0, 25),
      failed_requests: failedRequests.slice(0, 25),
    };
  } catch (error) {
    return {
      enabled: true,
      status: "failed",
      url,
      error: error.message || String(error),
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function bodyTextProbe(page) {
  return page.locator("body").innerText({ timeout: 1500 }).catch(() => "");
}
