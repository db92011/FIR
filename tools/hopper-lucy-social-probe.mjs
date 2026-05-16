const dashboardUrl = "https://hopper111-dashboard.pages.dev/social-engine";
const workerHealthUrl = "https://hopper111.com/api/social/health";
const workerIntelligenceUrl = "https://hopper111.com/api/social/intelligence";

function absoluteAssetUrl(value = "") {
  try {
    return new URL(value, dashboardUrl).toString();
  } catch {
    return "";
  }
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, { redirect: "manual", ...options });
  return {
    status: response.status,
    text: await response.text().catch(() => ""),
  };
}

const dash = await fetchText(dashboardUrl);
const api = await fetch(workerHealthUrl, { redirect: "manual" });
const intel = await fetch(workerIntelligenceUrl, { redirect: "manual" });
const assetUrls = [
  ...dash.text.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi),
  ...dash.text.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi),
]
  .map((match) => absoluteAssetUrl(match[1]))
  .filter(Boolean);

const assetTexts = await Promise.all(
  assetUrls.map(async (url) => {
    try {
      return (await fetchText(url)).text;
    } catch {
      return "";
    }
  })
);

const body = [dash.text, ...assetTexts].join("\n");
const dashboardHasLucySocial = /Lucy Social|Social Intelligence|Narrative Memory/i.test(body);
const internalDistributionContractPresent =
  /internal distribution|social feed|queue entries|Publish Selected|Auto Schedule Selected|Trend-Aligned Calendar|posting queue/i.test(body) ||
  (/Lucy Social/i.test(body) && /schedule|queue|publish/i.test(body));
const workerProtected = [302, 401, 403].includes(api.status);
const intelligenceProtected = [302, 401, 403].includes(intel.status);

console.log(
  JSON.stringify(
    {
      ok:
        dash.status === 200 &&
        workerProtected &&
        intelligenceProtected &&
        dashboardHasLucySocial &&
        internalDistributionContractPresent,
      dashboard_status: dash.status,
      api_status: api.status,
      intelligence_status: intel.status,
      asset_urls: assetUrls,
      dashboard_has_lucy_social: dashboardHasLucySocial,
      internal_distribution_contract_present: internalDistributionContractPresent,
      worker_protected: workerProtected,
      intelligence_protected: intelligenceProtected,
    },
    null,
    2
  )
);
