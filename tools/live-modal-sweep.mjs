import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "../../ScreenGenie/node_modules/playwright/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(rootDir, "..");
const artifactRoot = path.join(rootDir, "artifacts", "modal-sweep");

const liveTargets = [
  "sayit-live",
  "finch-live"
];

const openerPattern =
  /(modal|dialog|drawer|sheet|menu|settings|account|login|sign in|subscribe|upgrade|plus|trial|start|open|teleprompter|install|paywall|device|manage)/i;

function nowStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function readTarget(id) {
  const file = path.join(rootDir, "targets", `${id}.json`);
  const target = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    id: target.id,
    type: target.type || "",
    entry: target.entry || "",
    flows: target.flows || [],
    modalChecker: target.modalChecker || target.appTester?.modalChecker || null
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function visibleModalSignals(page) {
  return page.evaluate(() => {
    const selectors = [
      "[role='dialog']",
      "[aria-modal='true']",
      "[popover]",
      "[class*='modal' i]",
      "[id*='modal' i]",
      "[class*='overlay' i]",
      "[id*='overlay' i]",
      "[class*='drawer' i]",
      "[id*='drawer' i]",
      "[class*='sheet' i]",
      "[id*='sheet' i]"
    ];

    const seen = new Set();
    const matches = [];
    for (const node of document.querySelectorAll(selectors.join(","))) {
      if (seen.has(node)) continue;
      seen.add(node);
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const visible =
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || "1") > 0.01 &&
        rect.width > 8 &&
        rect.height > 8;
      if (!visible) continue;
      matches.push({
        tag: node.tagName.toLowerCase(),
        id: node.id || "",
        className: String(node.className || ""),
        role: node.getAttribute("role") || "",
        ariaModal: node.getAttribute("aria-modal") || "",
        zIndex: style.zIndex,
        position: style.position,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      });
    }

    const htmlStyle = window.getComputedStyle(document.documentElement);
    const bodyStyle = window.getComputedStyle(document.body);
    return {
      count: matches.length,
      matches,
      scrollLocked:
        ["hidden", "clip"].includes(bodyStyle.overflowY) ||
        ["hidden", "clip"].includes(htmlStyle.overflowY) ||
        document.body.classList.contains("modal-open"),
      activeElement: {
        tag: document.activeElement?.tagName?.toLowerCase() || "",
        id: document.activeElement?.id || "",
        text: String(document.activeElement?.textContent || "").trim().slice(0, 80)
      }
    };
  });
}

async function closeVisibleModal(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(150).catch(() => {});
  const stillOpen = await visibleModalSignals(page).catch(() => ({ count: 0 }));
  if (stillOpen.count === 0) return { closed: true, method: "escape" };

  const closeSelectors = [
    "[aria-label*='close' i]",
    "[data-close-modal]",
    "[data-action*='close' i]",
    "button:has-text('Close')",
    "button:has-text('Cancel')",
    "button:has-text('Done')",
    "button:has-text('Back')"
  ];
  for (const selector of closeSelectors) {
    const locator = page.locator(selector);
    if ((await locator.count().catch(() => 0)) < 1) continue;
    await locator.first().click({ timeout: 1000 }).catch(() => {});
    await page.waitForTimeout(150).catch(() => {});
    const next = await visibleModalSignals(page).catch(() => ({ count: 0 }));
    if (next.count === 0) return { closed: true, method: selector };
  }

  return { closed: false, method: "" };
}

async function installStandaloneEmulation(context) {
  await context.addInitScript(() => {
    try {
      Object.defineProperty(window.navigator, "standalone", {
        configurable: true,
        get() {
          return true;
        }
      });
    } catch (error) {}

    const nativeMatchMedia = window.matchMedia?.bind(window);
    window.matchMedia = (query) => {
      const text = String(query || "");
      if (/\(\s*display-mode\s*:\s*standalone\s*\)/i.test(text)) {
        return {
          matches: true,
          media: text,
          onchange: null,
          addListener() {},
          removeListener() {},
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent() {
            return false;
          }
        };
      }
      return nativeMatchMedia ? nativeMatchMedia(query) : {
        matches: false,
        media: text,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {
          return false;
        }
      };
    };
  });
}

