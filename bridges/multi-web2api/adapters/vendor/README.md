# DeepSeek computational work runtime

`deepseek-sha3.wasm` is an unmodified asset from the MIT-licensed [FreeTokenAPI](https://github.com/mmmlllnnn/FreeTokenAPI/tree/a54a9bb5d32413dea819ab0a0bc37dfc352de928), inspected 2026-11-04. The same commit was upstream `main` at inspection. Copyright (c) 2026 FANATFANATA; the adjacent `LICENSE.FreeTokenAPI` contains the required notice.

Source path: `freetokenapi/deepseek/sha3_wasm_bg.wasm`; Git blob SHA-1 `ac92b1d87e8cdf3a5c2af4d189743c1f9d5feba7`; 26,612 bytes; SHA-256 `b3fca8cc072c1defbd60c02266a8e48bd307a1804aaff4314900aea720e72f7d`.

The worker interface and direct request/response mapping are adapted from that commit's `freetokenapi/deepseek/pow_solver.js`, `freetokenapi/pow.py`, `freetokenapi/deepseek/models.py`, and the DeepSeek/Qwen `client.py` and `stream.py` modules. This artifact's provenance is the upstream repository; it is not a claim of an independently verified DeepSeek release or endorsement.

For an authenticated user's request, the bridge performs the server-requested `DeepSeekHashV1` computational work and returns the supplied challenge, signature, and target unchanged with the computed answer. Each proof is fresh and single-use. Execution is isolated in one terminable worker, verifies the asset hash, and limits difficulty and elapsed time. It does not solve CAPTCHAs, forge verification tokens, or handle firewall challenges. No native binary, Python, or third-party Node package is required.
