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
ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo
ENV PATH="/usr/local/cargo/bin:${PATH}"

# System deps (keep the layer small)
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates gcc g++ make pkg-config \
        libssl-dev libudev-dev git xz-utils \
    && rm -rf /var/lib/apt/lists/*

# -- Node.js 22.x (cookie-mcp requires >= 22) ------------------------------
# Official Node tarball (sha256-verified against SHASUMS256.txt), not
# NodeSource: pinned, distro-independent, and works on trixie (NodeSource
# has no trixie repo).
RUN curl -fsSL https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz \
        -o /tmp/node.tar.xz && \
    curl -fsSL https://nodejs.org/dist/v22.23.2/SHASUMS256.txt | \
        grep -F "node-v22.23.2-linux-x64.tar.xz" > /tmp/node.sha && \
    sha256sum -c /tmp/node.sha && \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 && \
    rm /tmp/node.tar.xz /tmp/node.sha && \
    node --version && \
    npm --version

# -- Solana / Agave CLI 3.1.10 (pinned via the Anza installer) -------------
#    Pinned URL, not the "stable" redirect — version drift is exactly what
#    this image exists to prevent.  Non-interactive in Docker (no TTY).
RUN curl -sSfL https://release.anza.xyz/v3.1.10/install | \
    sh && \
    /root/.local/share/solana/install/active_release/bin/solana --version

ENV PATH="/root/.local/share/solana/install/active_release/bin:${PATH}"

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

# -- Pre-warm platform-tools v1.57 -----------------------------------------
#    `cargo-build-sbf --version` prints the version and exits BEFORE any
#    download happens, so pre-warming needs a real build invocation.  We
#    build a tiny throwaway cdylib crate — this downloads platform-tools
#    v1.57 into ~/.cache/solana/v1.57, exactly the cache `anchor build
#    --tools-version v1.57` reads at runtime.  No network needed later.
RUN mkdir -p /tmp/prewarm/src && cd /tmp/prewarm && \
    printf '[package]\nname = "prewarm"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\ncrate-type = ["cdylib"]\n' > Cargo.toml && \
    printf '#[no_mangle]\npub extern "C" fn entrypoint() {}\n' > src/lib.rs && \
    cargo-build-sbf --tools-version v1.57 && \
    rm -rf /tmp/prewarm && \
    echo "platform-tools v1.57 pre-warmed"

# -- Default dev wallet -----------------------------------------------------
#    Anchor.toml sets `wallet = "~/.config/solana/id.json"` — generate one
#    so anchor test/deploy resolve a payer inside the container (the local
#    test validator's faucet funds it via anchor's automatic airdrop).
RUN mkdir -p /root/.config/solana && \
    solana-keygen new --no-bip39-passphrase --silent --force \
        /root/.config/solana/id.json

# -- Verify the full toolchain ---------------------------------------------
RUN echo "=== bake-toolchain versions ===" && \
    rustc --version && \
    cargo --version && \
    solana --version && \
    anchor --version && \
    node --version && \
    npm --version && \
    echo "=== done ==="

# -- Workspace (mounted at runtime, not copied) ----------------------------
WORKDIR /workspace

# Default: drop into a shell so the user can run commands interactively.
# Override with an explicit command for non-interactive use.
CMD ["bash"]