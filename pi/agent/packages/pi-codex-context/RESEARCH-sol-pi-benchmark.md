# SoL-Pi benchmark reproducibility and a minimal Pi A/B protocol

Research date: 2026-09-16 UTC

## Conclusions

| Question | Finding |
|---|---|
| Does `NVlabs/SoL-Pi` publish the long-running evaluation behind its claims? | **Not as a reproducible SoL-Pi experiment.** The website identifies EdgeBench and publishes aggregate charts. The SoL-Pi repository publishes the extension and credential-free tests, but no evaluation runner, Pi/SForge adapter, task manifest, frozen image/task identifiers, experiment configuration, trajectories, per-task records, or raw cost ledger. EdgeBench separately publishes SForge and 51 public tasks, so the benchmark family is public; the exact SoL-Pi run is not. |
| Can that exact experiment be run on stock Pi 0.85.1? | **No, not from the published artifacts.** Current SForge has built-in Claude Code, Codex, and OpenCode agents, but no Pi agent. It requires source changes to add and register one. The missing SoL-Pi protocol and raw run provenance remain blockers even after doing that. |
| Can it be run on Pi plus only local `pi-codex-context`? | **No, for the same reasons.** Pi can load exactly that extension with `--no-extensions -e ...`, but the result would be a new Pi-vs-`pi-codex-context` experiment, not a reproduction of Pi-vs-SoL-Pi. The local extension is also a dirty, uncommitted implementation and is not the four-mechanism SoL-Pi extension. |
| Smallest runnable A/B now | One frozen repair task, one fresh stock session and one fresh treatment session: **2 agent runs**. The exact protocol below is a plumbing/cost smoke test, not evidence for the long-horizon claim. Use at least 3 pairs (6 runs) for debugging and 5 or more pairs (10 or more runs) before describing stochastic behavior. |

No billable inference calls were made during this research.

## Source snapshots and scope

The findings are pinned to these snapshots rather than moving branches:

- SoL-Pi `main`: `2b791687a489a1d24da816cf1634d8ae1d36befd`, 2026-09-15.
- SoL-Pi `gh-pages`: `f6dcd699f59dc2c5ff55ba448485a235f80ab76e`, 2026-09-15.
- Pi `v0.85.1`: `d981de1229ef899957bbe968bc8dcda02a21f477`, 2026-09-05.
- EdgeBench/SForge `main`: `668c7d4564c0f32d126c6c3b0f2828bc24a380ce`, 2026-09-10; package version `1.1.0`.
- Local repository HEAD: `40b31ffab02e470db16e1fc3111f0f293701efbc`. The local extension files are modified relative to this commit; hashes are recorded below.
- OpenRouter catalog retrieved from `GET https://openrouter.ai/api/v1/models` at `2026-09-16T10:56:25Z`.

“Exact” means the same task instances and versions, work/judge images, prompts, stop/resume/evaluation policy, harness versions, model routes and reasoning settings, SoL-Pi configuration, resource limits, run ordering/repetitions, and scoring/cost rules. Matching only the benchmark name is not exact reproduction.

## What SoL-Pi actually publishes

### Published claims

The static project site says:

- EdgeBench is a 51-task held-out suite with trajectories lasting roughly 2 to 12 hours.
- Both evaluated model backends ran at `xhigh`.
- The EdgeBench charts contain these aggregate values:

| Backend | Harness | Average score | API-equivalent cost | Total tokens |
|---|---:|---:|---:|---:|
| GPT-5.6 Sol | Codex | 34.74 | $1,787 | 3.05B |
| GPT-5.6 Sol | Pi | 44.83 | $1,339 | 2.15B |
| GPT-5.6 Sol | SoL-Pi | 42.00 | $894 | 1.10B |
| Claude Opus 5 | Claude Code | 43.69 | $2,535 | 2.00B |
| Claude Opus 5 | Pi | 44.76 | $1,741 | 2.37B |
| Claude Opus 5 | SoL-Pi | 42.22 | $1,158 | 1.31B |

- Its ObservationPack discussion describes a separate paired EdgeBench experiment as 11 tasks x 2 concurrent arms and reports only deltas: provider bill -23.58%, cost/response -23.73%, normalized score +22.92%.
- The Terminal-Bench 4 chart reports 63 CPU-only tasks: Codex 18/63 at $272.35, Pi 18/63 at $286.45, and SoL-Pi 15/63 at $211.12.
- The paper is still marked “Coming soon.”

These are aggregate publication artifacts, not raw evaluation records.

### Repository audit

