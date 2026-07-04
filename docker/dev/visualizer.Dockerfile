# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

WORKDIR /app

COPY package.json bun.lock ./
COPY apps/adaptor/package.json apps/adaptor/package.json
COPY apps/runner/package.json apps/runner/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/shared/package.json apps/shared/package.json
COPY apps/visualizer/package.json apps/visualizer/package.json

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

COPY apps ./apps

EXPOSE 5173

CMD ["bun", "run", "--filter", "@app/visualizer", "dev", "--", "--host", "0.0.0.0"]
