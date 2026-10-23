FROM oven/bun:1.4

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates ripgrep fd-find \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY src src
COPY prompts prompts

EXPOSE 3000
CMD ["bun", "src/server.ts"]
