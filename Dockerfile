# ---------------------------------------------------------------------------
# bake-toolchain
#
# Self-contained Anchor/Solana build environment.  Mount the bake repo and
# run Anchor commands without installing anything on the host.
#
#   docker build -t bake-toolchain .
#   docker run --rm -v "${PWD}:/workspace" -w /workspace/anchor bake-toolchain \
#       anchor build --arch v0 --tools-version v1.57
#
# See README.md "Testing without WSL (Docker)" and AGENTS.md §10.9.
#
# Every version below is pinned — no "latest" anywhere.  These are the exact
# versions confirmed working in WSL (see AGENTS.md §2.1).
# ---------------------------------------------------------------------------

# -- Base: Rust 1.89 + Debian Trixie ---------------------------------------
# Rust 1.89 matches the project's pinned rustc exactly
# (anchor/rust-toolchain.toml pins channel = "1.89.0"), so /workspace/anchor
# builds — including Anchor's host-side IDL generation — use the base
# toolchain directly with no runtime rustup download.
#
# Trixie (Debian 13, glibc 2.41) is REQUIRED, not optional: the anchor-cli
# 1.2.0 prebuilt binary links against glibc >= 2.39 (built on Ubuntu 24.04).
# bookworm's glibc 2.36 fails with `GLIBC_2.39 not found` (hit and diagnosed
# in testing).  Do not downgrade to bookworm.
FROM rust:1.89.0-slim-trixie

ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/root
ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo

# System deps (keep the layer small)
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates gcc g++ make pkg-config \
        libssl-dev libudev-dev git xz-utils \
    && rm -rf /var/lib/apt/lists/*

# -- Node.js 22.x (cookie-mcp requires >= 22) ------------------------------
# Official Node tarball (sha256-verified against SHASUMS256.txt), not
# NodeSource: pinned, distro-independent, and works on trixie (NodeSource
# has no trixie repo).
RUN cd /tmp && \
    curl -fsSL -o node-v22.23.2-linux-x64.tar.xz \
        https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz && \
    curl -fsSL https://nodejs.org/dist/v22.23.2/SHASUMS256.txt | \
        grep -F "node-v22.23.2-linux-x64.tar.xz" | sha256sum -c - && \
    tar -xJf node-v22.23.2-linux-x64.tar.xz -C /usr/local --strip-components=1 && \
    rm node-v22.23.2-linux-x64.tar.xz && \
    node --version && \
    npm --version

# -- Solana / Agave CLI 3.1.10 (pinned via the Anza installer) -------------
#    Pinned URL, not the "stable" redirect — version drift is exactly what
#    this image exists to prevent.  Non-interactive in Docker (no TTY).
RUN curl -sSfL https://release.anza.xyz/v3.1.10/install | \
    sh && \
    /root/.local/share/solana/install/active_release/bin/solana --version

# PATH is baked into the image ENV so every RUN and every container process
# sees solana / cargo-build-sbf / cargo / anchor / node with no profile
# sourcing.  Docker ENV persists across layers and at runtime — unlike WSL's
# `wsl -e bash -lc "..."` invocations, where `export` in one call is
# invisible to the next.  Do not replace this with `source ~/.cargo/env`.
ENV PATH="/root/.local/share/solana/install/active_release/bin:/usr/local/cargo/bin:/usr/local/bin:${PATH}"

# -- Anchor CLI 1.2.0 (pinned prebuilt release binary) ----------------------
#    This is the exact binary `avm install 1.2.0` would download — the
#    anchor v1.2.0 GitHub release ships `anchor-1.2.0-x86_64-unknown-linux-gnu`
#    as an asset.  Downloading it directly (with a pinned sha256 check)
#    avoids compiling avm from source, which drags in sigstore-verify →
#    reqwest/rustls → aws-lc-sys (BoringSSL) and adds 15-30 minutes to every
#    fresh image build for zero benefit: the artifact is identical.
RUN curl -fsSL \
        "https://github.com/coral-xyz/anchor/releases/download/v1.2.0/anchor-1.2.0-x86_64-unknown-linux-gnu" \
        -o /tmp/anchor && \
    echo "0c9c41a3292c281cc6eadb78d6e1c8224d8324a34b0736a89d640fd314db05b7  /tmp/anchor" | sha256sum -c - && \
    install -m 0755 /tmp/anchor /usr/local/bin/anchor && \
    rm /tmp/anchor && \
    anchor --version

# -- Pre-warm platform-tools v1.57 (image-build time, not first run) -------
#    Confirmed-working version from WSL debugging.  `cargo-build-sbf
#    --version` prints the version and exits BEFORE any download happens, so
#    pre-warming needs a real invocation with `--tools-version v1.57`.  We
#    build a tiny throwaway cdylib crate — this downloads platform-tools
#    v1.57 into ~/.cache/solana/v1.57, exactly the cache `anchor build
#    --tools-version v1.57` reads at runtime.  The download is baked into
#    this layer; a later container run does not need network for tools.
#    Do not "simplify" this back to `--version`; it silently stops pre-warming.
RUN mkdir -p /tmp/prewarm/src && cd /tmp/prewarm && \
    printf '[package]\nname = "prewarm"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\ncrate-type = ["cdylib"]\n' > Cargo.toml && \
    printf '#[no_mangle]\npub extern "C" fn entrypoint() {}\n' > src/lib.rs && \
    cargo-build-sbf --tools-version v1.57 && \
    rm -rf /tmp/prewarm && \
    test -d /root/.cache/solana/v1.57 && \
    echo "platform-tools v1.57 pre-warmed into image layer"

# -- Default dev wallet -----------------------------------------------------
#    Anchor.toml sets `wallet = "~/.config/solana/id.json"` — generate one
#    so anchor test/deploy resolve a payer inside the container (the local
#    test validator's faucet funds it via anchor's automatic airdrop).
RUN mkdir -p /root/.config/solana && \
    solana-keygen new --no-bip39-passphrase --silent --force \
        /root/.config/solana/id.json

# -- Verify the full toolchain is on PATH with no extra sourcing -----------
RUN echo "=== bake-toolchain versions ===" && \
    rustc --version && \
    cargo --version && \
    solana --version && \
    cargo-build-sbf --version && \
    anchor --version && \
    node --version && \
    npm --version && \
    command -v solana && \
    command -v anchor && \
    command -v cargo-build-sbf && \
    echo "=== done ==="

# -- Workspace (mounted at runtime, not copied) ----------------------------
WORKDIR /workspace

# Default: drop into a shell so the user can run commands interactively.
# Override with an explicit command for non-interactive use.
CMD ["bash"]