At the pinned SoL-Pi commit, `main` has 65 tracked files. They are extension source, configuration/install documentation, package metadata, unit/integration tests, and compatibility scripts. The tests use fake or scripted providers; for example, `tests/online-context-compact-agent-session.test.ts` uses Pi's `fauxProvider`, while `tests/sol-pi-regression-stress.test.ts` uses an injected fake completion function and `.invalid` URLs. They do not execute the claimed task suite.

An all-ref and all-reachable-history filename scan found only one benchmark-like source artifact, on `gh-pages`:

- `figures/plot_terminal_bench_web.py`

That script says its numbers are copied from the existing 63-task evaluation and that it does not recalculate prices or results. The other result artifacts are static SVGs. There is no tracked benchmark runner, task manifest, experiment YAML, Pi agent adapter, trajectory bundle, raw result table, or cost ledger.

Re-run the source audit:

```bash
set -euo pipefail
SOL=/tmp/sol-pi-source-audit
rm -rf "$SOL"
git clone --filter=blob:none https://github.com/NVlabs/SoL-Pi.git "$SOL"
git -C "$SOL" rev-parse main origin/gh-pages
git -C "$SOL" ls-tree -r --name-only main | tee /tmp/sol-pi-main-files.txt | wc -l

for ref in $(git -C "$SOL" for-each-ref --format='%(refname)'); do
  git -C "$SOL" ls-tree -r --name-only "$ref" |
    grep -Ei '(^|/)(bench(mark)?|eval(uation)?|result|results|trajector(y|ies)|experiment|experiments|figure|figures|plot)(/|\.|-|_)' |
    sed "s#^#$ref #" || true
done | sort -u

git -C "$SOL" log --all --format='%H' | while read -r commit; do
  git -C "$SOL" ls-tree -r --name-only "$commit"
done | sort -u |
  grep -Ei '(^|/)(bench(mark)?|eval(uation)?|result|results|trajector(y|ies)|experiment|experiments|figure|figures|plot)(/|\.|-|_)' || true
```

This establishes what is present in the official Git history. It cannot establish what NVIDIA may retain privately.

### EdgeBench is public, but it does not close the gap

The separate ByteDance EdgeBench repository now publishes:

- SForge 1.1.0, a two-container work/judge harness.
- 51 public tasks out of 134 total tasks.
- Hidden judge images, iterative `sforge-submit` evaluation, stop hooks, auto-resume, Docker/Kubernetes/E2B backends, and final-result files.
- Official 51-task Kubernetes YAMLs with 12 hours/task, 30-minute automatic evaluation, submission cooldowns, and CPU/memory limits.
- A warning that one frontier-model 12-hour task may cost hundreds to over $1,000 and that a roughly 50-task run is a five-figure experiment.

This is sufficient to run the current official EdgeBench setup with a supported agent. It is not sufficient to recreate NVIDIA's runs because:

1. `sforge/harness/agent/factory.py` registers only `claude-code`, two Codex versions, and `opencode`. There is no `pi` entry.
2. SForge has no out-of-tree runtime agent plugin. Its own documentation requires adding an `Agent` subclass under `sforge/harness/agent/` and changing the registry.
3. SoL-Pi does not publish which EdgeBench task/image snapshot produced its charts, its Pi adapter and install command, enhanced prompt, stop/resume behavior, exact SoL-Pi JSON, model routing, or run records.
4. The site's 11-task ObservationPack experiment does not identify its 11 task IDs.
5. The current official SForge YAML demonstrates a Claude Code plus DeepSeek V4 Pro setup. It is not NVIDIA's Pi/SoL-Pi setup and does not mention `deepseek/deepseek-v4.1-flash`.

A current official full-suite comparison would be 51 tasks x 2 arms = **102 task-runs**, up to **1,224 task-hours** at 12 hours per arm/task. That would still be a new experiment unless the missing NVIDIA protocol is released. Repetitions multiply both counts directly.

## Feasibility against Pi 0.85.1

Pi itself has the necessary controls for a clean direct A/B:

- `--provider`, `--model`, `--thinking`, and `--mode json` pin the route and produce machine-readable events.
- `--session-dir` separates persistent logs.
- `--no-extensions` suppresses configured extensions while retaining an explicitly supplied `-e/--extension`. `resource-loader.ts` implements this by choosing only CLI-enabled extension paths when `noExtensions` is true.
- `--no-skills`, `--no-prompt-templates`, `--no-themes`, and `--no-context-files` suppress other prompt/runtime resources.
- `--no-approve` leaves project-local trusted settings/resources disabled.
- `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` relocate configuration and sessions.
- Persistent JSONL assistant messages include input/output/cache token counts and Pi's computed cost. Compaction and branch-summary entries can contain their own LLM usage.