async function runModalContract(page, contract) {
  const attempt = {
    contract: contract.id || contract.name || contract.dialog || "modal",
    opener: contract.open || null,
    initial: Boolean(contract.initial),
    beforeSignals: await visibleModalSignals(page),
    afterSignals: null,
    focusInside: false,
    focusTrap: false,
    escapeClosed: false,
    closeSelectorClosed: false,
    focusReturned: false,
    findings: []
  };

  const openerSelector = contract.open;
  const dialogSelector = contract.dialog || "[role='dialog']";
  const closeSelector = contract.close;
  let openerHadFocus = false;

  if (openerSelector) {
    const opener = page.locator(openerSelector).first();
    await opener.focus({ timeout: 3000 }).catch(() => {});
    openerHadFocus = await opener.evaluate((node) => document.activeElement === node).catch(() => false);
    await opener.click({ timeout: 5000 });
    await page.waitForTimeout(contract.wait_ms || 350);
  }

  const dialog = page.locator(dialogSelector).first();
  const visible = await dialog.isVisible({ timeout: contract.initial ? 5000 : 3000 }).catch(() => false);
  attempt.afterSignals = await visibleModalSignals(page);

  if (!visible) {
    attempt.findings.push({
      severity: "high",
      id: "contract_modal_not_visible",
      observed: `Expected ${dialogSelector} to be visible.`
    });
    return attempt;
  }

  if (contract.expect_scroll_lock !== false && !attempt.afterSignals.scrollLocked) {
    attempt.findings.push({
      severity: "medium",
      id: "modal_scroll_not_locked",
      observed: "Modal opened, but body/html scroll did not appear locked."
    });
  }

  attempt.focusInside = await dialog.evaluate((node) => node.contains(document.activeElement)).catch(() => false);
  if (contract.expect_focus_inside !== false && !attempt.focusInside) {
    attempt.findings.push({
      severity: "medium",
      id: "modal_focus_not_inside",
      observed: "Focus was not inside the modal after open."
    });
  }

  if (contract.expect_focus_trap !== false) {
    attempt.focusTrap = await dialog.evaluate((node) => {
      const selector = [
        "a[href]",
        "button:not([disabled])",
        "input:not([disabled])",
        "select:not([disabled])",
        "textarea:not([disabled])",
        "[tabindex]:not([tabindex='-1'])"
      ].join(",");
      const focusable = Array.from(node.querySelectorAll(selector)).filter((item) => {
        const rect = item.getBoundingClientRect();
        const style = window.getComputedStyle(item);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      });
      if (focusable.length < 2) return true;
      focusable[focusable.length - 1].focus();
      return document.activeElement === focusable[focusable.length - 1];
    }).catch(() => false);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(100);
    const trapped = await dialog.evaluate((node) => node.contains(document.activeElement)).catch(() => false);
    attempt.focusTrap = attempt.focusTrap && trapped;
    if (!attempt.focusTrap) {
      attempt.findings.push({
        severity: "medium",
        id: "modal_focus_trap_failed",
        observed: "Tab focus escaped the modal boundary."
      });
    }
  }

  if (contract.expect_escape_close !== false) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    attempt.escapeClosed = !(await dialog.isVisible().catch(() => false));
    if (!attempt.escapeClosed) {
      attempt.findings.push({
        severity: "medium",
        id: "escape_did_not_close_modal",
        observed: "Escape did not close the modal."
      });
    }
  }

  if (!attempt.escapeClosed && closeSelector) {
    await page.locator(closeSelector).first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(250);
    attempt.closeSelectorClosed = !(await dialog.isVisible().catch(() => false));
    if (!attempt.closeSelectorClosed) {
      attempt.findings.push({
        severity: "high",
        id: "close_selector_did_not_close_modal",
        observed: `${closeSelector} did not close ${dialogSelector}.`
      });
    }
  }

  if (openerHadFocus && openerSelector && (attempt.escapeClosed || attempt.closeSelectorClosed)) {
    attempt.focusReturned = await page.locator(openerSelector).first()
      .evaluate((node) => document.activeElement === node)
      .catch(() => false);
    if (contract.expect_focus_return !== false && !attempt.focusReturned) {
      attempt.findings.push({
        severity: "medium",
        id: "modal_focus_not_returned",
        observed: "Focus did not return to the opener after close."
      });
    }
  }

  return attempt;
}

