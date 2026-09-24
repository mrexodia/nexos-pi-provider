# Nexos provider for pi & Oh My Pi

API-key login and automatic model discovery for [Nexos](https://nexos.ai). Models use readable names like `glm-5.3-flash/eu`; host and UUID qualifiers are added only when needed to distinguish deployments.

## Install

```sh
pi install git:github.com/mrexodia/nexos-pi-provider
# or
omp install github:mrexodia/nexos-pi-provider
```

Restart your agent, then run `/login nexos` and `/model`. Alternatively, set `NEXOS_API_KEY` before launching. `.env` files are not loaded automatically.

- `/nexos-refresh` refreshes the authenticated model list.
- Text-only for now; non-chat models are excluded.
- Chat Completions is preferred by default. Set `NEXOS_API=responses` to prefer Responses when available.
- Requests use the full Nexos model UUID, not the displayed alias.

## Development

Requires Node 22.19+ and Bun for the OMP tests.

```sh
npm install --ignore-scripts
npm run check
npm test
```

License: [Boost Software License 1.0](LICENSE).