Therefore stock Pi versus Pi plus exactly one explicit local extension is directly runnable. What is not directly runnable is the current SForge benchmark.

### Local extension provenance

The treatment currently is not source-pinned by Git alone. Before any paid experiment, commit/archive it or preserve and check these byte hashes:

```text
8d372e483a37133d1366a99f3d24420121b0ceb9d1791a43d007d6d2df3f7af0  extensions/index.ts
517af34480d83d52e82e4f3f4fe8b07aae4f59c25d4a86fd941cca3c5d82054f  extensions/store.ts
1160092ddae692c69841da4cb1b5d3e890496f64df805f5b803e8045e223c3d5  extensions/tools.ts
9456155976ea24435e5c422b43559c20fd888f0682b7cf153249d5b745cc6295  extensions/window-driver.ts
```

The combined binary diff hash for those files plus `package.json` was `6fb37aedff27188a8a51aa5e82c6b454c41ff71da6916b69173ab778e18d8e56`. The pre-existing worktree also contained other modified and untracked files. A reproducible publication should use a clean commit, not only these hashes.

The local `npm run benchmark` is not an alternative to EdgeBench. It is a deterministic, credential-free replay/index microbenchmark over synthetic session entries. It has no model, task verifier, stock-Pi arm, or task-quality score.

## OpenRouter model preflight

The public catalog currently reports for `deepseek/deepseek-v4.1-flash`:

- canonical slug `deepseek/deepseek-v4.1-flash-20260910`;
- 1,048,576-token context;
- text and image input, text output;
- reasoning efforts `low`, `high`, and `max`;
- tool support;
- DeepSeek endpoint max completion of 384,000 tokens.

The catalog's base DeepSeek prices at retrieval were $0.15/million prompt tokens, $0.60/million completion tokens, and $0.003/million cache-read tokens. Time-based overrides can double those rates. Prices and endpoints are mutable, so preserve the catalog and endpoint responses at run start. Pi computes cost from the static rates in `models.json`; it does not use OpenRouter's actual per-generation charge. The dedicated-key usage delta is the billing authority.

Pi 0.85.1 predates this model: the Pi tag is dated 2026-09-05 and the model slug is dated 2026-09-10. In a fresh isolated Pi config, this command returned no match and created no billable request:

```bash
d=$(mktemp -d)
HOME="$d/home" PI_CODING_AGENT_DIR="$d/agent" \
  PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 OPENROUTER_API_KEY=dummy \
  pi --list-models 'deepseek-v4.1-flash'
rm -rf "$d"
```

The protocol therefore supplies a frozen `models.json`. A validated entry is included below. It pins OpenRouter's upstream provider to DeepSeek, disables fallback, uses `high` reasoning, sets temperature 0, and caps each response at 32,768 output tokens. The provider may not guarantee determinism even at temperature 0.

## Smallest reproducible A/B smoke protocol

### What this protocol does and does not show

This uses a frozen SoL-Pi source checkout as an ordinary repair fixture. Setup removes one `+ 1` from `estimateRemainingRequests`; the focused test deterministically fails with expected 16 versus received 15. Restoring the correct expression passes. The score is 1 only if the agent changes no path except `src/sol-pi/extensions/online-context-compact/economics.ts` and `npm run check` passes.

This task is intentionally small. With a real 1M-token model window it will probably produce zero `pi-codex-context` rollovers. If so, the result validates route isolation, extension loading, accounting, and fixed-task grading only. It measures treatment tool/schema overhead, not context-window benefit. Do not present it as a SoL-Pi or EdgeBench result.

### Prerequisites and hard spend control

Run from the local `pi-codex-context` package directory on Linux with Git, Node >=22.19, npm, `jq`, `curl`, `/usr/bin/time`, and `timeout`. Use a new OpenRouter key used by no other process. Set a hard key limit in OpenRouter before running; the example preflight rejects an unlimited key or a limit above $5. The key is passed only through the environment, not a command-line flag.

A timeout is not a financial cap. The dedicated OpenRouter key limit is the cap.

### 1. Freeze tools, sources, task, and model metadata