async function findOpeners(page) {
  return page.evaluate((patternSource) => {
    const pattern = new RegExp(patternSource, "i");
    const cssPath = (node) => {
      if (node.id) return `#${CSS.escape(node.id)}`;
      const parts = [];
      let current = node;
      while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
        const tag = current.tagName.toLowerCase();
        const parent = current.parentElement;
        if (!parent) break;
        const siblings = Array.from(parent.children).filter((item) => item.tagName === current.tagName);
        const index = siblings.indexOf(current) + 1;
        parts.unshift(`${tag}:nth-of-type(${index})`);
        current = parent;
      }
      return parts.length ? `body > ${parts.join(" > ")}` : "";
    };
    const nodes = Array.from(
      document.querySelectorAll(
        [
          "[data-open-modal]",
          "[data-modal-open]",
          "[aria-haspopup='dialog']",
          "[aria-controls]",
          "button",
          "a[role='button']",
          "[role='button']"
        ].join(",")
      )
    );

    const seen = new Set();
    const candidates = [];
    for (const node of nodes) {
      if (seen.has(node)) continue;
      seen.add(node);
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      const text = String(node.innerText || node.textContent || node.getAttribute("aria-label") || "").trim();
      const href = node.getAttribute("href") || "";
      const selector =
        node.id ? `#${CSS.escape(node.id)}` :
          node.getAttribute("data-open-modal") ? `[data-open-modal="${CSS.escape(node.getAttribute("data-open-modal"))}"]` :
            node.getAttribute("aria-controls") ? `[aria-controls="${CSS.escape(node.getAttribute("aria-controls"))}"]` :
              cssPath(node);
      const visible =
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 8 &&
        rect.height > 8;
      const safeHref = !href || href === "#" || href.startsWith("#") || href.startsWith("javascript:");
      if (!visible || !selector || !safeHref) continue;
      if (!pattern.test(`${text} ${selector} ${node.className || ""}`)) continue;
      candidates.push({
        selector,
        text: text.slice(0, 80),
        href,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      });
    }
    return candidates.slice(0, 10);
  }, openerPattern.source);
}

