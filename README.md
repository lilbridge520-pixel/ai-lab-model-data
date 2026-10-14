# AI LAB model data service

This directory is prepared to become the root of a small, public GitHub repository. It uses Node.js built-ins only and makes no model API calls.

## Daily flow

`.github/workflows/daily-sync.yml` runs at 03:17 China Standard Time (UTC cron 19:17), after service code changes are pushed, and can also be started manually from the Actions tab. GitHub may delay or skip scheduled runs. Each source is fetched independently with a timeout. Validated values update `data/latest.json`; unsafe or ambiguous changes go to `data/pending-review.json`; failed sources preserve the previous value. GitHub's public raw-content URL serves the committed JSON over HTTPS, so no Pages setup or extra hosting service is needed.

The browser reads `https://raw.githubusercontent.com/lilbridge520-pixel/ai-lab-model-data/main/data/latest.json` over HTTPS by default. `VITE_MODEL_DATA_URL` can override the endpoint. If it is unavailable or fails schema validation, AI LAB uses its bundled snapshot. The front end polls every six hours while the page is visible; the snapshot remains usable offline.

## Source coverage

| Provider | Source handling | Price automation |
| --- | --- | --- |
| Qwen | Official Model Studio pricing page | Parses Qwen Max, mainland non-thinking price |
| DeepSeek | Official pricing table | Parses Flash and V4 Pro, cache hit, cache miss, peak and off-peak rates |
| Baidu Qianfan | Official product/model page | Parses the verified ERNIE 4.5 Turbo 128K per-thousand rates |
| Tencent Hunyuan | Official price table | Parses Hunyuan-a13b rates; migration notice remains visible |
| Kimi | Official model platform | Parses K3 input, output and cache-hit rates; API model ID is not published on the pricing card |
| Doubao / Volcano Ark | Official pricing page | Watch only; pricing is tiered by priority and modality and needs a structured source adapter |
| Zhipu GLM | Official pricing page | Watch only; no unambiguous public rate was parsed |
| MiniMax | Official pricing page | Watch only; subscription pricing is not treated as API token pricing |

The first successful source read records each provider's currently listed model IDs as the discovery baseline. A later ID that was not seen in that baseline enters the review queue; it is never inserted into the calculator automatically. A missing model ID, ambiguous tier, currency/unit mismatch, rate above the sanity bound, cache-rate removal, or price change above 50% also prevents automatic price replacement. Explicit retirement text is only flagged; a page fetch failure or missing ID never means a model is retired.

## Local verification

From this directory:

```sh
node --test test/sync.test.mjs
node sync.mjs
```

The sync command exits with code 2 only when every configured source fails. A partial sync writes source failures and preserves the previous rates for those providers.

## Enabling a public endpoint

`data/latest.json` and `data/pending-review.json` contain official model names, API IDs, public prices, source URLs, verification timestamps and parser review items; they contain no user data or credentials. Keep this directory at the repository root. The workflow's `GITHUB_TOKEN` only commits validated JSON and audit state back to this repository. Do not add a credential to the repository or endpoint.