```bash
set -euo pipefail

export EXT_ROOT="$PWD"
export AB_ROOT="${TMPDIR:-/tmp}/pi-context-ab-$(date -u +%Y%m%dT%H%M%SZ)"
export SOL_COMMIT=2b791687a489a1d24da816cf1634d8ae1d36befd
export MODEL=deepseek/deepseek-v4.1-flash
export MAX_KEY_LIMIT_USD=5
: "${OPENROUTER_API_KEY:?export a dedicated, spend-limited OpenRouter key}"
mkdir -p "$AB_ROOT"/{toolchain,runs,agents,homes,sessions}

# Verify the exact dirty local treatment bytes researched here.
(
  cd "$EXT_ROOT"
  sha256sum -c <<'HASHES'
8d372e483a37133d1366a99f3d24420121b0ceb9d1791a43d007d6d2df3f7af0  extensions/index.ts
517af34480d83d52e82e4f3f4fe8b07aae4f59c25d4a86fd941cca3c5d82054f  extensions/store.ts
1160092ddae692c69841da4cb1b5d3e890496f64df805f5b803e8045e223c3d5  extensions/tools.ts
9456155976ea24435e5c422b43559c20fd888f0682b7cf153249d5b745cc6295  extensions/window-driver.ts
HASHES
)

npm install --prefix "$AB_ROOT/toolchain" --ignore-scripts --no-audit --no-fund \
  @earendil-works/pi-coding-agent@0.85.1
PI="$AB_ROOT/toolchain/node_modules/.bin/pi"
test "$($PI --version)" = 0.85.1
npm ls --prefix "$AB_ROOT/toolchain" --all --json > "$AB_ROOT/toolchain/npm-tree.json"

# Freeze the task and all of its npm dependencies.
git clone https://github.com/NVlabs/SoL-Pi.git "$AB_ROOT/template"
git -C "$AB_ROOT/template" checkout --detach "$SOL_COMMIT"
npm --prefix "$AB_ROOT/template" ci --ignore-scripts --no-audit --no-fund

# Preserve mutable provider metadata and verify the dedicated key cap.
curl -fsSL https://openrouter.ai/api/v1/models > "$AB_ROOT/openrouter-models.json"
curl -fsSL https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints \
  > "$AB_ROOT/openrouter-endpoints.json"
curl -fsSL https://openrouter.ai/api/v1/key \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" > "$AB_ROOT/key-initial.json"
jq -e --argjson cap "$MAX_KEY_LIMIT_USD" \
  '.data.limit != null and .data.limit <= $cap and .data.limit_remaining > 0' \
  "$AB_ROOT/key-initial.json" >/dev/null

cat > "$AB_ROOT/models.json" <<'JSON'
{
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "api": "openai-completions",
      "apiKey": "$OPENROUTER_API_KEY",
      "models": [
        {
          "id": "deepseek/deepseek-v4.1-flash",
          "name": "DeepSeek: DeepSeek V4.1 Flash",
          "reasoning": true,
          "thinkingLevelMap": {
            "off": "none",
            "minimal": null,
            "low": "low",
            "medium": null,
            "high": "high",
            "xhigh": null,
            "max": "max"
          },
          "input": ["text", "image"],
          "contextWindow": 1048576,
          "maxTokens": 32768,
          "samplingParams": { "temperature": 0 },
          "cost": {
            "input": 0.15,
            "output": 0.60,
            "cacheRead": 0.003,
            "cacheWrite": 0
          },
          "compat": {
            "openRouterRouting": {
              "only": ["deepseek"],
              "allow_fallbacks": false,
              "require_parameters": true
            }
          }
        }
      ]
    }
  }
}
JSON

# Non-billable model-resolution check in a fresh config directory.
mkdir -p "$AB_ROOT/preflight-agent"
cp "$AB_ROOT/models.json" "$AB_ROOT/preflight-agent/models.json"
PI_CODING_AGENT_DIR="$AB_ROOT/preflight-agent" PI_OFFLINE=1 PI_TELEMETRY=0 \
  OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
  "$PI" --list-models 'deepseek-v4.1-flash' | tee "$AB_ROOT/model-preflight.txt"
grep -F 'deepseek/deepseek-v4.1-flash' "$AB_ROOT/model-preflight.txt"
```

Do not proceed if the hashes, version, key-cap check, or model check fails.

### 2. Define fresh-workspace setup, runner, grader, and metrics

