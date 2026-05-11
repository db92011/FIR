# FIR

`FIR` is the orchestration layer above `Pointer`, `ScreenGenie`, `App Tester`, and `Voltmeter`.

It does not replace those tools.
It runs them in sequence, normalizes their outputs, builds a unified failure list, writes repair packets, and keeps a governed correction-loop record for the whole system.
FIR now also supports journey specs so a target can declare Lambda-style click-through contracts with UI, runtime, persistence, OpenAI, and cleanup expectations.

Before the real run starts, FIR now performs a pre-flight pass that checks target reachability and tool-specific access requirements so `Pointer`, `ScreenGenie`, and `Voltmeter` start from a green readiness state whenever possible.
FIR can also own standing local secrets for those runs, so once a token is installed locally, pre-flight can hydrate the correct env file before the tools start.
FIR now also supports a guarded hammer lane for staged public load testing on live apps.
FIR can also run Voltmeter nerve-walk probes when a target declares `voltmeter.nerve_walk`.

## Role

- `Pointer`: boundary truth
- `ScreenGenie`: visual truth
- `App Tester`: app/PWA readiness truth
- `Voltmeter`: execution truth
- `Clog`: code-health truth from Knip
- `FIR`: orchestration truth

## What FIR Does In V1

- runs or reads `Pointer`
- runs or reads `ScreenGenie`
- runs `App Tester` when Pointer/target surface contracts declare an app/PWA surface
- runs or reads `Voltmeter`
- runs a report-only Knip clog audit when a target declares one
- runs Voltmeter nerve-walk probes when a target declares them
- aggregates failures across security, surface, runtime, and doctrine lanes
- writes one FIR artifact bundle under `artifacts/fir/<timestamp>/`
- writes normalized repair packets
- records correction history
- compares the current FIR result to the previous FIR run

The first version keeps correction governance strong and conservative.
It does not silently patch code on its own.

## Commands

Run the default integrity target:

```bash
cd /Users/dannybrooking/Documents/GitHub\ =\ master\ copy/FIR
npm run integrity -- --target workspace-demo
```

Show recent FIR history:

```bash
npm run history
```

Run in fix bookkeeping mode after a deliberate patch:

```bash
node src/cli.mjs --target workspace-demo --loop-mode fix --patch-summary "tighten surface spacing and worker contract"
```

Run pre-flight only:

```bash
  node src/cli.mjs --target hopper111-live --preflight-only
  ```

Run a single journey contract:

```bash
  node src/cli.mjs --target hopper111-live --journey contacts:create-contact
  ```

Run the guarded hammer lane:

```bash
node src/cli.mjs --target finch-live --hammer
node src/cli.mjs --target finch-live --hammer-only
node src/cli.mjs --target finch-live --hammer --hammer-route finch-core
```

Install a standing local secret for a target from a one-off env var handoff:

```bash
POINTER_CF_API_TOKEN=... node src/cli.mjs --target hopper111-live --install-secret POINTER_CF_API_TOKEN --from-env POINTER_CF_API_TOKEN
```

Force the run even if pre-flight is red:

```bash
node src/cli.mjs --target hopper111-live --force-run
```

## Targets

Targets live in `targets/*.json`.

They can describe:

- target type
- entry URL
- flows
- journeys
- hammer routes and staged capacity thresholds
- how to invoke `Pointer`
- how to invoke `ScreenGenie`
- how to invoke `Voltmeter`
- optional Voltmeter nerve-walk probes that trace inputs to outcomes

Journey specs are FIR's first contract for Lambda-style execution. They let a target declare:

- the surface under test
- the live runtime behind it
- the step-by-step click path
- UI, runtime, persistence, and OpenAI assertions
- strict cleanup actions and cleanup verification

Hammer specs are FIR's contract for staged public load testing. They let a target declare:

- the live route under load
- the request method, headers, and body
- expected statuses
- staged concurrency ramps
- latency and error thresholds
- stop-on-failure behavior

Voltmeter nerve-walk specs stimulate runtime nerves and assert that inputs reach outcomes instead of cycling in place. The Hopper111 target traces social, Google, and Bing style inputs through Lucy Core, Cortices Memory Index, and the local review-gated Contact Shell motor, then emits training events into the Voltmeter report. AUORA also requires the `intention outcome wiring` input: every trace must declare its intended outcome, produce a perceived outcome, and match them cleanly before the smoke test goes green.

## App Tester

App Tester is the FIR lane for actual apps and PWAs. Do not enable it for ordinary web interfaces that only need ScreenGenie and Voltmeter coverage. It follows a PWABuilder-style report-card model:

- AIR install integrity: marketing-page installer, install action, platform fallback guidance, and installed icon start URL
- app preview: name, description, start URL, scope, display mode, theme color, icon posture
- manifest readiness: manifest link, valid JSON, name, start URL, app display mode, 192px and 512px icons
- service worker readiness: registration hints, fetchable worker, offline/cache/fetch behavior hints
- security readiness: HTTPS, successful entry/start URLs, no obvious mixed-content subresources
- app shell readiness: viewport, install prompt hints, route scope correctness
- platform posture: iOS app metadata, Apple touch icon, theme color, maskable icon
- social metadata posture: OpenGraph title, description, image, and Twitter/X card metadata

The full App Tester stack contract is:

- `Functional`: Playwright flow packs plus FIR journeys
- `AIR install integrity`: marketing shell install action and installed-icon runtime proof
- `PWA compliance`: FIR App Tester plus Lighthouse/PWABuilder-style rules
- `Platform`: iOS/WebKit and Android/Chromium posture
- `Visual`: ScreenGenie now, BackstopJS/Percy-style regression later
- `Performance`: Hammer/Voltmeter now, Lighthouse/WebPageTest later
- `Social metadata`: App Tester OpenGraph/Twitter checks
- `Runtime observability`: Sentry or equivalent when configured

App Tester can be explicit:

```json
"appTester": {
  "enabled": true,
  "kind": "pwa",
  "url": "https://example.pages.dev/app/",
  "engines": {
    "playwright": false,
    "lighthouse": false,
    "playwright_lighthouse": false,
    "backstop": false,
    "sentry": false,
    "web_page_test": false
  }
}
```

AIR can run the app integrity lane without running the full Pointer, ScreenGenie, Voltmeter, and hammer shape:

```bash
npm run air -- --target sayit-live
```

For install work, the target should point App Tester at the app marketing shell, not the app runtime:

```json
"appTester": {
  "enabled": true,
  "kind": "pwa",
  "url": "https://example.pages.dev/?source=fir&install=1",
  "install_contract": {
    "app_runtime_url": "https://example.pages.dev/app.html?source=pwa",
    "expected_start_url": "https://example.pages.dev/app.html?source=pwa"
  }
}
```

It also auto-runs when the target is declared as `web-pwa`, or when Pointer/target surface contracts mark the flow/tag as `app-surface`, `public-app`, or `pwa`. This keeps the tongue in Pointer: Pointer identifies what kind of surface FIR is touching, while App Tester performs the specialized PWA/package-readiness exam.

High-severity App Tester findings block the app-readiness lane. Medium and low findings are recommendations that improve native app feel and packaging confidence.

The included `workspace-demo` target is a safe starter target that uses:

- a local Linux-only Pointer pass
- the latest ScreenGenie SayIt scene packet run
- the latest Voltmeter Lucy run

## Output

Each run writes:

- `artifacts/fir/<timestamp>/preflight-report.json`
- `artifacts/fir/<timestamp>/journey-plan.json`
- `artifacts/fir/<timestamp>/journey-summary.txt`
- `artifacts/fir/<timestamp>/hammer-plan.json`
- `artifacts/fir/<timestamp>/hammer-report.json`
- `artifacts/fir/<timestamp>/hammer-summary.txt`
- `artifacts/fir/<timestamp>/pointer-report.json`
- `artifacts/fir/<timestamp>/screen-report.json`
- `artifacts/fir/<timestamp>/app-tester-report.json`
- `artifacts/fir/<timestamp>/voltmeter-report.json`
- `artifacts/fir/<timestamp>/clog-report.json`
- `artifacts/fir/<timestamp>/aggregated-failures.json`
- `artifacts/fir/<timestamp>/repair-packets.json`
- `artifacts/fir/<timestamp>/correction-history.json`
- `artifacts/fir/<timestamp>/final-state.json`

