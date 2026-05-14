# Docker Smoke Test

This project can be smoke-tested in a clean Linux container before publishing.

## What This Covers

- install dependencies in a clean environment
- run `npm run verify`
- package a `.vsix`

## Recommended Flow

1. Build the container image.
2. Run `npm ci`.
3. Run `npm run verify`.
4. Run `npm run package`.

## Notes

- `npm run package` automatically falls back to a text-only README until the final public repository URL is configured.
