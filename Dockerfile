FROM oven/bun:1.4

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://claude.ai/install.sh | bash -s 2.1.280
ENV PATH=/root/.local/bin:$PATH

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY src src
COPY prompts prompts

EXPOSE 3000
CMD ["bun", "src/server.ts"]