```bash
prepare_run() {
  arm=$1 rep=$2
  run="$AB_ROOT/runs/${rep}-${arm}"
  work="$run/work"
  agent="$AB_ROOT/agents/${rep}-${arm}"
  home="$AB_ROOT/homes/${rep}-${arm}"
  session="$AB_ROOT/sessions/${rep}-${arm}"
  mkdir -p "$run" "$agent" "$home" "$session"
  cp -a --reflink=auto "$AB_ROOT/template" "$work"
  cp "$AB_ROOT/models.json" "$agent/models.json"

  python - "$work/src/sol-pi/extensions/online-context-compact/economics.ts" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
old = "\t\t1 + Math.floor(lowerBound * Math.max(0, input.remainingBoundaries) * input.scale);"
new = "\t\tMath.floor(lowerBound * Math.max(0, input.remainingBoundaries) * input.scale);"
assert s.count(old) == 1
p.write_text(s.replace(old, new))
PY

  # Prove the task starts failed without spending model tokens.
  set +e
  npm --prefix "$work" test -- --run tests/online-context-compact-economics.test.ts \
    > "$run/baseline-test.log" 2>&1
  baseline_rc=$?
  set -e
  test "$baseline_rc" -ne 0
}

key_snapshot() {
  curl -fsSL https://openrouter.ai/api/v1/key \
    -H "Authorization: Bearer $OPENROUTER_API_KEY" > "$1"
}

run_one() {
  arm=$1 rep=$2
  run="$AB_ROOT/runs/${rep}-${arm}"
  work="$run/work"
  agent="$AB_ROOT/agents/${rep}-${arm}"
  home="$AB_ROOT/homes/${rep}-${arm}"
  session="$AB_ROOT/sessions/${rep}-${arm}"
  ext_args=()
  if [ "$arm" = context ]; then
    ext_args=(-e "$EXT_ROOT/extensions/index.ts")
  fi

  prompt='Fix the defect in this repository. You may modify only src/sol-pi/extensions/online-context-compact/economics.ts. Do not modify tests, dependencies, configuration, or generated files. Run the focused failing test and npm run check. Stop only when the checks pass.'
  node_bin=$(dirname "$(command -v node)")

  key_snapshot "$run/key-before.json"
  set +e
  (
    cd "$work"
    /usr/bin/time -f 'elapsed_seconds=%e\nmax_rss_kb=%M\nexit_status=%x' -o "$run/time.txt" \
      timeout --signal=TERM --kill-after=60s 900s \
      env -i \
        HOME="$home" PATH="$node_bin:/usr/bin:/bin" LANG=C.UTF-8 CI=1 \
        OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
        PI_CODING_AGENT_DIR="$agent" PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
        "$PI" \
          --mode json \
          --provider openrouter --model "$MODEL" --thinking high \
          --session-dir "$session" --name "ab-${rep}-${arm}" \
          --no-extensions "${ext_args[@]}" \
          --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve \
          "$prompt"
  ) > "$run/events.jsonl" 2> "$run/stderr.log"
  pi_rc=$?
  set -e
  printf '%s\n' "$pi_rc" > "$run/pi-exit-code.txt"
  key_snapshot "$run/key-after.json"

  # Reject test/config edits and then run the complete deterministic grader.
  {
    git -C "$work" diff --name-only "$SOL_COMMIT"
    git -C "$work" ls-files --others --exclude-standard
  } | sort -u > "$run/changed-paths.txt"
  allowed=src/sol-pi/extensions/online-context-compact/economics.ts
  set +e
  if [ "$(cat "$run/changed-paths.txt")" = "$allowed" ]; then
    timeout --signal=TERM --kill-after=30s 300s npm --prefix "$work" run check \
      > "$run/grader.log" 2>&1
    grader_rc=$?
  else
    grader_rc=2
    printf 'Out-of-scope path change\n' > "$run/grader.log"
  fi
  set -e
  score=0
  [ "$grader_rc" -eq 0 ] && score=1
  jq -n --arg arm "$arm" --argjson rep "$rep" --argjson pi_rc "$pi_rc" \
    --argjson grader_rc "$grader_rc" --argjson score "$score" \
    '{arm:$arm,replicate:$rep,pi_exit_code:$pi_rc,grader_exit_code:$grader_rc,score:$score}' \
    > "$run/score.json"
  git -C "$work" diff --binary "$SOL_COMMIT" > "$run/final.patch"

  session_file=$(find "$session" -type f -name '*.jsonl' -print -quit)
  if [ -n "$session_file" ]; then
    jq -s '
      [ .[] |
        if .type == "message" and
           (.message.role == "assistant" or (.message.role == "toolResult" and .message.usage != null))
        then .message.usage
        elif (.type == "compaction" or .type == "branch_summary") and .usage != null
        then .usage
        else empty end
      ] as $u |
      [ .[] | select(.type == "message" and .message.role == "assistant") | .message ] as $a |
      {
        assistant_responses: ($a | length),
        provider_usage_records: ($u | length),
        input_tokens: ([$u[]?.input // 0] | add // 0),
        output_tokens: ([$u[]?.output // 0] | add // 0),
        reasoning_tokens: ([$u[]?.reasoning // 0] | add // 0),
        cache_read_tokens: ([$u[]?.cacheRead // 0] | add // 0),
        cache_write_tokens: ([$u[]?.cacheWrite // 0] | add // 0),
        pi_estimated_cost_usd: ([$u[]?.cost.total // 0] | add // 0),
        tool_calls: ([$a[]?.content[]? | select(.type == "toolCall")] | length),
        tool_call_names: ([$a[]?.content[]? | select(.type == "toolCall") | .name] |
          sort | group_by(.) | map({key: .[0], value: length}) | from_entries),
        stop_reasons: ([$a[]?.stopReason] | sort | group_by(.) |
          map({key: .[0], value: length}) | from_entries),
        compactions: ([.[] | select(.type == "compaction")] | length),
        context_extension_loaded: ([.[] | select(.type == "custom" and
          .customType == "pi-codex-context/window-v1" and .data.kind == "seed")] | length) > 0,
        context_rollovers: ([.[] | select(.type == "custom" and
          .customType == "pi-codex-context/window-v1" and .data.kind != "seed")] | length),
        models_seen: ([$a[]? | [.provider,.model] | join("/")] | unique)
      }
    ' "$session_file" > "$run/session-metrics.json"
  fi

  jq -n --slurpfile before "$run/key-before.json" --slurpfile after "$run/key-after.json" \
    '{openrouter_billed_usd: (($after[0].data.usage // 0) - ($before[0].data.usage // 0))}' \
    > "$run/billing.json"
}
```

