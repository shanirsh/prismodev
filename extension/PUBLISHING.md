# Publishing the extension

The extension ships to two registries so it's installable in **VS Code**
(Microsoft Marketplace) and **Cursor / Windsurf** (Open VSX). CI does the
publish on a `ext-v*` tag; you only need to set up the accounts and secrets
once.

## One-time setup

1. **Microsoft Marketplace publisher**
   - Create an Azure DevOps org, then a Marketplace publisher with id `prismo`
     (must match `publisher` in `package.json`): https://marketplace.visualstudio.com/manage
   - Create a Personal Access Token (scope: *Marketplace → Manage*).
   - Add it as the repo secret **`VSCE_PAT`**.

2. **Open VSX (for Cursor / Windsurf)**
   - Sign in at https://open-vsx.org and create the `prismo` namespace.
   - Create an access token under your profile.
   - Add it as the repo secret **`OVSX_PAT`**.

Secrets live only in GitHub Actions — they are never committed.

## Releasing

```bash
# bump extension/package.json "version", commit, then:
git tag ext-v0.1.0
git push --tags
```

The `Publish extension` workflow builds, packages, and publishes to whichever
registry has a token configured (each publish step is skipped if its secret is
absent), and uploads the `.vsix` as a build artifact.

## Local build / manual publish

```bash
cd extension
npm install
npm run package            # produces a .vsix you can install with "Install from VSIX…"
npm run publish:vsce       # needs VSCE_PAT in your environment
npm run publish:ovsx       # needs OVSX_PAT in your environment
```
