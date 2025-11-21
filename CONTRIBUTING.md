# Prerequisites

- `node: 22.x`
- `npx`
- `pnpm: >= 10`
- `docker: >= 19.03.0`

# Commands

- `pnpm install` - Install dependencies
- `pnpm build` - Build the project
- `pnpm format` - Apply prettier to the project, only to changed files
  - `pnpm format:check` - Check if prettier needs to be applied, check only changed files
  - `pnpm format:check:all` - Check if prettier needs to be applied. Check all files
  - `pnpm format:all` - Same as `pnpm format`, but check all files, regardless of changes
- `pnpm lint` - Run typecheck
- `pnpm lint` - Run linter
- `pnpm test` - Run tests

# Local Dev Env

Run `docker compose -f ./devenv/docker-compose.yml up --force-recreate` to start all dependencies required to run Jitsu. See
`./devenv/docker-compose.yml` top comments for list of services and debug tools





  
