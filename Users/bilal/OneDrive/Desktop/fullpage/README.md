# FullPage

Full-page screenshot capture & editing extension for Chromium browsers
(Chrome / Microsoft Edge).

## Releasing to the Microsoft Edge Add-ons Store

A single command builds, versions, packages, validates and (once secrets are
configured) publishes the extension.

```bat
release-edge-store.cmd
```

The script runs `scripts/edge-publish.mjs` and performs the following steps in
order:

1. **Build** – stages every publishable file into `build/` (development and OS
   junk such as `scripts/`, `dist/`, `desktop.ini`, `.cmd`, `.git` are
   excluded).
2. **Version bump** – increments the `version` field in `manifest.json`
   (patch by default).
3. **Package** – produces `dist/fullpage-v<version>.zip`.
4. **Validate** – confirms the manifest has the required fields, that every
   declared icon exists in the package, and that no dev/OS junk leaked in.
5. **Publish** – uploads and submits the package through the official
   [Microsoft Edge Add-ons API v1.1](https://learn.microsoft.com/microsoft-edge/extensions-chromium/publish/api/using-addons-api),
   polling until the store confirms success.

### Options

| Command | Effect |
| --- | --- |
| `release-edge-store.cmd` | Bump patch, package, publish |
| `release-edge-store.cmd --minor` | Bump minor version |
| `release-edge-store.cmd --major` | Bump major version |
| `release-edge-store.cmd --set 2.1.0` | Set an explicit version |
| `release-edge-store.cmd --no-publish` | Build & package only (no upload) |
| `release-edge-store.cmd --dry-run` | Show what would happen, change nothing |

`npm run release:edge` and `npm run package:edge` are equivalent entry points.

### Required secrets

The publish step reads credentials **from environment variables only** – they
are never hardcoded and never logged:

| Variable | Where to get it |
| --- | --- |
| `EDGE_CLIENT_ID` | Partner Center → Edge program → Publish API → Client ID |
| `EDGE_API_KEY` | Partner Center → Edge program → Publish API → API key |
| `EDGE_PRODUCT_ID` | The product/extension ID from your Edge dashboard URL |

How to create the API credentials:

1. Sign in to [Microsoft Partner Center](https://partner.microsoft.com/dashboard).
2. Open the **Microsoft Edge** program, then **Publish API**.
3. Choose **Create API credentials** to generate the Client ID and API key.
4. Find your **Product ID** in the URL of the extension's dashboard page.

Provide them one of two ways:

- **Local `.env` file** – copy `.env.example` to `.env` and fill in the values
  (`.env` is git-ignored). Then load it before running, e.g.
  PowerShell: `Get-Content .env | %{ if($_ -match '^(\w+)=(.*)$'){ [Environment]::SetEnvironmentVariable($matches[1],$matches[2]) } }`
- **Shell / CI variables** – set `EDGE_CLIENT_ID`, `EDGE_API_KEY` and
  `EDGE_PRODUCT_ID` directly in your environment or CI secret store.

If any of the three are missing, the script still builds, bumps, packages and
validates, then stops before publishing and tells you the package is ready.

> Requires **Node.js 18+** (uses the built-in `fetch`). On Windows the ZIP is
> produced with PowerShell `Compress-Archive`; no npm dependencies are needed.
