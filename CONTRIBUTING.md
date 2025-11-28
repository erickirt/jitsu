# Prerequisites

- `node: >=22`
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
- `pnpm typecheck` - Run typecheck
- `pnpm lint` - Run linter
- `pnpm test` - Run tests

# Local Dev Env

Run 
 * `docker compose -f ./docker/docker-compose.yml up --force-recreate` to start all dependencies required to run Jitsu. 
 * `docker compose -f ./docker/docker-compose.yml up --profile jitsu-services-dev --force-recreate` - to run dependencies + all Jitsu services
in a hot reload mode, see `docker/README.md`





  
