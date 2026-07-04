# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS agents

WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends g++

COPY apps/adaptor/src/tools/buildAgents.ts apps/adaptor/src/tools/buildAgents.ts
COPY apps/agents ./apps/agents

RUN bun run apps/adaptor/src/tools/buildAgents.ts

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS deps

WORKDIR /app

COPY package.json bun.lock ./
COPY apps/adaptor/package.json apps/adaptor/package.json
COPY apps/runner/package.json apps/runner/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/shared/package.json apps/shared/package.json
COPY apps/visualizer/package.json apps/visualizer/package.json

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --production --frozen-lockfile --ignore-scripts

FROM deps AS build

COPY apps/adaptor/src apps/adaptor/src
COPY apps/runner/src apps/runner/src
COPY apps/server/src apps/server/src
COPY apps/shared/src apps/shared/src

RUN bun build --target bun --outfile apps/server/dist/main.js apps/server/src/main.ts \
    && bun build --target bun --outfile apps/runner/dist/main.js apps/runner/src/main.ts \
    && bun build --target bun --outfile apps/adaptor/dist/main.js apps/adaptor/src/main.ts

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS runtime

WORKDIR /app

COPY --from=build /app/apps/server/dist/main.js apps/server/dist/main.js
COPY --from=build /app/apps/runner/dist/main.js apps/runner/dist/main.js
COPY --from=build /app/apps/adaptor/dist/main.js apps/adaptor/dist/main.js
COPY --from=agents /app/build ./build

RUN mkdir -p /app/data && chown bun:bun /app/data

EXPOSE 3000

USER bun

CMD ["bun", "run", "apps/server/dist/main.js", "--port", "3000", "--runner-entry", "apps/runner/dist/main.js", "--adaptor-entry", "apps/adaptor/dist/main.js"]
