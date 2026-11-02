#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Explicit source list: never transfer .env, Git history or node_modules.
COPYFILE_DISABLE=1 tar --exclude='__pycache__' --exclude='*.py[cod]' \
  -czf challenge-deploy.tar.gz \
  Dockerfile .dockerignore .env.example \
  backend/app backend/pyproject.toml \
  frontend/src frontend/package.json frontend/package-lock.json \
  frontend/index.html frontend/tsconfig.json frontend/vite.config.ts \
  frontend/eslint.config.js

echo 'Created challenge-deploy.tar.gz (API key not included).'
