# Running Jitsu in Docker

## Start Jitsu in Docker Compose

Use the following command to start all necessary Jitsu services:

```bash
docker compose -f ./docker/docker-compose.yml --profile jitsu-services up -d --no-build --force-recreate
```

This will start all Jitsu services. Once running, open http://localhost:3000 in your browser and login with
`admin@jitsu.com` / `admin123` (you can customize these via `SEED_USER_EMAIL` and `SEED_USER_PASSWORD` variables,
see Configuration Variables section below).

**Note:** This setup is for exploration and development only. For production deployment, see
https://docs.jitsu.com/self-hosting/production-deployment

## Start Jitsu in Dev Mode

For development with hot reload enabled, use:

```bash
docker compose -f ./docker/docker-compose.yml --profile jitsu-services-dev up -d --no-build --force-recreate
```

This starts all Jitsu services with hot reload, allowing you to make changes to the code and see them reflected
immediately without restarting containers.

**Note:** The dev mode uses:
- `jitsucom/jitsu-builder:latest` for Node.js services (Console, Rotor)
- `golang:1.22-alpine` for Go services (Bulker, Ingest) - lightweight Alpine Linux image

## Services List

### Core Services

| Service | URL/Connection | Description |
|---------|---------------|-------------|
| PostgreSQL | `postgresql://postgres:postgres-mqf3nzx@localhost:5438/postgres` | Main database |
| MongoDB | `mongodb://admin:mongodb-pass@localhost:27017/admin` | Profile storage |
| ClickHouse HTTP | `http://default:clickhouse-pass@localhost:8123/default` | Analytics database |
| ClickHouse Native | `clickhouse://default:clickhouse-pass@localhost:9000/default` | Analytics database (native protocol) |
| Redpanda (Kafka) | `kafka://localhost:19092` | Message queue (no auth) |

### Debug/Admin Tools

| Service | URL | Credentials | Description |
|---------|-----|-------------|-------------|
| Redpanda Console | http://localhost:11801 | No auth | Kafka/Redpanda management UI |
| PgWeb | http://localhost:11802 | No auth | PostgreSQL web UI (auto-connected) |
| ClickHouse Play UI | http://localhost:8123/play | default / clickhouse-pass | ClickHouse query interface |
| Mongo Express | http://localhost:11803 | admin / mongodb-pass | MongoDB web UI |
| Keycloak | http://localhost:11804 | admin / admin | Identity management |

### Jitsu Services

| Service | URL | Description |
|---------|-----|-------------|
| Console | http://localhost:3000 | Main Jitsu UI (admin@jitsu.com / admin123) |
| Rotor | http://localhost:3401 | Event processing service |
| Bulker | http://localhost:3042 | Bulk data loading service |
| Ingest | http://localhost:3049 | Event ingestion endpoint |
| Syncctl | http://localhost:3043 | Synchronization controller (optional, requires Kubernetes) |

## Configuration Variables

Override these variables via environment variables or by creating a `.env.local` file

### Authentication & Security

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_PASSWORD` | `postgres-mqf3nzx` | PostgreSQL password |
| `CLICKHOUSE_PASSWORD` | `clickhouse-pass` | ClickHouse password |
| `MONGODB_PASSWORD` | `mongodb-pass` | MongoDB password |
| `SEED_USER_EMAIL` | `admin@jitsu.com` | Initial admin user email |
| `SEED_USER_PASSWORD` | `admin123` | Initial admin user password |
| `BULKER_TOKEN` | `dev-auth-key` | Bulker service authentication token |
| `CONSOLE_TOKEN` | `dev-auth-key` | Console service authentication token |
| `SYNCCTL_TOKEN` | `dev-auth-key` | Syncctl service authentication token |

### Optional Features

| Variable | Default | Description |
|----------|---------|-------------|
| `SEED_DEMO_CONFIGURATION` | (not set) | Set to any value to create demo stream and destination |
| `JITSU_INGEST_PUBLIC_URL` | `http://localhost:3049` | Public URL for ingestion endpoint |

### Kubernetes Configuration (Optional)

[Jitsu Connectors](https://jitsu.com/integrations/connectors) manages synchronization jobs in Kubernetes. If Kubernetes is not configured, `syncctl` service 
will exit gracefully without affecting other services, but syncs (aka Connectors) won't be available

#### Setup using kubectl proxy (recommended - secure, no kubeconfig mounting):

 * Start kubectl proxy on host machine: `kubectl proxy --port=8001 --context my-context` (you could use any port)
 * Set environment variable to use proxy in `SYNCCTL_KUBERNETES_CLIENT_CONFIG=http://host.docker.internal:8001` 

Alse set `SYNCS_ENABLED` to true

**Note:** When using kubectl proxy, `SYNCCTL_KUBERNETES_CONTEXT` is not needed - the proxy uses your host's  current kubectl context.

#### Alternative - Direct cluster access (for remote clusters with service account):

You can use any k8s cluster to run syncs, just set following variables in `.env.local`

```bash
SYNCCTL_KUBERNETES_CLIENT_CONFIG=https://your-cluster-api:6443
SYNCCTL_KUBERNETES_CONTEXT=my-context
SYNCCTL_KUBERNETES_TOKEN=<your-service-account-token>
```

### Port Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PG_PORT` | `5438` | External PostgreSQL port |
| `MONGODB_PORT` | `27017` | External MongoDB port |
| `CLICKHOUSE_HTTP_PORT` | `8123` | ClickHouse HTTP port |
| `CLICKHOUSE_NATIVE_PORT` | `9000` | ClickHouse native protocol port |
| `REDPANDA_CONSOLE_PORT` | `11801` | Redpanda Console UI port |
| `PGWEB_PORT` | `11802` | PgWeb UI port |
| `MONGO_EXPRESS_PORT` | `11803` | Mongo Express UI port |
| `KEYCLOAK_PORT` | `11804` | Keycloak UI port |
| `CONSOLE_PORT` | `3000` | Jitsu Console port |
| `ROTOR_PORT` | `3401` | Rotor service port |
| `BULKER_PORT` | `3042` | Bulker service port |
| `INGEST_PORT` | `3049` | Ingest service port |
| `SYNCCTL_PORT` | `3043` | Syncctl service port |

## Usage Examples

### Start only dependencies (databases, message queue):
```bash
docker compose -f ./docker/docker-compose.yml --profile jitsu-dependencies up -d
```

### Stop all services:
```bash
docker compose -f ./docker/docker-compose.yml down
```

### View logs for a specific service:
```bash
docker compose -f ./docker/docker-compose.yml logs -f console
```

### Reset everything (including data):
```bash
docker compose -f ./docker/docker-compose.yml down -v
rm -rf ./docker/data/*
```

## Data Storage

All persistent data is stored in `./docker/data/` directory:
- `./docker/data/postgres` - PostgreSQL data
- `./docker/data/redpanda` - Redpanda/Kafka data
- `./docker/data/mongodb` - MongoDB data
- `./docker/data/clickhouse` - ClickHouse data
- `./docker/data/cloudbeaver` - CloudBeaver configuration (if used)

## Troubleshooting

### Services not starting
- Check Docker logs: `docker compose -f ./docker/docker-compose.yml logs`
- Ensure ports are not already in use
- Try rebuilding: `docker compose -f ./docker/docker-compose.yml build --no-cache`

### Database connection issues
- Wait for health checks to pass (can take up to 60 seconds on first start)
- Check if the database containers are running: `docker ps`

