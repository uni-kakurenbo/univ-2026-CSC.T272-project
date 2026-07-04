# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS build

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

# Overridable at build time so the bundle can call the API at a path on the
# same origin it is served from (e.g. https://example.com/api), instead of
# the dev-only default of a fixed port on the current hostname.
ARG VITE_SERVER_ORIGIN=/
ENV VITE_SERVER_ORIGIN=$VITE_SERVER_ORIGIN

RUN bun run --filter @app/visualizer build

FROM scratch AS artifact

COPY --from=build /app/apps/visualizer/dist /

FROM nginx:1.27-alpine AS client

COPY --from=build /app/apps/visualizer/dist /usr/share/nginx/html
COPY docker/prod/nginx.conf /etc/nginx/conf.d/default.conf