async function sweepViewport(browser, target, viewportName, contextOptions = {}) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    ...contextOptions
  });
  if (target.modalChecker?.emulate_standalone) {
    await installStandaloneEmulation(context);
  }
  const page = await context.newPage();
  const result = {
    viewport: viewportName,
    status: "unknown",
    url: target.entry,
    finalUrl: "",
    pageTitle: "",
    initialModalSignals: null,
    openers: [],
    attempts: [],
    findings: []
  };

  try {
    const response = await page.goto(target.entry, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    result.finalUrl = page.url();
    result.pageTitle = await page.title();
    result.httpStatus = response?.status() || 0;

    if (result.httpStatus >= 400) {
      result.findings.push({
        severity: "high",
        id: "entry_http_error",
        observed: `Entry returned HTTP ${result.httpStatus}.`
      });
    }

    result.initialModalSignals = await visibleModalSignals(page);
    const modalContracts = Array.isArray(target.modalChecker?.modals) ? target.modalChecker.modals : [];
    if (modalContracts.length > 0) {
      result.contractAttempts = [];
      for (const contract of modalContracts) {
        const attempt = await runModalContract(page, contract);
        result.contractAttempts.push(attempt);
        result.findings.push(...attempt.findings);
        if (attempt.findings.some((finding) => finding.severity === "high")) break;
        if (!contract.initial && contract.reopen_page_after !== false) {
          await page.goto(target.entry, { waitUntil: "domcontentloaded", timeout: 12000 }).catch(() => {});
          await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
        }
      }
      result.status = result.findings.some((finding) => finding.severity === "high")
        ? "failed"
        : result.findings.length > 0 ? "warnings" : "passed";
      return result;
    }

    result.openers = await findOpeners(page);

    if (result.openers.length === 0 && result.initialModalSignals.count === 0) {
      result.findings.push({
        severity: "medium",
        id: "no_modal_contract_or_discovered_openers",
        observed: "No visible modal openers or initial dialog/overlay signals were found.",
        expected: "Live app targets should declare modal contracts or expose testable modal openers."
      });
    }

    for (const opener of result.openers.slice(0, 5)) {
      const attempt = {
        opener,
        beforeUrl: page.url(),
        afterUrl: "",
        opened: false,
        beforeSignals: await visibleModalSignals(page),
        afterSignals: null,
        escapeSignals: null,
        notes: []
      };

      try {
        await page.locator(opener.selector).click({ timeout: 4000 });
        await page.waitForTimeout(450);
        attempt.afterUrl = page.url();
        attempt.afterSignals = await visibleModalSignals(page);
        attempt.opened = attempt.afterSignals.count > attempt.beforeSignals.count || attempt.afterSignals.count > 0;

        if (attempt.afterUrl !== attempt.beforeUrl) {
          attempt.notes.push("Click changed URL; treating as navigation, not modal.");
          await page.goBack({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(250);
        } else if (attempt.opened) {
          if (!attempt.afterSignals.scrollLocked) {
            result.findings.push({
              severity: "medium",
              id: "modal_scroll_not_locked",
              opener: opener.text || opener.selector,
              observed: "A modal-like layer opened but body/html scroll did not appear locked."
            });
          }
          await page.keyboard.press("Escape");
          await page.waitForTimeout(250);
          attempt.escapeSignals = await visibleModalSignals(page);
          if (attempt.escapeSignals.count >= attempt.afterSignals.count) {
            result.findings.push({
              severity: "medium",
              id: "escape_did_not_close_modal",
              opener: opener.text || opener.selector,
              observed: "Escape did not reduce visible modal/overlay count."
            });
          }
          const closeState = await closeVisibleModal(page);
          attempt.closeState = closeState;
          if (!closeState.closed) {
            attempt.notes.push("Modal remained open after Escape and close-selector recovery.");
            await page.goto(target.entry, { waitUntil: "domcontentloaded", timeout: 12000 }).catch(() => {});
            await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
          }
        } else {
          attempt.notes.push("Click did not open a detectable modal layer.");
        }
      } catch (error) {
        attempt.error = error instanceof Error ? error.message : String(error);
        if (/Execution context was destroyed|navigation|net::ERR_ABORTED/i.test(attempt.error)) {
          attempt.notes.push("Click navigated or replaced the page context; treating as non-modal navigation.");
          await page.goto(target.entry, { waitUntil: "domcontentloaded", timeout: 12000 }).catch(() => {});
          await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
        } else {
          result.findings.push({
            severity: "high",
            id: "opener_click_failed",
            opener: opener.text || opener.selector,
            observed: attempt.error
          });
        }
      }
      result.attempts.push(attempt);
    }

    result.status = result.findings.some((finding) => finding.severity === "high")
      ? "failed"
      : result.findings.length > 0 ? "warnings" : "passed";
  } catch (error) {
    result.status = "failed";
    result.error = error instanceof Error ? error.message : String(error);
    result.findings.push({
      severity: "high",
      id: "navigation_failed",
      observed: result.error
    });
  } finally {
    await context.close();
  }

  return result;
}

async function main() {
  const timestamp = nowStamp();
  const runDir = path.join(artifactRoot, timestamp);
  const targets = liveTargets.map(readTarget).filter((target) => target.entry && !target.entry.includes("/api/"));
  const browser = await chromium.launch({ headless: true });
  const report = {
    run_id: `modal_sweep_${timestamp}`,
    generated_at: new Date().toISOString(),
    tool: "fir_live_modal_sweep_v1",
    workspace_root: workspaceRoot,
    target_count: targets.length,
    targets: []
  };

  for (const target of targets) {
    const targetReport = {
      ...target,
      sweeps: []
    };
    targetReport.sweeps.push(await sweepViewport(browser, target, "desktop", { viewport: { width: 1280, height: 820 } }));
    targetReport.sweeps.push(await sweepViewport(browser, target, "mobile", { ...devices["iPhone 14"] }));
    targetReport.status = targetReport.sweeps.some((sweep) => sweep.status === "failed")
      ? "failed"
      : targetReport.sweeps.some((sweep) => sweep.status === "warnings") ? "warnings" : "passed";
    report.targets.push(targetReport);
  }

  await browser.close();

  report.summary = {
    passed: report.targets.filter((target) => target.status === "passed").length,
    warnings: report.targets.filter((target) => target.status === "warnings").length,
    failed: report.targets.filter((target) => target.status === "failed").length,
    finding_total: report.targets.flatMap((target) => target.sweeps.flatMap((sweep) => sweep.findings)).length
  };

  writeJson(path.join(runDir, "modal-sweep-report.json"), report);
  writeJson(path.join(artifactRoot, "latest.json"), {
    run_id: report.run_id,
    generated_at: report.generated_at,
    report_path: path.join(runDir, "modal-sweep-report.json"),
    summary: report.summary
  });

  console.log(`Modal sweep: ${report.run_id}`);
  console.log(`Report: ${path.join(runDir, "modal-sweep-report.json")}`);
  console.log(JSON.stringify(report.summary, null, 2));
  for (const target of report.targets) {
    const findings = target.sweeps.flatMap((sweep) => sweep.findings.map((finding) => `${sweep.viewport}:${finding.id}`));
    console.log(`- ${target.id}: ${target.status}${findings.length ? ` (${findings.join(", ")})` : ""}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