### 3. Execute the minimum pair

Run serially so each key-usage delta belongs to one arm. The first pair uses stock then treatment; reverse the order in the next pair.

```bash
prepare_run stock 1
prepare_run context 1
run_one stock 1
run_one context 1

jq -s '.' \
  "$AB_ROOT/runs/1-stock/score.json" \
  "$AB_ROOT/runs/1-context/score.json" \
  > "$AB_ROOT/pair-1-scores.json"
jq -s '.' \
  "$AB_ROOT/runs/1-stock/session-metrics.json" \
  "$AB_ROOT/runs/1-context/session-metrics.json" \
  > "$AB_ROOT/pair-1-session-metrics.json"
jq -s '.' \
  "$AB_ROOT/runs/1-stock/billing.json" \
  "$AB_ROOT/runs/1-context/billing.json" \
  > "$AB_ROOT/pair-1-billing.json"

# Treatment contamination/activation checks.
jq -e '.context_extension_loaded == false' "$AB_ROOT/runs/1-stock/session-metrics.json"
jq -e '.context_extension_loaded == true' "$AB_ROOT/runs/1-context/session-metrics.json"

# Verify that the treatment source was not changed by either agent.
(
  cd "$EXT_ROOT"
  sha256sum extensions/index.ts extensions/store.ts extensions/tools.ts extensions/window-driver.ts
) > "$AB_ROOT/treatment-hashes-after.txt"
```

One pair means 2 agent sessions. The number of provider requests is not fixed: every assistant response and any model-generated compaction adds usage. Read `assistant_responses` and `provider_usage_records` after the run.

For three debug pairs, alternate order:

```bash
prepare_run context 2; prepare_run stock 2
run_one context 2; run_one stock 2
prepare_run stock 3; prepare_run context 3
run_one stock 3; run_one context 3
```

That is 6 total sessions. Five pairs are 10 sessions. Reuse no work, agent, home, or session directory between runs.

## Costs and interpretation

### Cost accounting

At the catalog rates captured above, Pi's estimate is:

```text
0.15 * uncached_input_tokens / 1,000,000
+ 0.60 * output_tokens / 1,000,000
+ 0.003 * cache_read_tokens / 1,000,000
```

Time-based DeepSeek overrides can double every listed rate. The model configuration intentionally records the base catalog rates, so `pi_estimated_cost_usd` is an API-equivalent estimate, not necessarily the bill. Use `billing.json` as the actual OpenRouter charge, provided the dedicated key had no concurrent user and accounting had updated. Preserve both values and the catalog snapshot.

Up-front dollar cost cannot be stated exactly because the number and size of model turns are agent outputs. The example makes the experiment's aggregate hard ceiling $5 through the dedicated key. A 2-run smoke pair, 6-run debug set, and 10-run repetition set all share that ceiling if they use that same key; later runs may fail for insufficient balance. Set a consciously chosen limit before scaling rather than raising it automatically.

### Primary and secondary metrics

Evaluate in this order:

