FROM node:22-bookworm-slim AS frontend-build

WORKDIR /build/frontend
RUN npm install --global npm@11 --no-audit --no-fund
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.15.2-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /app

COPY backend/ ./backend/
# Keep imports at /app/backend/app so the existing repository-relative paths
# resolve to /app, where the compiled frontend lives.
RUN python -m pip install --no-cache-dir -e ./backend
COPY --from=frontend-build /build/frontend/dist/ ./frontend/dist/

USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3).read()"]
CMD ["python", "-m", "uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--no-proxy-headers"]
