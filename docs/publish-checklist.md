# Publish Checklist

## Metadata

- Replace placeholder `publisher` in `package.json`
- Replace placeholder `repository.url`
- Add real `homepage` and `bugs.url`
- Decide whether to keep `preview: true`
- Consider bumping first public release to `0.1.0`

## Assets

- Refresh `docs/media/review-queue-workflow.gif`
- Review Marketplace icon at `media/icon.png`
- Confirm the README hero GIF renders correctly over HTTPS after GitHub publish

## Quality Gates

- `npm install`
- `npm run verify`
- `npx @vscode/vsce package`

Until `package.json.repository.url` points at the real public repository, `npm run package` uses a fallback README without the hero screenshot so local VSIX packaging still succeeds.

## GitHub

- Create public repository
- Push source with `LICENSE`, `CHANGELOG.md`, and docs
- Create a tagged release
- Attach the generated `.vsix` to the GitHub release if you want direct installs

## Marketplace

- Create or verify the Azure DevOps publisher
- Run `vsce login <publisher>`
- Publish with `vsce publish --pre-release` for the first public preview, or `vsce publish` for stable
- Verify README rendering, icon, and Resources links on the Marketplace page