1. **Task quality:** grader `score` and out-of-scope-change rejection. Never call lower cost an improvement when score regresses.
2. **Actual spend:** dedicated OpenRouter key usage delta.
3. **Token traffic:** uncached input, cache read/write, output, and reasoning tokens, including compaction usage.
4. **Interaction work:** assistant response count and tool-call count.
5. **Latency:** elapsed seconds; report timeouts separately.
6. **Context behavior:** treatment loaded, rollover count, compaction count, and use of note/history tools.
7. **Artifacts:** final patch, stop reasons, stderr, model IDs, provider endpoint snapshot, and grader log.

For each replicate, report treatment minus stock and treatment/stock ratios. Compare efficiency only for matched pairs in which both arms pass. With multiple tasks, aggregate at the paired task level and show every task, not only a mean. A single pair has no uncertainty estimate. Repeating one tiny task measures run variance but not task generalization.

A `context_rollovers` value of zero is an activation failure for claims about context replacement. The only supported conclusion then is the overhead or neutrality of loading the extension on that task. Do not extrapolate it to multi-hour trajectories.

## What would be needed for a real long-horizon A/B

The smallest EdgeBench-shaped pilot would be one public deterministic-judge task x two arms = 2 task-runs, with a short burn-rate timeout first. It cannot be run through unmodified current SForge. Before spending, a separately reviewed Pi `Agent` integration must define:

- installation of exactly Pi 0.85.1 and this exact extension revision in the work image;
- stock `--no-extensions` versus treatment `--no-extensions -e <immutable path>`;
- delivery of SForge's generated prompt and availability of `sforge-submit`;
- stop-hook equivalent or a declared lack of one;
- auto-resume semantics that preserve each arm's Pi session;
- JSON/session capture and final-result collection;
- the same OpenRouter model entry and upstream routing in both arms.

That adapter is an implementation change and was intentionally not made in this research. A one-task pilot is still not a reproduction of NVIDIA's 51-task aggregate or its undisclosed 11-task paired study. A credible long-horizon comparison should predeclare task IDs, image digests, timeout, resource limits, run order, failure handling, repetition count, activation criteria, and the quality non-regression rule before making paid calls.

## Blockers to exact reproduction

1. No SoL-Pi evaluation runner or Pi/SForge adapter is published.
2. No exact EdgeBench/Terminal-Bench task manifest or frozen task/image revisions accompany the charts.
3. No enhanced prompts, stop hook, auto-resume, submission/evaluation schedule, hardware allocation, or concurrency plan is published for the SoL-Pi runs.
4. No exact `sol-pi.json` for the combined harness is published. SoL-Pi mechanisms are disabled by default, and the README's conservative example enables only two local mechanisms.
5. No model routing, endpoint, reducer-model route, provider-price snapshot, run date, seeds, or retry policy is published beyond model labels and `xhigh`.
6. No per-task scores, trajectories, request/token records, or raw provider bills are published.
7. Current SForge has no Pi agent and requires source modification to add one.
8. Pi 0.85.1's fresh bundled catalog does not contain the requested later model; a frozen custom model entry is required.
9. The local treatment source is dirty and not independently retrievable by commit.
10. `pi-codex-context` is not SoL-Pi. Any result is a new extension comparison, not validation or refutation of SoL-Pi's four-mechanism claims.

## Primary-source index

### NVIDIA SoL-Pi

- Repository snapshot: <https://github.com/NVlabs/SoL-Pi/tree/2b791687a489a1d24da816cf1634d8ae1d36befd>
- README and published package scope: <https://github.com/NVlabs/SoL-Pi/blob/2b791687a489a1d24da816cf1634d8ae1d36befd/README.md>
- Package/test dependency pin: <https://github.com/NVlabs/SoL-Pi/blob/2b791687a489a1d24da816cf1634d8ae1d36befd/package.json>
- Contribution text saying NVIDIA will perform benchmarking: <https://github.com/NVlabs/SoL-Pi/blob/2b791687a489a1d24da816cf1634d8ae1d36befd/CONTRIBUTING.md>
- Faux-provider integration test: <https://github.com/NVlabs/SoL-Pi/blob/2b791687a489a1d24da816cf1634d8ae1d36befd/tests/online-context-compact-agent-session.test.ts>
- Regression stress test: <https://github.com/NVlabs/SoL-Pi/blob/2b791687a489a1d24da816cf1634d8ae1d36befd/tests/sol-pi-regression-stress.test.ts>
- Published site: <https://nvlabs.github.io/SoL-Pi/>
- Pinned site HTML: <https://github.com/NVlabs/SoL-Pi/blob/f6dcd699f59dc2c5ff55ba448485a235f80ab76e/index.html>
- Terminal-Bench chart renderer: <https://github.com/NVlabs/SoL-Pi/blob/f6dcd699f59dc2c5ff55ba448485a235f80ab76e/figures/plot_terminal_bench_web.py>
- EdgeBench score/cost/token SVGs: <https://github.com/NVlabs/SoL-Pi/tree/f6dcd699f59dc2c5ff55ba448485a235f80ab76e/assets>

