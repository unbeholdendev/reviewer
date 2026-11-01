#!/bin/sh
set -eu
cd "$(dirname "$0")"
umask 077
mkdir -p credentials
docker compose pull --ignore-buildable reviewer
docker compose build reviewer
docker compose run --rm reviewer bun src/login.ts
docker compose up -d
