#!/usr/bin/env bash

# Python formatting
uv run ruff check --select I --fix "$@" # isort
uv run ruff format "$@" # black

# see the following issue for progress on a unified command that does both
# https://github.com/astral-sh/ruff/issues/8232

# HTML/Jinja2 template formatting
npx prettier --write "app/templates/**/*.html"
