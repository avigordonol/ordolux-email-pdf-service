 
[Region: europe-west4]
=========================
Using Detected Dockerfile
=========================
context: wm3g-hBxy
internal
load build definition from Dockerfile
0ms
internal
load metadata for docker.io/library/node:20-slim
1s
auth
library/node:pull token for registry-1.docker.io
0ms
internal
load .dockerignore
0ms
1
FROM docker.io/library/node:20-slim@sha256:f679d7699517426eb148a5698c717477fd3f8a48f6c1eaf771e390a9bb8268c8
10ms
internal
load build context
0ms
2
RUN apt-get update && apt-get install -y --no-install-recommends     python3 python3-venv python3-pip     fonts-dejavu-core     ca-certificates  && rm -rf /var/lib/apt/lists/*
10s
done.
3
RUN python3 -m venv /opt/pyenv
3s
4
RUN pip install --upgrade pip setuptools wheel &&     pip install --no-cache-dir       extract-msg==0.41.2       olefile==0.46       compressed-rtf==1.0.6       chardet==5.2.0
7s
Successfully installed RTFDE-0.0.2 beautifulsoup4-4.12.3 cffi-2.0.0 chardet-5.2.0 colorclass-2.2.2 compressed-rtf-1.0.6 cryptography-46.0.3 easygui-0.98.3 ebcdic-1.1.1 extract-msg-0.41.2 imapclient-2.3.1 lark-parser-0.12.0 msoffcrypto-tool-5.4.2 olefile-0.46 oletools-0.60.2 pcodedmp-1.2.6 pycparser-2.23 pyparsing-3.2.5 pytz-deprecation-shim-0.1.0.post0 red-black-tree-mod-1.20 six-1.17.0 soupsieve-2.8 tzdata-2025.2 tzlocal-4.2
5
WORKDIR /app
38ms
6
COPY package*.json ./
11ms
7
RUN npm ci --omit=dev
461ms
npm error code EUSAGE
npm error
npm error The `npm ci` command can only install with an existing package-lock.json or
npm error npm-shrinkwrap.json with lockfileVersion >= 1. Run an install with npm@5 or
npm error later to generate a package-lock.json file, then try again.
npm error
npm error Clean install a project
npm error
npm error Usage:
npm error npm ci
npm error
npm error Options:
npm error [--install-strategy <hoisted|nested|shallow|linked>] [--legacy-bundling]
npm error [--global-style] [--omit <dev|optional|peer> [--omit <dev|optional|peer> ...]]
npm error [--include <prod|dev|optional|peer> [--include <prod|dev|optional|peer> ...]]
npm error [--strict-peer-deps] [--foreground-scripts] [--ignore-scripts] [--no-audit]
npm error [--no-bin-links] [--no-fund] [--dry-run]
npm error [-w|--workspace <workspace-name> [-w|--workspace <workspace-name> ...]]
npm error [-ws|--workspaces] [--include-workspace-root] [--install-links]
npm error
npm error aliases: clean-install, ic, install-clean, isntall-clean
npm error
npm error Run "npm help ci" for more info
npm error A complete log of this run can be found in: /root/.npm/_logs/2025-10-19T17_50_26_408Z-debug-0.log
Dockerfile:28
-------------------
26 |     WORKDIR /app
27 |     COPY package*.json ./
28 | >>> RUN npm ci --omit=dev
29 |     COPY . .
30 |
-------------------
ERROR: failed to build: failed to solve: process "/bin/sh -c npm ci --omit=dev" did not complete successfully: exit code: 1