### EdgeBench/SForge

- Repository snapshot and benchmark description: <https://github.com/ByteDance-Seed/EdgeBench/blob/668c7d4564c0f32d126c6c3b0f2828bc24a380ce/README.md>
- Agent registry without Pi: <https://github.com/ByteDance-Seed/EdgeBench/blob/668c7d4564c0f32d126c6c3b0f2828bc24a380ce/sforge/harness/agent/factory.py>
- Agent base class: <https://github.com/ByteDance-Seed/EdgeBench/blob/668c7d4564c0f32d126c6c3b0f2828bc24a380ce/sforge/harness/agent/base.py>
- Custom-agent limitation and lifecycle: <https://github.com/ByteDance-Seed/EdgeBench/blob/668c7d4564c0f32d126c6c3b0f2828bc24a380ce/docs/en/guide/agents.md>
- Single-task Docker and cost warning: <https://github.com/ByteDance-Seed/EdgeBench/blob/668c7d4564c0f32d126c6c3b0f2828bc24a380ce/docs/en/examples/single-task-docker.md>
- Official 51-task settings: <https://github.com/ByteDance-Seed/EdgeBench/blob/668c7d4564c0f32d126c6c3b0f2828bc24a380ce/examples/all-tasks-k8s/experiment.yaml>
- Official DeepSeek V4 Pro example, not the requested model: <https://github.com/ByteDance-Seed/EdgeBench/blob/668c7d4564c0f32d126c6c3b0f2828bc24a380ce/examples/all-tasks-k8s/experiment-deepseek.yaml>

### Pi 0.85.1

- Tagged source: <https://github.com/earendil-works/pi-mono/tree/v0.85.1>
- CLI argument definitions: <https://github.com/earendil-works/pi-mono/blob/v0.85.1/packages/coding-agent/src/cli/args.ts>
- Explicit-extension/no-extension resolution: <https://github.com/earendil-works/pi-mono/blob/v0.85.1/packages/coding-agent/src/core/resource-loader.ts>
- Config/session environment variables: <https://github.com/earendil-works/pi-mono/blob/v0.85.1/packages/coding-agent/src/config.ts> and <https://github.com/earendil-works/pi-mono/blob/v0.85.1/packages/coding-agent/docs/environment-variables.md>
- Custom model schema: <https://github.com/earendil-works/pi-mono/blob/v0.85.1/packages/coding-agent/docs/models.md>
- JSON event format: <https://github.com/earendil-works/pi-mono/blob/v0.85.1/packages/coding-agent/docs/json.md>
- Session/usage format: <https://github.com/earendil-works/pi-mono/blob/v0.85.1/packages/coding-agent/docs/session-format.md>
- OpenRouter provider: <https://github.com/earendil-works/pi-mono/blob/v0.85.1/packages/ai/src/providers/openrouter.ts>
- OpenRouter catalog generator and price mapping: <https://github.com/earendil-works/pi-mono/blob/v0.85.1/packages/ai/scripts/generate-models.ts>
- Pi's static cost calculation: <https://github.com/earendil-works/pi-mono/blob/v0.85.1/packages/ai/src/models.ts>

### OpenRouter

- Public model catalog: <https://openrouter.ai/api/v1/models>
- Current endpoint metadata: <https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints>
- Current-key usage/limit endpoint: <https://openrouter.ai/api/v1/key>

## Verification performed without inference

- Cloned and inspected the pinned SoL-Pi, Pi, and EdgeBench source trees.
- Scanned all fetched SoL-Pi refs and all reachable commit trees for benchmark/evaluation artifacts.
- Parsed the published SoL-Pi HTML and result SVG text/coordinates.
- Counted 51 tasks in each current official EdgeBench YAML.
- Verified SForge's registry has no Pi agent and its docs require source registration for custom agents.
- Ran `pi --version` and obtained `0.85.1`.
- Verified a fresh isolated Pi 0.85.1 config does not list `deepseek/deepseek-v4.1-flash`.
- Validated the supplied custom `models.json` with `pi --list-models`; it resolved the model as 1.0M context, 384K before the protocol's 32K safety cap, reasoning and image capable.
- Fetched only public OpenRouter metadata with GET requests. No chat/completions/responses endpoint was called.
- Materialized the frozen repair fixture, observed the focused test fail with 15 versus 16, restored the source, and observed all six focused tests pass.
- Did not execute the paid A/B, EdgeBench, Terminal-Bench, or any model inference.
