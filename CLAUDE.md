# desplega.ai-action

## Versioning

Versions are tracked via **git tags** (not `package.json`). The tag format is `vX.Y.Z`.

To bump the version after a commit:
```
git tag v<new-version>
```

Always create a new tag when shipping changes. Use semver: patch for fixes, minor for new features.

## Build

After modifying source files, rebuild the dist bundle:
```
npm run package
```

The `dist/index.js` must be committed — it's the action entry point.

## Local Testing

A `.env` file (gitignored) contains credentials for testing against the local API:
- `DESPLEGA_API_KEY` — API key for authentication
- `DESPLEGA_SUITE_ID` — test suite ID to trigger
- `DESPLEGA_ORIGIN_URL` — local API URL (e.g. `http://localhost:5005`)

The local API runs via pm2 as `cope-api`. Check logs with `pm2 logs cope-api`.