FIR also keeps:

- `state/latest-run.json`
- `state/run-index.json`
- `state/corrections/latest.json`

## Governance

FIR enforces:

- max attempts
- duplicate patch blocking through patch fingerprint memory
- improved versus unchanged versus regressed comparison
- stop on ambiguity or ownership conflict markers
- conservative diagnose-first posture

## Pre-flight

FIR resolves the target first, then runs a pre-flight check for each lane.

Pre-flight verifies things like:

- target URL reachability
- Cloudflare or Linux credentials for `Pointer`
- Cloudflare Access credentials or required files for `ScreenGenie`
- runtime env requirements for `Voltmeter`

Targets can declare these under a `preflight` block so the same run can say exactly what is green, what is blocked, and what must be fixed before execution starts.

Targets can also declare `requiredSecrets`.
FIR resolves those from local secure storage first, hydrates the declared install targets, and only then evaluates the regular tool checks.
That keeps `FIR` as the shell for standing local auth without turning it into a cloud vault.

## Journey Contracts

Journey contracts are FIR's bridge from static inspection into real click-through testing.

The initial target-level schema supports:

- `id`
- `title`
- `surface`
- `runtime`
- `flow`
- `steps`
- `assertions.ui`
- `assertions.runtime`
- `assertions.persistence`
- `assertions.openai`
- `cleanup.mode`
- `cleanup.actions`
- `cleanup.verify`
- `hammer.enabled`
- `hammer.routes`
- `hammer.stages`
- `hammer.thresholds`
- `hammer.stop_on_failure`

Every run now writes the selected journey set into the artifact bundle and records journey status in `final-state.json`.
If a requested journey id is missing or invalid, FIR stops that run instead of silently drifting into an incomplete test contract.
If a hammer route is requested and missing, FIR blocks that load run instead of silently falling back to a weaker probe.

Diagnose mode is not treated as a hard stop when failures remain.
If the system still has fixable failures, FIR now stays in an active continuation state such as:

- `improved_not_resolved`
- `unchanged`
- `regressed`

Each run writes:

- `correction_state`
- `should_continue`
- `next_action`

That keeps the loop moving until it reaches a true stop condition instead of prematurely reading every unfinished run as blocked.

## Sequential Remediation

FIR now treats the three tools as a gated queue:

1. `Pointer`
2. `ScreenGenie`
3. `App Tester`
4. `Voltmeter`
5. `Clog`

It does not ask Codex to fix every finding everywhere at once.
Instead it:

- activates the first tool in that order that still has findings
- writes `active_source` and `active-failures.json`
- keeps later-tool findings deferred until the active source is green
- advances to the next tool only after confirmation

Each FIR artifact bundle now includes:

- `active-failures.json`
- `deferred-failures.json`

This keeps remediation from relying on memory and prevents later lanes from stealing focus before the current one is clean.

## Clog Audit

FIR can run Knip as a report-only clog audit for JavaScript and TypeScript workspaces.

Target config:

```json
{
  "clog": {
    "enabled": true,
    "include": "files,dependencies,exports",
    "workspaces": [
      {
        "id": "hopper111-dinnerbell",
        "cwd": "/Users/dannybrooking/Documents/GitHub = master copy/Hopper111/Dinner-Bell"
      }
    ]
  }
}
```

Clog findings are deliberately conservative. FIR reports them as code-health failures, but it does not remove files, exports, or dependencies automatically.
Review each finding, mark runtime entrypoints in `knip.json` when needed, and remove only clearly dead code.

## Doctrine

Full Integrity Run is not just a test bundle.

It is a system-level closed-loop integrity pass that should answer:

- is the boundary safe?
- does the runtime tell the truth?
- does the UI tell the truth?
- did the latest fix improve the overall system?
