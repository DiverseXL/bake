# bake

**bake** is a developer tool for [Cookie Chain](https://cookiescan.io) — an SVM/Solana-compatible blockchain.

> This is the initial project skeleton. Business logic is not implemented yet; every command currently prints a "not implemented yet" stub.

## Installation

For end users (placeholder):

```bash
npm install -g bake-cli
```

For local development:

```bash
npm install
```

## Usage

Run the CLI in development mode (executes TypeScript source directly):

```bash
npm run dev -- --help
```

Example of invoking a specific command:

```bash
npm run dev -- use cookie
npm run dev -- deploy
npm run dev -- logs
```

Global flags:

```bash
bake --ci        # Disable spinners/colors, force JSON-safe output
bake --json      # Output results as JSON
bake -v          # Print version
bake --version   # Print version
```

## Planned Commands

| Command         | Description                                           |
| --------------- | ----------------------------------------------------- |
| `bake init`     | Initialize a new bake project in the current directory |
| `bake login`    | Authenticate with your Cookie Chain wallet            |
| `bake use`      | Switch active cluster or configure project settings   |
| `bake deploy`   | Deploy an Anchor program to the active cluster        |
| `bake logs`     | View program logs on the active cluster               |
| `bake rollback` | Roll back to a previous program version               |
| `bake diff`     | Show differences between local and deployed programs  |
| `bake stats`    | Show program statistics and usage metrics             |
| `bake prove`    | Generate or verify program proofs                     |
| `bake fork`     | Fork a program or cluster state for local development |
| `bake decode`   | Decode transaction data or program instructions       |
| `bake top`      | View network and program leaderboards or top accounts |
| `bake mcp`      | Interact with the bake MCP (model context protocol) server |

## Development

```bash
npm install          # Install dependencies
npm run dev -- --help  # Run the CLI in dev mode
npm run build        # Compile TypeScript to dist/
npm run start        # Run the compiled CLI
npm run lint         # Lint source files
npm run format       # Format source files with Prettier
npm run typecheck    # Type-check without emitting files
```

### Configuration

- **Global config:** `~/.bake/config.json` — stores active cluster, wallet/session info, and user preferences.
- **Project config:** `./bake.config.json` — optional; can override program name, cluster, and paths to Anchor programs.

The config loader merges project config over global config and validates the shape with Zod. Malformed config produces a friendly, non-stack-trace error.

### Adding a new cluster

Edit `src/clusters/index.ts` and add a preset entry to the `CLUSTERS` object.

## License

MIT
