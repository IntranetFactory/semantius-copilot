# Backend B container image: SKILL-FREE by hard requirement (plan §6) — only
# the Cloudflare sandbox base (which bundles node) plus the shared semantius
# CLI. /workspace/.agents/skills stays empty at boot; if any skill file were
# baked in, B would be discovering a baked copy instead of testing dynamic
# injection (verified by the §13 clean-base test). semantius lives under
# /usr/local/bin, not /workspace/.agents/skills, so that invariant is untouched.
#
# Build context is the REPO ROOT (wrangler.jsonc sets image_build_context "..")
# so this Dockerfile can COPY the shared semantius CLI from linux-x64/. The COPY
# source below is therefore relative to the repo root, NOT to backend-b/.
#
# --platform=linux/amd64 is REQUIRED: semantius is an x86-64 binary and
# Cloudflare Containers only run linux/amd64. Without this, a build on an arm64
# host (e.g. Windows arm64) would default to an arm64 image and the x64 binary
# would fail with "exec format error". Pinning it makes the build host-agnostic.
FROM --platform=linux/amd64 docker.io/cloudflare/sandbox:0.12.3

# semantius platform CLI: a prebuilt linux-x64 binary installed onto PATH as
# `semantius` so the agent can call it straight from bash inside the sandbox
# (/usr/local/bin is on PATH). chmod because a COPY from a Windows/Git checkout
# may not carry the execute bit.
COPY linux-x64/semantius-linux-x64 /usr/local/bin/semantius
RUN chmod 0755 /usr/local/bin/semantius

# yq (mikefarah/yq): jq is already in the Ubuntu base image, yq is not. Install
# the pinned static linux/amd64 binary onto PATH so the agent can process YAML
# from bash just like jq. Pinned for reproducibility — bump YQ_VERSION to update.
ARG YQ_VERSION=v4.44.3
RUN curl -fsSL "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_amd64" \
      -o /usr/local/bin/yq \
 && chmod 0755 /usr/local/bin/yq

# semantius runtime config. The CLI authenticates as the SESSION'S USER, not
# with a shared org key, so there is no SEMANTIUS_API_KEY here at all:
#
#   SEMANTIUS_JWT  a PLACEHOLDER (sentinel), NOT a real token — the container
#                  never holds a credential. The Worker's catch-all egress
#                  handler swaps this value, wherever it appears in an outbound
#                  request header, for this session's user JWT. Safe to bake in.
#                  Keep in sync with SEMANTIUS_JWT_SENTINEL in core/src/config.js.
#   SEMANTIUS_ORG  deliberately NOT baked: it is per session (the `<org>` half of
#                  the user's token, known only after ingest verifies it) and a
#                  hardcoded org here would point every session at one tenant.
#                  provisionSemantiusEnv (core/src/sandbox-env.js) sets it on the
#                  container at provisioning and re-applies it on cold boot.
ENV SEMANTIUS_JWT=__sak__

# Interceptor-CA trust is handled OOTB by the in-container sandbox runtime
# (verified by inspecting /container-server/sandbox in this image): at boot
# with interception enabled it sets NODE_EXTRA_CA_CERTS to the provisioned CA
# and merges the CA into the system bundle, pointing SSL_CERT_FILE /
# CURL_CA_BUNDLE / REQUESTS_CA_BUNDLE / GIT_SSL_CAINFO at the merged bundle —
# every exec'd process (node, bun/semantius, curl, python, git) inherits
# working trust. This baked value is a belt-and-braces default only; the
# runtime overwrites it in the environment children actually see.
ENV NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt
