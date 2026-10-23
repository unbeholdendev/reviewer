#!/bin/sh
set -eu
cd "$(dirname "$0")"
umask 077
mkdir -p credentials
docker compose pull reviewer
docker compose run --rm reviewer bun src/login.ts
docker compose up -d
